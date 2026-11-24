#!/usr/bin/env node
import { CallError, isPluginEntry, runPlugin, type Call, type Definition } from "@maota/plugin-kit";
import {
  MODEL_FAILURE,
  type AdapterChatRequest,
  type DiscoveredModel,
  type Message,
  type ModelFailure,
  type ToolSpec,
} from "@maota/model-protocol";
import { IdleWatchdog } from "./idle.ts";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AnthropicFrame {
  event: string;
  data: unknown;
}

class SseFrames {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): AnthropicFrame[] {
    this.buffer += chunk;
    const out: AnthropicFrame[] = [];
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      const raw = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      this.line(raw, out);
    }
    return out;
  }

  end(): AnthropicFrame[] {
    const out: AnthropicFrame[] = [];
    if (this.buffer !== "") this.line(this.buffer.replace(/\r$/, ""), out);
    this.flush(out);
    return out;
  }

  private line(raw: string, out: AnthropicFrame[]): void {
    if (raw === "") return this.flush(out);
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    const value = colon < 0 ? "" : raw.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value;
    if (field === "data") this.data.push(value);
  }

  private flush(out: AnthropicFrame[]): void {
    if (this.data.length === 0) return;
    const text = this.data.join("\n");
    try {
      out.push({ event: this.event, data: JSON.parse(text) as unknown });
    } catch {
      throw new CallError(MODEL_FAILURE.parse, `Anthropic sent a chunk that is not JSON: ${text.slice(0, 200)}`);
    } finally {
      this.event = "";
      this.data = [];
    }
  }
}

function endpoint(base: string, path: string): string {
  const clean = base.trim().replace(/\/+$/, "");
  if (clean.endsWith("/v1/messages")) return clean;
  if (clean.endsWith("/v1")) return `${clean}${path}`;
  return `${clean}/v1${path}`;
}

function facts(response: Response, body: string): ModelFailure {
  const text = body.toLowerCase();
  const common = { status: response.status, message: body.slice(0, 500) || `Anthropic HTTP ${response.status}` };
  const retry = response.headers.get("retry-after");
  const retry_after_ms = retry !== null && Number(retry) > 0 ? Number(retry) * 1000 : undefined;
  const extra = { ...(retry_after_ms === undefined ? {} : { retry_after_ms }), request_id: response.headers.get("request-id") ?? undefined };
  if (response.status === 401 || response.status === 403) return { ...common, code: MODEL_FAILURE.auth, kind: "auth", ...extra };
  if (text.includes("context") || text.includes("too long") || text.includes("too many tokens")) {
    return { ...common, code: MODEL_FAILURE.context_window, kind: "context_window", ...extra };
  }
  if (response.status === 429) {
    return text.includes("quota") || text.includes("credit") || text.includes("balance")
      ? { ...common, code: MODEL_FAILURE.quota, kind: "quota", ...extra }
      : { ...common, code: MODEL_FAILURE.rate_limit, kind: "rate_limit", ...extra };
  }
  return { ...common, code: MODEL_FAILURE.server, kind: "server", ...extra };
}

function transport(error: unknown, timedOut = false): CallError {
  if (error instanceof CallError) return error;
  if (timedOut) return new CallError(MODEL_FAILURE.timeout, "Anthropic went quiet mid-stream");
  if (error instanceof Error && error.name === "AbortError") return new CallError(-32013, "cancelled");
  return new CallError(MODEL_FAILURE.transport, error instanceof Error ? error.message : String(error));
}

function textOf(message: Message): string {
  return typeof message.content === "string" ? message.content : "";
}

function toolCall(value: unknown): ToolCall | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
  if (typeof raw.id !== "string" || typeof raw.function?.name !== "string") return null;
  return {
    id: raw.id,
    type: "function",
    function: { name: raw.function.name, arguments: typeof raw.function.arguments === "string" ? raw.function.arguments : "{}" },
  };
}

function blocks(message: Message): unknown[] {
  const out: unknown[] = [];
  if (message.role === "tool") {
    return [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "tool", content: textOf(message) }];
  }
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    if (textOf(message) !== "") out.push({ type: "text", text: textOf(message) });
    for (const raw of message.tool_calls) {
      const call = toolCall(raw);
      if (call === null) continue;
      let input: unknown = {};
      try { input = JSON.parse(call.function.arguments); } catch {}
      out.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
  }
  if (out.length === 0) out.push({ type: "text", text: textOf(message) });
  return out;
}

function requestBody(params: AdapterChatRequest): Record<string, unknown> {
  const system = params.messages.filter((message) => message.role === "system").map(textOf).filter(Boolean).join("\n\n");
  const messages = params.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: blocks(message) }));
  const tools = (params.tools ?? []).map((tool: ToolSpec) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} },
  }));
  return {
    model: params.model.model,
    max_tokens: params.max_tokens ?? params.model.max_output_tokens ?? 4096,
    messages,
    ...(system === "" ? {} : { system }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.route.reasoning === undefined ? {} : { thinking: { type: "enabled", budget_tokens: reasoningBudget(params.route.reasoning) } }),
    stream: true,
  };
}

function reasoningBudget(level: string): number {
  const table: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, max: 32768 };
  return table[level] ?? 8192;
}

async function send(params: AdapterChatRequest, ctx: Call): Promise<Response> {
  const idle = new IdleWatchdog(params.idle_timeout_ms ?? 120_000);
  try {
    const response = await idle.guard(() => fetch(endpoint(params.provider.base_url, "/messages"), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([ctx.signal, idle.signal]),
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        ...(params.api_key === "" ? {} : { "x-api-key": params.api_key }),
      },
      body: JSON.stringify(requestBody(params)),
    }));
    return response;
  } catch (error) {
    idle.stop();
    throw transport(error, idle.timedOut);
  }
}

async function discover(params: { base_url?: unknown; api_key?: unknown }): Promise<DiscoveredModel[]> {
  const base = typeof params.base_url === "string" ? params.base_url : "";
  const key = typeof params.api_key === "string" ? params.api_key : "";
  if (base.trim() === "") throw new CallError(-32602, "base_url is required");
  let response: Response;
  try {
    response = await fetch(`${base.trim().replace(/\/+$/, "")}/v1/models?limit=100`, {
      headers: { "anthropic-version": "2023-06-01", ...(key === "" ? {} : { "x-api-key": key }) },
      redirect: "error",
    });
  } catch (error) {
    throw transport(error);
  }
  if (!response.ok) throw new CallError(facts(response, await response.text().catch(() => "")).code, "Anthropic model discovery failed");
  const payload = await response.json().catch(() => null) as { data?: unknown } | null;
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter((row): row is { id: string; display_name?: string } => row !== null && typeof row === "object" && typeof (row as { id?: unknown }).id === "string")
    .map((row) => ({ id: row.id, ...(typeof row.display_name === "string" ? { name: row.display_name } : {}) }));
}

async function chat(params: AdapterChatRequest, ctx: Call): Promise<void> {
  if (ctx.stream === undefined) throw new CallError(-32602, "model adapter chat is streaming");
  const response = await send(params, ctx);
  if (!response.ok) {
    const failure = facts(response, await response.text().catch(() => ""));
    throw new CallError(failure.code, failure.message, failure);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new CallError(MODEL_FAILURE.transport, "Anthropic returned no response body");
  const idle = new IdleWatchdog(params.idle_timeout_ms ?? 120_000);
  const decoder = new TextDecoder();
  const parser = new SseFrames();
  let content = "";
  const toolCalls: ToolCall[] = [];
  const active = new Map<number, { id: string; name: string; json: string }>();
  let done = false;
  try {
    for (;;) {
      const next = await idle.guard(() => reader.read());
      if (next.done) break;
      for (const frame of parser.push(decoder.decode(next.value, { stream: true }))) {
        done = apply(frame, ctx, active, toolCalls, (text) => { content += text; }, (text) => ctx.stream?.push({ type: "reasoning", text })) || done;
      }
      if (done) break;
    }
    if (!done) for (const frame of parser.end()) done = apply(frame, ctx, active, toolCalls, (text) => { content += text; }, (text) => ctx.stream?.push({ type: "reasoning", text })) || done;
  } catch (error) {
    throw transport(error, idle.timedOut);
  } finally {
    idle.stop();
  }
  if (!done) throw new CallError(MODEL_FAILURE.transport, "Anthropic stream ended before message_stop");
  if (content === "" && toolCalls.length === 0) throw new CallError(MODEL_FAILURE.empty, "Anthropic returned no content");
  ctx.stream.push({ type: "message", message: { role: "assistant", content: content === "" ? null : content, ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) } });
}

function apply(
  frame: AnthropicFrame,
  ctx: Call,
  active: Map<number, { id: string; name: string; json: string }>,
  toolCalls: ToolCall[],
  addText: (text: string) => void,
  addReasoning: (text: string) => void,
): boolean {
  const data = frame.data as Record<string, unknown>;
  const index = typeof data.index === "number" ? data.index : -1;
  if (frame.event === "content_block_start") {
    const block = data.content_block as { type?: unknown; id?: unknown; name?: unknown } | undefined;
    if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      active.set(index, { id: block.id, name: block.name, json: "" });
    }
  } else if (frame.event === "content_block_delta") {
    const delta = data.delta as { type?: unknown; text?: unknown; thinking?: unknown; partial_json?: unknown } | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      addText(delta.text);
      ctx.stream?.push({ type: "delta", text: delta.text });
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") addReasoning(delta.thinking);
    if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const block = active.get(index);
      if (block !== undefined) block.json += delta.partial_json;
    }
  } else if (frame.event === "content_block_stop") {
    const block = active.get(index);
    if (block !== undefined) {
      toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.json || "{}" } });
      active.delete(index);
    }
  } else if (frame.event === "message_stop") {
    return true;
  } else if (frame.event === "error") {
    const error = data.error as { message?: unknown; type?: unknown } | undefined;
    throw new CallError(MODEL_FAILURE.server, typeof error?.message === "string" ? error.message : "Anthropic stream error");
  }
  return false;
}

export const definition: Definition = {
  provides: ["model.adapter.anthropic"],
  hostCalls: [],
  registrations: [{ service: "model", capability: "model.adapter.anthropic" }],
  injects: [],
  configKeys: [],
  methods: {
    describe() {
      return { id: "anthropic", name: "Messages", endpoint_hint: "https://api.anthropic.com" };
    },
    async discover(params) {
      return await discover(params ?? {});
    },
    async chat(params, ctx) {
      await chat(params as AdapterChatRequest, ctx);
    },
  },
  selfCheck() {
    const problems: string[] = [];
    if (!endpoint("https://api.anthropic.com", "/messages").endsWith("/v1/messages")) problems.push("endpoint projection is wrong");
    if (reasoningBudget("high") <= reasoningBudget("low")) problems.push("reasoning budget order is wrong");
    return problems;
  },
};

if (isPluginEntry(import.meta.url)) runPlugin(definition);
