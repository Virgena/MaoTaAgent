/// The conversation a run is given and the durable record it leaves behind. A
/// compaction archives folded messages, appends one record, and replaces only
/// the model-facing messages.

import { randomUUID } from "node:crypto";
import type { Call } from "@maota/plugin-kit";
import type { ModelRoute } from "@maota/model-protocol";
import { asText, type Message, type ToolSpec } from "@maota/agent-loop";
import {
  DEFAULT_TAIL_CHARS,
  SUMMARY_MAX_TOKENS,
  compactMessage,
  foldCount,
  foldRequest,
  requestChars,
  type CompactTrigger,
} from "./compact.ts";
import { active, budgetFor, settings } from "./levels.ts";
import { listTools } from "./prompt.ts";
import type { SubagentOrigin } from "./subagent.ts";

export const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const activeCompactions = new Map<string, CompactTrigger>();

export interface ArtifactRef {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface CompactionRecord {
  id: string;
  at: string;
  trigger: CompactTrigger;
  kind: "prune" | "summary";
  status: "committed" | "failed";
  folded: number;
  chars_before: number;
  chars_after: number;
  artifacts: ArtifactRef[];
  error?: string;
}

export interface CompactOutcome {
  status: "none" | "pruned" | "summarized" | "failed";
  record?: CompactionRecord;
  chars_before: number;
  chars_after: number;
}

export function titleOf(text: unknown): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const all = [...segmenter.segment(flat)].map((piece) => piece.segment);
  return all.length > 30 ? `${all.slice(0, 30).join("")}…` : flat;
}

export async function loadHistory(ctx: Call, sessionId: string, cwd: string | null): Promise<Message[]> {
  const reply = (await ctx.channel.call(
    "session",
    "load",
    { id: sessionId, cwd: cwd ?? "" },
    { signal: ctx.signal },
  )) as { messages?: Message[] };
  return Array.isArray(reply?.messages) ? reply.messages.map(modelMessage) : [];
}

function modelMessage(message: Message): Message {
  return {
    role: message.role,
    ...(message.content === undefined ? {} : { content: message.content }),
    ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.source === undefined ? {} : { source: message.source }),
  };
}

function previewOf(content: string, artifact: ArtifactRef): string {
  const head = content.slice(0, 4000);
  const tail = content.slice(-1000);
  return [
    "<persisted-output>",
    `Full output: ${artifact.path}`,
    `Bytes: ${artifact.bytes}`,
    `SHA-256: ${artifact.sha256}`,
    "Preview:",
    head,
    content.length > 5000 ? "\n...[middle omitted; read the file for the full output]...\n" : "",
    content.length > 5000 ? tail : "",
    "</persisted-output>",
  ].join("\n");
}

async function saveArtifact(
  ctx: Call,
  sessionId: string,
  cwd: string | null,
  content: string,
): Promise<ArtifactRef> {
  return (await ctx.channel.call(
    "session",
    "save_artifact",
    { id: sessionId, cwd: cwd ?? "", name: `tool-${randomUUID()}`, content },
    { signal: ctx.signal },
  )) as ArtifactRef;
}

export async function fitToolResult(
  ctx: Call,
  sessionId: string,
  cwd: string | null,
  messages: readonly Message[],
  tools: readonly ToolSpec[],
  model: string | undefined,
  output: unknown,
): Promise<unknown> {
  if (!settings.context_compact) return output;
  const content = asText(output);
  if (content.length < 200) return output;
  const budget = budgetFor(model);
  if (requestChars(messages, tools) + content.length <= budget.compact_after_chars) return output;
  try {
    return previewOf(content, await saveArtifact(ctx, sessionId, cwd, content));
  } catch (error) {
    ctx.channel.log("warn", "agent: a tool result could not be archived", {
      error: error instanceof Error ? error.message : String(error),
    });
    return output;
  }
}

interface PruneResult {
  messages: Message[];
  artifacts: ArtifactRef[];
}

async function pruneToolResults(
  ctx: Call,
  sessionId: string,
  cwd: string | null,
  messages: readonly Message[],
  tools: readonly ToolSpec[],
  targetChars: number,
): Promise<PruneResult> {
  const next = [...messages];
  const indices = next
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role === "tool" && typeof entry.message.content === "string");
  const recent = new Set(indices.slice(-3).map((entry) => entry.index));
  const rank = [...indices].sort((left, right) => {
    const recentOrder = Number(recent.has(left.index)) - Number(recent.has(right.index));
    if (recentOrder !== 0) return recentOrder;
    return asText(right.message.content).length - asText(left.message.content).length;
  });
  const artifacts: ArtifactRef[] = [];
  for (const entry of rank) {
    if (requestChars(next, tools) <= targetChars) break;
    const content = entry.message.content;
    if (typeof content !== "string" || content.length < 200) continue;
    try {
      const artifact = await saveArtifact(ctx, sessionId, cwd, content);
      artifacts.push(artifact);
      next[entry.index] = { ...entry.message, content: previewOf(content, artifact) };
    } catch (error) {
      ctx.channel.log("warn", "agent: an old tool result could not be archived", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { messages: next, artifacts };
}

function record(
  trigger: CompactTrigger,
  kind: "prune" | "summary",
  status: "committed" | "failed",
  folded: number,
  before: number,
  after: number,
  artifacts: ArtifactRef[] = [],
  error?: string,
): CompactionRecord {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    trigger,
    kind,
    status,
    folded,
    chars_before: before,
    chars_after: after,
    artifacts,
    ...(error === undefined ? {} : { error }),
  };
}

async function commit(
  ctx: Call,
  sessionId: string,
  cwd: string | null,
  messages: readonly Message[],
  value: CompactionRecord,
  archive?: readonly Message[],
): Promise<void> {
  await ctx.channel.call(
    "session",
    "commit_compaction",
    {
      id: sessionId,
      cwd: cwd ?? "",
      messages,
      record: value,
      ...(archive === undefined ? {} : { archive: { messages: archive } }),
    },
    { signal: ctx.signal },
  );
}

export interface CompactOptions {
  sessionId: string;
  cwd: string | null;
  messages: Message[];
  tools: readonly ToolSpec[];
  model: string | undefined;
  route?: ModelRoute;
  trigger: CompactTrigger;
  force?: boolean;
  beforeCompact?: (folded: number) => Promise<void>;
  flush?: () => void;
}

export async function compactMessages(ctx: Call, options: CompactOptions): Promise<CompactOutcome> {
  const { sessionId, cwd, messages, tools, model, trigger } = options;
  const budget = budgetFor(model);
  const before = requestChars(messages, tools);
  if (!settings.context_compact && trigger !== "manual") {
    return { status: "none", chars_before: before, chars_after: before };
  }
  if (!options.force && trigger === "pressure" && before <= budget.compact_after_chars) {
    return { status: "none", chars_before: before, chars_after: before };
  }

  const target = Math.max(1, Math.floor(budget.compact_after_chars * 0.8));
  const pruned = await pruneToolResults(ctx, sessionId, cwd, messages, tools, target);
  const prunedChars = requestChars(pruned.messages, tools);
  const announce = (topic: string, status: string, value?: CompactionRecord): void => {
    void ctx.channel.publish(topic, {
      session_id: sessionId,
      cwd,
      trigger,
      status,
      folded: value?.folded ?? 0,
      chars_before: before,
      chars_after: value?.chars_after ?? prunedChars,
      ...(value?.error === undefined ? {} : { error: value.error }),
    }).catch(() => undefined);
  };
  announce("agent.compact.started", "started");
  let pruneRecord: CompactionRecord | undefined;
  if (pruned.artifacts.length > 0) {
    pruneRecord = record(trigger, "prune", "committed", 0, before, prunedChars, pruned.artifacts);
    await commit(ctx, sessionId, cwd, pruned.messages, pruneRecord);
    messages.splice(0, messages.length, ...pruned.messages);
  }
  if (trigger === "pressure" && prunedChars <= target) {
    announce("agent.compact.committed", pruneRecord === undefined ? "none" : "pruned", pruneRecord);
    return {
      status: pruneRecord === undefined ? "none" : "pruned",
      ...(pruneRecord === undefined ? {} : { record: pruneRecord }),
      chars_before: before,
      chars_after: prunedChars,
    };
  }

  const head = messages[0]?.role === "system" ? 1 : 0;
  const body = messages.slice(head);
  const tailChars = options.force
    ? Math.max(1, Math.floor(requestChars(body, []) / 4))
    : Math.min(DEFAULT_TAIL_CHARS, Math.max(1, Math.floor(budget.compact_after_chars * 0.2)));
  const folded = foldCount(body, Math.max(1, settings.compact_keep_messages), tailChars);
  if (folded < 2) {
    if (trigger === "manual") {
      announce("agent.compact.committed", pruneRecord === undefined ? "noop" : "pruned", pruneRecord);
      return {
        status: pruneRecord === undefined ? "none" : "pruned",
        ...(pruneRecord === undefined ? {} : { record: pruneRecord }),
        chars_before: before,
        chars_after: prunedChars,
      };
    }

    const detail = "no compactable message prefix remains";
    const failed = record(trigger, "summary", "failed", 0, prunedChars, prunedChars, [], detail);
    try {
      await commit(ctx, sessionId, cwd, messages, failed);
    } catch (commitError) {
      ctx.channel.log("warn", "agent: the failed compaction could not be recorded", {
        error: commitError instanceof Error ? commitError.message : String(commitError),
      });
    }
    announce("agent.compact.failed", "failed", failed);
    return { status: "failed", record: failed, chars_before: before, chars_after: prunedChars };
  }

  if (options.beforeCompact !== undefined) await options.beforeCompact(folded);
  options.flush?.();
  const foldedMessages = body.slice(0, folded);
  const id = randomUUID();
  let summary: string;
  try {
    if (options.route === undefined) throw new Error("compaction has no model route");
    const reply = (await ctx.channel.call(
      "model",
      "complete",
      { route: options.route, messages: foldRequest(foldedMessages), max_tokens: SUMMARY_MAX_TOKENS },
      { signal: ctx.signal },
    )) as { message?: { content?: unknown } } | null;
    const content = reply?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new Error("the summarizer returned no text");
    summary = content.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.channel.log("warn", "agent: the history could not be compacted", { error: detail });
    const failed = record(trigger, "summary", "failed", folded, prunedChars, prunedChars, [], detail);
    try {
      await commit(ctx, sessionId, cwd, messages, failed);
    } catch (commitError) {
      ctx.channel.log("warn", "agent: the failed compaction could not be recorded", {
        error: commitError instanceof Error ? commitError.message : String(commitError),
      });
    }
    announce("agent.compact.failed", "failed", failed);
    return { status: "failed", record: failed, chars_before: before, chars_after: prunedChars };
  }

  const next = [
    ...messages.slice(0, head),
    compactMessage(summary, folded, id, trigger),
    ...body.slice(folded),
  ];
  const after = requestChars(next, tools);
  const value: CompactionRecord = {
    ...record(trigger, "summary", "committed", folded, prunedChars, after),
    id,
  };
  await commit(ctx, sessionId, cwd, next, value, foldedMessages);
  messages.splice(0, messages.length, ...next);
  announce("agent.compact.committed", "summarized", value);
  return { status: "summarized", record: value, chars_before: before, chars_after: after };
}

export interface ContextView {
  estimated_chars: number;
  threshold_chars: number;
  ratio: number;
  active: boolean;
  compactions: unknown[];
}

export async function contextOf(
  ctx: Call,
  sessionId: string,
  cwd: string | null,
  model: string | undefined,
): Promise<ContextView> {
  const reply = (await ctx.channel.call(
    "session",
    "load",
    { id: sessionId, cwd: cwd ?? "" },
    { signal: ctx.signal },
  )) as { messages?: Message[]; compactions?: unknown[] } | null;
  const messages = Array.isArray(reply?.messages) ? reply.messages : [];
  const tools = await listTools(ctx);
  const budget = budgetFor(model);
  const estimated = requestChars(messages, tools);
  return {
    estimated_chars: estimated,
    threshold_chars: budget.compact_after_chars,
    ratio: budget.compact_after_chars === 0 ? 0 : estimated / budget.compact_after_chars,
    active: activeCompactions.has(sessionId) || active.has(sessionId),
    compactions: Array.isArray(reply?.compactions) ? reply.compactions.slice(-20) : [],
  };
}

export async function compactSession(
  ctx: Call,
  params?: { session_id?: unknown; cwd?: unknown; model?: unknown },
): Promise<Record<string, unknown>> {
  const input = params ?? {};
  const sessionId = typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : "default";
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : null;
  const model = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
  const resolved = await ctx.channel.call(
    "model",
    "resolve",
    model === undefined ? {} : { model },
    { signal: ctx.signal },
  ) as { route: ModelRoute };
  if (activeCompactions.has(sessionId) || active.has(sessionId)) return { status: "busy", session_id: sessionId };
  const loaded = (await ctx.channel.call(
    "session",
    "load",
    { id: sessionId, cwd: cwd ?? "" },
    { signal: ctx.signal },
  )) as { messages?: Message[] } | null;
  const messages = Array.isArray(loaded?.messages) ? loaded.messages : [];
  const tools = await listTools(ctx);
  activeCompactions.set(sessionId, "manual");
  try {
    const outcome = await compactMessages(ctx, {
      sessionId,
      cwd,
      messages,
      tools,
      model: `${resolved.route.provider}/${resolved.route.model}`,
      route: resolved.route,
      trigger: "manual",
      force: true,
    });
    const payload = {
      session_id: sessionId,
      cwd,
      trigger: "manual",
      status: outcome.status,
      folded: outcome.record?.folded ?? 0,
      chars_before: outcome.chars_before,
      chars_after: outcome.chars_after,
      ...(outcome.record?.error === undefined ? {} : { error: outcome.record.error }),
    };
    return payload;
  } finally {
    activeCompactions.delete(sessionId);
  }
}

export async function persist(
  ctx: Call,
  sessionId: string,
  cwd: string | null,
  messages: readonly Message[],
  title: string,
  parent: SubagentOrigin | null,
  route: ModelRoute | null,
  thinking: string,
  trace?: PersistTrace,
): Promise<void> {
  const lastAssistant = messages.findLastIndex((item) => item.role === "assistant");
  const traced = trace === undefined || lastAssistant <= trace.after ? messages : messages.map((message, index) =>
    index === lastAssistant
      ? {
          ...message,
          ...(trace.reasoning === "" ? {} : { reasoning: trace.reasoning }),
          ...(trace.reasoning_ms === 0 ? {} : { reasoning_ms: trace.reasoning_ms }),
          ...(trace.steps === 0 ? {} : { steps: trace.steps }),
        }
      : message
  );
  await ctx.channel.call(
    "session",
    "save",
    {
      id: sessionId,
      cwd: cwd ?? "",
      title,
      messages: traced,
      model_route: route,
      thinking,
      ...(parent === null
        ? {}
        : {
            parent: {
              id: parent.parent_session_id,
              cwd: cwd ?? "",
              call_id: parent.parent_call_id ?? "",
              type: parent.type,
              description: parent.description,
            },
          }),
    },
    { signal: ctx.signal },
  );
}

export interface PersistTrace {
  reasoning: string;
  reasoning_ms: number;
  steps: number;
  after: number;
}

