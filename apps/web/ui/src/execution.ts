import type { SessionMessage } from "./lib/rpc.ts";

export interface LiveTool {
  tool: string;
  id: string;
  args?: unknown;
  ok?: boolean;
  output?: unknown;
  startedAt?: number;
  endedAt?: number;
}

export type SubagentStatus = "running" | "done" | "partial" | "failed";

export interface LiveSubagent {
  id: string;
  call_id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  steps: number;
  tools: LiveTool[];
}

export interface LiveTurn {
  turn_id: string;
  text: string;
  reasoning: string;
  reasoningMs: number;
  reasoningStartedAt?: number;
  step: number;
  mark: { text: number; reasoning: number };
  tools: LiveTool[];
  subagents: LiveSubagent[];
  running: boolean;
  startedAt: number;
}

export type ToolKind =
  | "read"
  | "edit"
  | "write"
  | "search"
  | "skill"
  | "command"
  | "delegate"
  | "other";

export interface TraceGroup {
  kind: "group";
  id: string;
  tools: LiveTool[];
}

export interface TraceToolEntry {
  kind: "tool";
  tool: LiveTool;
}

export type TraceEntry = TraceGroup | TraceToolEntry;

export interface TranscriptMessage {
  kind: "message";
  key: string;
  message: SessionMessage;
}

export interface TranscriptAssistant {
  kind: "assistant";
  key: string;
  text: string;
}

export interface TranscriptExecution {
  kind: "execution";
  key: string;
  tools: LiveTool[];
  text: string;
  reasoning: string;
  reasoningMs: number;
  steps: number;
}

export type TranscriptBlock = TranscriptMessage | TranscriptAssistant | TranscriptExecution;

function recordOf(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function toolKind(name: string): ToolKind {
  switch (name.toLowerCase()) {
    case "read":
    case "readcoalesced":
      return "read";
    case "edit":
      return "edit";
    case "write":
      return "write";
    case "glob":
    case "grep":
    case "search":
    case "list":
      return "search";
    case "skill":
      return "skill";
    case "pwsh":
    case "powershell":
    case "bash":
    case "shell":
      return "command";
    case "task":
      return "delegate";
    default:
      return "other";
  }
}

export function toolTarget(name: string, raw: unknown): string {
  const args = recordOf(raw);
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
      if (Array.isArray(value)) {
        const names = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
        if (names.length > 0) return names.join(", ");
      }
    }
    return "";
  };
  const kind = toolKind(name);
  if (kind === "read" || kind === "edit" || kind === "write") {
    return pick("file_path", "path", "file", "filename");
  }
  if (kind === "search") return pick("pattern", "query", "path", "glob");
  if (kind === "skill") return pick("name", "names");
  if (kind === "command") return pick("command", "input");
  if (kind === "delegate") return pick("description", "prompt", "name");
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

export function isExplorationTool(tool: LiveTool): boolean {
  const kind = toolKind(tool.tool);
  return tool.ok === true && (kind === "read" || kind === "search");
}

export function groupTraceTools(tools: LiveTool[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  let run: LiveTool[] = [];
  const flush = (): void => {
    if (run.length > 1) {
      entries.push({ kind: "group", id: `group-${run[0]?.id ?? entries.length}`, tools: run });
    } else {
      for (const tool of run) entries.push({ kind: "tool", tool });
    }
    run = [];
  };
  for (const tool of tools) {
    if (isExplorationTool(tool)) {
      run.push(tool);
      continue;
    }
    flush();
    entries.push({ kind: "tool", tool });
  }
  flush();
  return entries;
}

export function toolStatus(tool: LiveTool): "running" | "done" | "failed" {
  if (tool.ok === undefined) return "running";
  return tool.ok ? "done" : "failed";
}

export function toolElapsed(tool: LiveTool, now = Date.now()): number | undefined {
  if (tool.startedAt === undefined) return undefined;
  return Math.max(0, (tool.endedAt ?? now) - tool.startedAt);
}

export function reasoningElapsed(turn: Pick<LiveTurn, "reasoningMs" | "reasoningStartedAt">, now = Date.now()): number {
  return turn.reasoningMs + (turn.reasoningStartedAt === undefined ? 0 : Math.max(0, now - turn.reasoningStartedAt));
}

function toolFromCall(call: { id?: string; function?: { name?: string; arguments?: string } }, key: string): LiveTool {
  return {
    id: call.id ?? key,
    tool: call.function?.name ?? "tool",
    args: parseArgs(call.function?.arguments),
  };
}

function resultOf(message: SessionMessage): { ok: boolean; output: unknown } {
  const raw = String(message.content ?? "");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
      return { ok: false, output: parsed };
    }
    return { ok: true, output: parsed };
  } catch {
    return { ok: true, output: raw };
  }
}

export function transcriptBlocks(messages: SessionMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let pending: SessionMessage[] = [];
  let pendingStart = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const tools: LiveTool[] = [];
    const byId = new Map<string, LiveTool>();
    for (let index = 0; index < pending.length; index++) {
      const message = pending[index]!;
      if (message.role === "assistant") {
        for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
          const tool = toolFromCall(call, `history-${pendingStart}-${index}-${callIndex}`);
          tools.push(tool);
          byId.set(tool.id, tool);
        }
      }
    }
    for (let index = 0; index < pending.length; index++) {
      const message = pending[index]!;
      if (message.role !== "tool") continue;
      const id = message.tool_call_id ?? `history-tool-${pendingStart}-${index}`;
      let tool = byId.get(id);
      if (tool === undefined) {
        tool = { id, tool: message.name ?? "tool" };
        tools.push(tool);
        byId.set(id, tool);
      }
      const result = resultOf(message);
      tool.ok = result.ok;
      tool.output = result.output;
    }
    const assistant = pending.filter((message) => message.role === "assistant");
    const text = assistant
      .map((message) => String(message.content ?? "").trim())
      .filter((value) => value !== "")
      .join("\n\n");
    const reasoning = assistant
      .map((message) => message.reasoning ?? "")
      .filter((value) => value !== "")
      .join("\n\n");
    const reasoningMs = Math.max(0, ...assistant.map((message) => message.reasoning_ms ?? 0));
    const steps = Math.max(0, ...assistant.map((message) => message.steps ?? 0));
    const key = `history-${pendingStart}`;
    if (tools.length > 0 || reasoning !== "" || steps > 0) {
      blocks.push({ kind: "execution", key, tools, text, reasoning, reasoningMs, steps });
    }
    else if (text !== "") blocks.push({ kind: "assistant", key, text });
    pending = [];
  };

  messages.forEach((message, index) => {
    if (message.source?.kind === "skill-catalog") {
      flush();
      return;
    }
    if (message.role === "user" || message.source !== undefined) {
      flush();
      blocks.push({ kind: "message", key: `message-${index}`, message });
      return;
    }
    if (pending.length === 0) pendingStart = index;
    pending.push(message);
  });
  flush();
  return blocks;
}
