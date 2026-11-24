#!/usr/bin/env node
import { CallError, isPluginEntry, runPlugin, type Call, type Definition } from "@maota/plugin-kit";
import { MODEL_FAILURE, type AdapterChatRequest, type DiscoveredModel } from "@maota/model-protocol";
import { asOpenAITools, streamChat, upstreamError, transportError, type Gateway } from "./openai.ts";
import { streamResponses } from "./responses.ts";

function gateway(params: AdapterChatRequest): Gateway {
  return {
    base_url: params.provider.base_url,
    api_key: params.api_key,
    idle_timeout_ms: params.idle_timeout_ms ?? 120_000,
  };
}

async function discover(params: { base_url?: unknown; api_key?: unknown }): Promise<DiscoveredModel[]> {
  const base = typeof params.base_url === "string" ? params.base_url.trim().replace(/\/+$/, "") : "";
  const key = typeof params.api_key === "string" ? params.api_key.trim() : "";
  if (base === "") throw new CallError(-32602, "base_url is required");
  let response: Response;
  try {
    response = await fetch(`${base}/models`, {
      headers: { ...(key === "" ? {} : { authorization: `Bearer ${key}` }) },
      redirect: "error",
    });
  } catch (error) {
    throw transportError(error);
  }
  if (!response.ok) throw upstreamError(response.status, await response.text().catch(() => ""));
  const payload = await response.json().catch(() => null) as { data?: unknown } | null;
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((row): row is { id: string; name?: string } => row !== null && typeof row === "object" && typeof (row as { id?: unknown }).id === "string")
    .map((row) => ({ id: row.id, ...(typeof row.name === "string" && row.name !== "" ? { name: row.name } : {}) }));
}

async function chat(params: AdapterChatRequest, ctx: Call): Promise<void> {
  if (ctx.stream === undefined) throw new CallError(-32602, "model adapter chat is streaming");
  const reply = await streamChat(
    gateway(params),
    {
      model: params.model.model,
      reasoning: params.route.reasoning,
      messages: params.messages,
      tools: params.tools,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      session: params.session,
    },
    ctx.signal,
    (event) => {
      if (event.text !== undefined && event.text !== "") ctx.stream?.push({ type: "delta", text: event.text });
      if (event.reasoning !== undefined && event.reasoning !== "") ctx.stream?.push({ type: "reasoning", text: event.reasoning });
    },
  );
  ctx.stream.push({ type: "message", message: reply.message, ...(reply.usage === undefined ? {} : { usage: reply.usage }) });
}

export const definition: Definition = {
  provides: ["model.adapter.openai", "model.adapter.responses"],
  hostCalls: [],
  registrations: [
    { service: "model", capability: "model.adapter.openai" },
    { service: "model", capability: "model.adapter.responses" },
  ],
  injects: [],
  configKeys: [],
  methods: {
    describe(_params, ctx) {
      return ctx.capability === "model.adapter.responses"
        ? { id: "responses", name: "Responses", endpoint_hint: "https://api.openai.com/v1" }
        : { id: "openai", name: "Chat Completions", endpoint_hint: "https://api.example.com/v1" };
    },
    async discover(params) {
      return await discover(params ?? {});
    },
    async chat(params, ctx) {
      const request = params as AdapterChatRequest;
      if (ctx.capability === "model.adapter.responses") {
        if (ctx.stream === undefined) throw new CallError(-32602, "model adapter chat is streaming");
        const reply = await streamResponses(
          gateway(request),
          {
            model: request.model.model,
            reasoning: request.route.reasoning,
            messages: request.messages,
            tools: request.tools,
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            session: request.session,
          },
          ctx.signal,
          (event) => {
            if (event.text !== undefined && event.text !== "") ctx.stream?.push({ type: "delta", text: event.text });
            if (event.reasoning !== undefined && event.reasoning !== "") ctx.stream?.push({ type: "reasoning", text: event.reasoning });
          },
        );
        ctx.stream.push({ type: "message", message: reply.message, ...(reply.usage === undefined ? {} : { usage: reply.usage }) });
        return;
      }
      await chat(request, ctx);
    },
  },
  selfCheck() {
    const problems: string[] = [];
    const tools = asOpenAITools([{ name: "read", description: "read", input_schema: { type: "object" } }]);
    if (tools.length !== 1) problems.push("tool projection changed");
    if (upstreamError(401, "no").code !== MODEL_FAILURE.auth) problems.push("auth mapping changed");
    return problems;
  },
};

if (isPluginEntry(import.meta.url)) runPlugin(definition);
