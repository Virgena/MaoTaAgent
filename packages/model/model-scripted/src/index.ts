#!/usr/bin/env node
import { CallError, isPluginEntry, runPlugin, type Definition } from "@maota/plugin-kit";
import { MODEL_FAILURE, type AdapterChatRequest } from "@maota/model-protocol";

interface Step {
  text?: string;
  reasoning?: string;
  tool?: string;
  args?: unknown;
  fail?: { status?: number; body?: string; retry_after_ms?: number };
}

let script: Step[] = [];
let step = 0;

function pieces(text: string): string[] {
  if (text === "") return [];
  const size = Math.ceil(text.length / 3);
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

function failure(stepValue: Step): CallError {
  const status = stepValue.fail?.status ?? 503;
  if (status === 401 || status === 403) return new CallError(MODEL_FAILURE.auth, "scripted auth failure", { status });
  if (status === 429) {
    return new CallError(MODEL_FAILURE.rate_limit, "scripted rate limit", {
      status,
      ...(stepValue.fail?.retry_after_ms === undefined ? {} : { retry_after_ms: stepValue.fail.retry_after_ms }),
    });
  }
  return new CallError(MODEL_FAILURE.server, `scripted ${status}`, { status });
}

async function chat(_params: AdapterChatRequest, ctx: Parameters<NonNullable<Definition["methods"][string]>>[1]): Promise<void> {
  if (ctx.stream === undefined) throw new CallError(-32602, "scripted chat is streaming");
  const planned = script[step++];
  if (planned === undefined) {
    ctx.stream.push({ type: "message", message: { role: "assistant", content: "(the script ran out)" } });
    return;
  }
  if (planned.fail !== undefined) throw failure(planned);
  if (typeof planned.reasoning === "string" && planned.reasoning !== "") {
    ctx.stream.push({ type: "reasoning", text: planned.reasoning });
  }
  if (typeof planned.text === "string") {
    for (const piece of pieces(planned.text)) {
      ctx.stream.push({ type: "delta", text: piece });
      await new Promise((resolve) => setImmediate(resolve));
    }
    ctx.stream.push({ type: "message", message: { role: "assistant", content: planned.text } });
    return;
  }
  if (typeof planned.tool === "string") {
    ctx.stream.push({
      type: "message",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call_${step - 1}`, type: "function", function: { name: planned.tool, arguments: JSON.stringify(planned.args ?? {}) } }],
      },
    });
    return;
  }
  throw new CallError(-32602, "script step has neither text nor tool");
}

export const definition: Definition = {
  provides: ["model.adapter.scripted"],
  hostCalls: [],
  registrations: [{ service: "model", capability: "model.adapter.scripted" }],
  injects: [],
  configKeys: ["script"],
  setup(wiring) {
    script = Array.isArray(wiring.config.script) ? wiring.config.script as Step[] : [];
    step = 0;
  },
  methods: {
    describe() {
      return { id: "scripted", name: "Scripted (tests)" };
    },
    discover() {
      return [{ id: "smoke-chat", name: "Smoke Chat", capabilities: { tools: true, vision: false } }];
    },
    async chat(params, ctx) {
      await chat(params as AdapterChatRequest, ctx);
    },
  },
  selfCheck() {
    return script.length === 0 && step !== 0 ? ["scripted setup did not reset its step"] : [];
  },
};

if (isPluginEntry(import.meta.url)) runPlugin(definition);
