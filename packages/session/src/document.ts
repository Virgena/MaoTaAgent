/// Where a session document lives and how it is read back safely: the path a
/// session id maps to, the whitelisted shapes a stored document may hold, and
/// the quarantine a document this build cannot read is moved to before a write
/// can land on top of it.

import { readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CallError } from "@maota/plugin-kit";

import { eventsOf, type SessionEvent } from "./plan.ts";
import { compactSourceOf, compactionsOf, type CompactionRecord, type CompactSource } from "./compaction.ts";

export const SCHEMA_VERSION = 7;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_DIRNAME = "default";

/// A message the harness wrote for the model rather than a person typed: the
/// skill catalog is the only one today, and it is durable so a later turn can
/// tell whether the catalog it would send still matches the one in history.
export interface SkillCatalogSource {
  kind: "skill-catalog";
  update?: boolean;
  entries: Array<{ name: string; description: string }>;
}

export interface SystemMessageSource {
  kind: "job" | "schedule";
  id: string;
  occurrence?: string;
  mode?: string;
  title?: string;
}

export type MessageSource = SkillCatalogSource | CompactSource | SystemMessageSource;

export interface SessionMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  source?: MessageSource;
  reasoning?: string;
  reasoning_ms?: number;
  steps?: number;
}

/// The durable format is a whitelist: a field this build does not know is not
/// written back, and a source it cannot read is either refused (a write) or
/// dropped (a read), so a hand-edited document cannot smuggle a shape into the
/// rest of the deployment.
export function messageSource(value: unknown): MessageSource | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "compact") return compactSourceOf(value, false);
  if (input.kind === "job" || input.kind === "schedule") {
    if (typeof input.id !== "string" || input.id === "") return null;
    const source: SystemMessageSource = { kind: input.kind, id: input.id };
    if (typeof input.occurrence === "string") source.occurrence = input.occurrence;
    if (typeof input.mode === "string") source.mode = input.mode;
    if (typeof input.title === "string") source.title = input.title;
    return source;
  }
  if (input.kind !== "skill-catalog") return null;
  if (input.update !== undefined && typeof input.update !== "boolean") return null;
  if (!Array.isArray(input.entries)) return null;
  const entries: Array<{ name: string; description: string }> = [];
  for (const raw of input.entries) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as { name?: unknown; description?: unknown };
    if (typeof entry.name !== "string" || typeof entry.description !== "string") return null;
    entries.push({ name: entry.name, description: entry.description });
  }
  return {
    kind: "skill-catalog",
    ...(input.update === undefined ? {} : { update: input.update }),
    entries,
  };
}
function projectMessage(raw: unknown, strict: boolean): SessionMessage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.role !== "string" || input.role === "") return null;
  const source = messageSource(input.source);
  if (source === null && input.source !== undefined && strict) {
    throw new CallError(-32602, `message source ${JSON.stringify(input.source)} is not one this build knows`);
  }
  const message: SessionMessage = { role: input.role };
  if (typeof input.content === "string" || input.content === null) message.content = input.content;
  if (Array.isArray(input.tool_calls)) message.tool_calls = input.tool_calls;
  if (typeof input.tool_call_id === "string") message.tool_call_id = input.tool_call_id;
  if (typeof input.name === "string") message.name = input.name;
  if (typeof input.reasoning === "string" && input.reasoning !== "") message.reasoning = input.reasoning;
  if (typeof input.reasoning_ms === "number" && Number.isFinite(input.reasoning_ms) && input.reasoning_ms >= 0) {
    message.reasoning_ms = Math.floor(input.reasoning_ms);
  }
  if (typeof input.steps === "number" && Number.isInteger(input.steps) && input.steps > 0) {
    message.steps = input.steps;
  }
  if (source !== null) message.source = source;
  return message;
}

export function projectMessages(value: unknown, strict: boolean): SessionMessage[] {
  if (!Array.isArray(value)) return [];
  const out: SessionMessage[] = [];
  for (const raw of value) {
    const message = projectMessage(raw, strict);
    if (message !== null) out.push(message);
  }
  return out;
}

export interface SessionModelRoute {
  provider: string;
  model: string;
  reasoning?: string;
}

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function thinkingOf(value: unknown): ThinkingLevel | null {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? value as ThinkingLevel
    : null;
}

export interface SessionFile {
  schema_version: number;
  id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: SessionMessage[];
  events: SessionEvent[];
  compactions: CompactionRecord[];
  parent: SessionParent | null;
  model_route: SessionModelRoute | null;
  thinking: ThinkingLevel;
  dangling: boolean;
}

/// A subagent's link back to the turn that spawned it: the parent session, the
/// tool call that asked for it, and the label that call showed.
export interface SessionParent {
  id: string;
  cwd: string;
  call_id: string;
  type: string;
  description: string;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
  parent: SessionParent | null;
}

export interface Limits {
  max_bytes: number;
  max_path: number;
  max_events: number;
}

/// How many plan events one document keeps before the older ones are folded
/// into a single snapshot.
export const DEFAULT_MAX_EVENTS = 1000;

export type Warner = (message: string, data?: Record<string, unknown>) => void;

let warner: Warner = (message, data) => console.warn(message, data ?? "");

/// Where a document this build could not read, or a lock it had to take over,
/// is reported. The capability points this at its own log line, so a host that
/// watches the kernel sees it like any other warning.
export function setWarner(fn: Warner | null): void {
  warner = fn ?? ((message, data) => console.warn(message, data ?? ""));
}

export function warn(message: string, data?: Record<string, unknown>): void {
  warner(message, data);
}

export function defaultMaxPath(platform: string = process.platform): number {
  return platform === "win32" ? 250 : 4000;
}

export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.MAOTA_HOME;
  return join(home && home.trim() !== "" ? home : join(homedir(), ".maota"), "sessions");
}

export function trimCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "");
}

export function encodeDir(cwd: string): string {
  const trimmed = trimCwd(cwd);
  if (trimmed === "") return DEFAULT_DIRNAME;
  return trimmed.replace(/[^A-Za-z0-9]/g, "-");
}

export function sameCwd(left: string, right: string): boolean {
  return trimCwd(left) === trimCwd(right);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertId(id: unknown): string {
  const value = String(id ?? "");
  if (!SESSION_ID.test(value)) {
    throw new CallError(-32602, `session id must match ${SESSION_ID.source}, got ${JSON.stringify(id)}`);
  }
  return value;
}

/// A stored document is read leniently and written strictly: a malformed link
/// inside a file reads as absent, while one this process was handed is a bug
/// worth refusing.
export function modelRouteOf(value: unknown): SessionModelRoute | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== "string" || raw.provider === "" || typeof raw.model !== "string" || raw.model === "") return null;
  return {
    provider: raw.provider,
    model: raw.model,
    ...(typeof raw.reasoning === "string" && raw.reasoning !== "" ? { reasoning: raw.reasoning } : {}),
  };
}

export function parentOf(value: unknown): SessionParent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const text = (name: string): string => (typeof raw[name] === "string" ? (raw[name] as string) : "");
  if (typeof raw.id !== "string" || !SESSION_ID.test(raw.id)) return null;
  return {
    id: raw.id,
    cwd: text("cwd"),
    call_id: text("call_id"),
    type: text("type"),
    description: text("description"),
  };
}

export function assertParent(value: unknown): SessionParent | null {
  if (value === undefined || value === null) return null;
  const parent = parentOf(value);
  if (parent === null) {
    throw new CallError(-32602, `parent must name the session that spawned this one, got ${JSON.stringify(value)}`);
  }
  return parent;
}

export function pathOf(root: string, id: string, cwd: string, limits: Limits): string {
  const path = join(root, encodeDir(cwd), `${id}.json`);
  if (path.length > limits.max_path) {
    throw new CallError(
      -32602,
      `session path is ${path.length} chars, over the max_path limit of ${limits.max_path}: ${path}`,
    );
  }
  return path;
}

type Read =
  | { state: "missing" }
  | { state: "bad"; reason: string }
  | { state: "ok"; file: SessionFile };

export function inspect(path: string): Read {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { state: "missing" }
      : { state: "bad", reason: messageOf(error) };
  }
  try {
    const parsed = JSON.parse(text) as SessionFile & { schema_version?: unknown };
    if (typeof parsed?.id !== "string" || !Array.isArray(parsed.messages)) {
      return { state: "bad", reason: "the document has no id and messages" };
    }
    const version = parsed.schema_version;
    if (version !== undefined && ![1, 2, 3, 4, 5, 6, SCHEMA_VERSION].includes(version)) {
      return { state: "bad", reason: `schema_version ${JSON.stringify(version)} is not one this build reads` };
    }
    const events = eventsOf((parsed as { events?: unknown }).events);
    if (events === null) return { state: "bad", reason: "the event list is not a list of plan events" };
    const compactions = compactionsOf((parsed as { compactions?: unknown }).compactions ?? [], false);
    if (compactions === null) return { state: "bad", reason: "the compaction list is not readable" };
    return {
      state: "ok",
      file: {
        ...parsed,
        schema_version: SCHEMA_VERSION,
        messages: projectMessages(parsed.messages, false),
        events,
        compactions,
        parent: parentOf((parsed as { parent?: unknown }).parent),
        model_route: modelRouteOf((parsed as { model_route?: unknown }).model_route),
        thinking: thinkingOf((parsed as { thinking?: unknown }).thinking) ?? "off",
        dangling: false,
      },
    };
  } catch (error) {
    return { state: "bad", reason: messageOf(error) };
  }
}

/// A document this build cannot read is set aside instead of being read as a
/// fresh session: the next `save` would otherwise write over a file that holds
/// somebody's transcript. The unreadable one is renamed out of the way, where a
/// person can find it, and named in a warning.
export function quarantine(path: string, reason: string): void {
  const aside = `${path}.bad-${Date.now()}`;
  try {
    renameSync(path, aside);
    warn(`session document ${path} could not be read (${reason}); moved to ${aside}`);
  } catch (error) {
    warn(`session document ${path} could not be read (${reason}) and could not be moved aside`, {
      error: messageOf(error),
    });
  }
}

export function readFileAt(path: string): SessionFile | null {
  const read = inspect(path);
  if (read.state === "bad") {
    quarantine(path, read.reason);
    return null;
  }
  return read.state === "ok" ? read.file : null;
}
