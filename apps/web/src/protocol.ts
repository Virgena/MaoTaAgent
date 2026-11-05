import type { Language } from "@maota/i18n-protocol";

export interface RpcFailure {
  code: number;
  message: string;
}

/// The interface's words as the host built them: every language any plugin
/// declared, every namespace it contributed, and the problems the store found
/// while folding them together. The app's own copy is compiled in, so this is
/// only what the plugins added.
export interface HostCatalog {
  locale: string;
  languages: Language[];
  namespaces: string[];
  catalog: Record<string, Record<string, Record<string, string>>>;
  problems: string[];
}

export interface AppInfo {
  version: string;
  url: string;
  listening: boolean;
  dev: boolean;
  sessions_dir: string | null;
  levels: string[];
  thinking: Record<string, { model?: string; tools?: boolean }> | null;
  has_key: boolean | null;
  models: ModelCatalogView | null;
  capabilities: Record<string, { plugin: string }>;
  i18n: HostCatalog | null;
}

export interface ModelRoute {
  provider: string;
  model: string;
  reasoning?: string;
}

export interface ModelProviderView {
  id: string;
  name: string;
  adapter: string;
  base_url: string;
  auth: { kind: "file" } | { kind: "env"; name: string };
  enabled: boolean;
  verified: boolean;
  key_configured: boolean;
  key_source: "file" | "env";
}

export interface ModelView {
  provider: string;
  model: string;
  name: string;
  context_tokens?: number;
  max_output_tokens?: number;
  capabilities: { tools: boolean; vision: boolean };
  reasoning_efforts: string[];
  enabled: boolean;
  verified: boolean;
}

export interface AdapterView {
  id: string;
  name: string;
  endpoint_hint?: string;
}

export interface ModelCatalogView {
  revision: number;
  providers: ModelProviderView[];
  models: ModelView[];
  default_route: ModelRoute | null;
  adapters: AdapterView[];
}

export type ThemePreference = "system" | "dark" | "light";

export interface SettingsView {
  revision: number;
  locale: string | null;
  theme: ThemePreference | null;
}

export interface WorkspaceProjectView {
  path: string;
  name: string | null;
}

export interface WorkspaceView {
  revision: number;
  projects: WorkspaceProjectView[];
  pinned_sessions: string[];
  archived_sessions: string[];
}

export interface GitStatusView {
  is_repo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  branches: string[];
}

export interface GitWorktreeView {
  path: string;
  branch: string;
  status: GitStatusView;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string;
  created_at?: string;
  updated_at: string;
  parent?: SessionParent | null;
}

/// A subagent's link back to the call that started it, as the session document
/// keeps it: the parent's id and working directory, the id of the `task` call
/// it hangs under, and the label that call carried.
export interface SessionParent {
  id: string;
  cwd: string;
  call_id: string;
  type: string;
  description: string;
}

export interface SubagentRef {
  id: string;
  type?: string;
  description?: string;
}

export interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/// What the harness attached to a message it wrote for itself. The only kind so
/// far is the skill catalog, whose `entries` are what the model last read, so a
/// reader can tell an injected note from something a person typed.
export interface SessionMessageSource {
  kind: string;
  update?: boolean;
  entries?: Array<{ name: string; description: string }>;
  id?: string;
  folded?: number;
  trigger?: string;
}

export interface ArtifactRef {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArchiveRef {
  path: string;
  bytes: number;
  sha256: string;
  messages: number;
}

export interface CompactionRecord {
  id: string;
  at: string;
  trigger: string;
  kind: "prune" | "summary";
  status: "committed" | "failed";
  folded: number;
  chars_before: number;
  chars_after: number;
  artifacts: ArtifactRef[];
  archive?: ArchiveRef;
  error?: string;
}

export interface ContextView {
  estimated_chars: number;
  threshold_chars: number;
  ratio: number;
  active: boolean;
  compactions: CompactionRecord[];
}

export interface SessionMessage {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  source?: SessionMessageSource;
  reasoning?: string;
  reasoning_ms?: number;
  steps?: number;
}

export interface SessionFile {
  schema_version: number;
  id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: SessionMessage[];
  compactions?: CompactionRecord[];
  model_route?: ModelRoute | null;
  thinking?: "off" | "low" | "medium" | "high";
  dangling: boolean;
}

/// A model-request failure as a front end reads it: the kind decides what the
/// page says and whether a retry is even thinkable, and the message is what the
/// provider said.
export interface HostFailure {
  message: string;
  code: number;
  kind: string;
  status?: number;
  retry_after_ms?: number;
  request_id?: string;
}

export interface HostEvent {
  event: string;
  turn_id?: string;
  session_id?: string;
  text?: string;
  step?: number;
  tool?: string;
  id?: string;
  args?: unknown;
  ok?: boolean;
  output?: unknown;
  steps?: number;
  code?: number;
  message?: string;
  request_id?: string;
  call_id?: string;
  reason?: string;
  outcome?: string;
  subagent_id?: string;
  parent_call_id?: string;
  type?: string;
  description?: string;
  subagent?: SubagentRef;
  failure?: HostFailure;
  trigger?: string;
  folded?: number;
  chars_before?: number;
  chars_after?: number;
  status?: string;
  error?: string;
  settings?: SettingsView;
  workspace?: WorkspaceView;
  host_state?: string;
  host_ready?: number;
  host_total?: number;
  host_plugin?: string;
}

export interface Approval {
  id: string;
  session_id: string;
  tool: string;
  call_id?: string;
  reason?: string;
  at?: string;
  subagent?: SubagentRef;
}

export interface BridgeFacts {
  sessions_dir: string | null;
  levels: string[];
  thinking: Record<string, { model?: string; tools?: boolean }> | null;
  has_key: boolean | null;
  models: ModelCatalogView | null;
}

export interface SkillInvocationPolicy {
  modelInvocable: boolean;
  userInvocable: boolean;
}

/// One skill as the registry reports it: the one line the model reads before it
/// decides, where the skill came from, what discovered it, and whether this
/// working directory activates it.
export interface SkillSummary {
  name: string;
  description: string;
  whenToUse?: string;
  source: string;
  provider: string;
  invocation: SkillInvocationPolicy;
  paths?: string[];
  active: boolean;
  resourceBase?: { kind: "directory"; path: string };
  inert?: string[];
}
