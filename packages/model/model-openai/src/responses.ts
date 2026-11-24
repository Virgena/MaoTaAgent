import { CallError } from "@maota/plugin-kit";
import { MODEL_FAILURE } from "@maota/model-protocol";
import { IdleWatchdog } from "./idle.ts";
import type { ChatReply, ChatRequest, Message } from "./messages.ts";
import { gatewayFacts, transportError, upstreamError, type Gateway } from "./openai.ts";
import { SseParser } from "./sse.ts";

interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

function text(message: Message): string {
  return typeof message.content === "string" ? message.content : "";
}

function inputItems(messages: Message[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? message.name ?? "tool",
        output: text(message),
      });
      continue;
    }
    if (message.role === "assistant") {
      if (text(message) !== "") items.push({ role: "assistant", content: text(message) });
      for (const raw of message.tool_calls ?? []) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        if (typeof call.id !== "string" || typeof call.function?.name !== "string") continue;
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
        });
      }
      continue;
    }
    items.push({ role: message.role, content: text(message) });
  }
  return items;
}

function tools(values: readonly unknown[] | undefined): unknown[] | undefined {
  if (values === undefined) return undefined;
  return values.map((value) => {
    const tool = value as { name?: unknown; description?: unknown; parameters?: unknown; input_schema?: unknown };
    return {
      type: "function",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
    };
  });
}

function body(request: ChatRequest): string {
  const instructions = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map(text)
    .filter(Boolean)
    .join("\n\n");
  const projectedTools = tools(request.tools);
  return JSON.stringify({
    model: request.model,
    input: inputItems(request.messages),
    ...(instructions === "" ? {} : { instructions }),
    ...(projectedTools === undefined || projectedTools.length === 0 ? {} : { tools: projectedTools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.max_tokens === undefined ? {} : { max_output_tokens: request.max_tokens }),
    ...(request.reasoning === undefined ? {} : { reasoning: { effort: request.reasoning } }),
    stream: true,
  });
}

async function send(
  gateway: Gateway,
  request: ChatRequest,
  signal: AbortSignal | undefined,
): Promise<{ response: Response; idle: IdleWatchdog }> {
  const idle = new IdleWatchdog(gateway.idle_timeout_ms);
  try {
    const response = await idle.guard(() => fetch(`${gateway.base_url.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${gateway.api_key}`,
      },
      body: body(request),
      signal: signal === undefined ? idle.signal : AbortSignal.any([signal, idle.signal]),
    }));
    return { response, idle };
  } catch (error) {
    idle.stop();
    throw transportError(error, idle.timedOut);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function recordCall(target: Map<string, FunctionCall>, key: string, raw: unknown): void {
  const item = object(raw);
  if (item?.type !== "function_call") return;
  const current = target.get(key) ?? { call_id: "", name: "", arguments: "" };
  const call_id = textOf(item.call_id);
  const name = textOf(item.name);
  const argumentsValue = textOf(item.arguments);
  target.set(key, {
    call_id: call_id === undefined || call_id === "" ? current.call_id : call_id,
    name: name === undefined || name === "" ? current.name : name,
    arguments: argumentsValue === undefined ? current.arguments : argumentsValue,
  });
}

export async function streamResponses(
  gateway: Gateway,
  request: ChatRequest,
  signal: AbortSignal | undefined,
  emit: (event: { text?: string; reasoning?: string }) => void,
): Promise<ChatReply> {
  const { response, idle } = await send(gateway, request, signal);
  if (!response.ok) {
    idle.stop();
    throw upstreamError(response.status, await response.text().catch(() => ""), gatewayFacts(response));
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    idle.stop();
    throw new CallError(MODEL_FAILURE.transport, "the responses gateway answered with no body to stream");
  }

  const decoder = new TextDecoder();
  const parser = new SseParser();
  const calls = new Map<string, FunctionCall>();
  let content = "";
  let usage: unknown;
  let done = false;

  const take = (payload: string): void => {
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new CallError(MODEL_FAILURE.parse, `the responses gateway sent a chunk that is not JSON: ${payload.slice(0, 200)}`);
    }
    const type = textOf(frame.type) ?? "";
    if (type === "response.output_text.delta") {
      const delta = textOf(frame.delta) ?? "";
      content += delta;
      if (delta !== "") emit({ text: delta });
      return;
    }
    if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
      const delta = textOf(frame.delta) ?? "";
      if (delta !== "") emit({ reasoning: delta });
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = object(frame.item);
      const key = textOf(item?.id) ?? String(frame.output_index ?? "");
      recordCall(calls, key, item);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const key = textOf(frame.item_id) ?? String(frame.output_index ?? "");
      const current = calls.get(key) ?? { call_id: "", name: "", arguments: "" };
      current.arguments += textOf(frame.delta) ?? "";
      calls.set(key, current);
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const completed = object(frame.response);
      usage = completed?.usage;
      for (const [index, item] of (Array.isArray(completed?.output) ? completed.output : []).entries()) {
        recordCall(calls, textOf(object(item)?.id) ?? String(index), item);
      }
      done = true;
      return;
    }
    if (type === "response.failed" || type === "error") {
      const failure = object(frame.response)?.error ?? frame.error;
      const detail = object(failure);
      throw new CallError(MODEL_FAILURE.server, textOf(detail?.message) ?? payload.slice(0, 500));
    }
  };

  try {
    for (;;) {
      const next = await idle.guard(() => reader.read());
      if (next.done) break;
      for (const payload of parser.push(decoder.decode(next.value, { stream: true }))) take(payload);
      if (done) break;
    }
    if (!done) for (const payload of parser.end()) take(payload);
  } catch (error) {
    throw transportError(error, idle.timedOut);
  } finally {
    idle.stop();
  }
  if (!done) throw new CallError(MODEL_FAILURE.transport, "the responses stream ended before response.completed");

  const toolCalls = [...calls.values()]
    .filter((call) => call.name !== "" || call.call_id !== "")
    .map((call) => ({
      id: call.call_id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  if (content === "" && toolCalls.length === 0) {
    throw new CallError(MODEL_FAILURE.empty, "the responses gateway finished without any content");
  }
  return {
    message: {
      role: "assistant",
      content: content === "" ? null : content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    },
    usage,
  };
}
