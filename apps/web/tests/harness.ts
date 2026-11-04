/// The rig behind the web smoke: it writes a throwaway home and plugin config,
/// boots the kernel, and hands the checks a live page. The checks themselves
/// live in web.smoke.ts and read the kernel, the base URL, the event stream and
/// the helpers exported here.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kernel as installed } from "@virgena/blmoadll";

import { boot } from "@maota/host";

export const SHORT = "the short answer.";
export const LONG = "lorem-ipsum-".repeat(1400);

export const root = join(import.meta.dirname, "..", "..", "..");
const bin =
  process.argv[2] ??
  process.env.BLMOADLL_BIN ??
  installed ??
  join(root, "..", "blmoadll", "target", "debug", "blmoadll.exe");

const PLUGINS: Array<[string, string]> = [
  ["model-router", "packages/model/model-router/src/index.ts"],
  ["model-scripted", "packages/model/model-scripted/src/index.ts"],
  ["model-openai", "packages/model/model-openai/src/index.ts"],
  ["settings", "packages/settings/settings/src/index.ts"],
  ["workspace", "packages/workspace/workspace/src/index.ts"],
  ["git", "packages/git/git/src/index.ts"],
  ["pwsh-local", "packages/shell/pwsh-local/src/index.ts"],
  ["permission", "packages/interaction/permission/src/index.ts"],
  ["tool-pwsh", "packages/shell/tool-pwsh/src/index.ts"],
  ["tool-fs", "packages/fs/tool-fs/src/index.ts"],
  ["tool-fs-search", "packages/fs/tool-fs-search/src/index.ts"],
  ["tool-subagent", "packages/subagent/tool-subagent/src/index.ts"],
  ["tools", "packages/agent/tools/src/index.ts"],
  ["skill-filesystem", "packages/skill/skill-filesystem/src/index.ts"],
  ["skill-bundled", "packages/skill/skill-bundled/src/index.ts"],
  ["skill", "packages/skill/skill/src/index.ts"],
  ["tool-skill", "packages/skill/tool-skill/src/index.ts"],
  ["session", "packages/session/src/index.ts"],
  ["system-prompt", "packages/agent/system-prompt/src/index.ts"],
  ["agent-core", "packages/agent/agent-core/src/index.ts"],
  ["web", "apps/web/src/index.ts"],
];

export const home = mkdtempSync(join(tmpdir(), "maota-web-"));
const config = join(home, "blmoadll.local.toml");

writeFileSync(
  join(home, "models.json"),
  JSON.stringify({
    revision: 1,
    providers: [{ id: "smoke", name: "Smoke", adapter: "scripted", base_url: "http://smoke", auth: { kind: "file" }, enabled: true, verified: true }],
    models: [{ provider: "smoke", model: "smoke-chat", name: "Smoke Chat", capabilities: { tools: true, vision: false }, reasoning_efforts: [], enabled: true, verified: true }],
    default_route: { provider: "smoke", model: "smoke-chat" },
  }, null, 2) + "\n",
);

writeFileSync(
  join(home, "blmoadll.toml"),
  PLUGINS.map(
    ([id, main]) => `[plugins.${id}]\ncommand = '${process.execPath}'\nargs = ['${join(root, main)}']\n`,
  ).join("\n"),
);

writeFileSync(
  config,
  [
    'extends = ["blmoadll.toml"]',
    "",
    "[plugins.model-scripted.config]",
    "script = [",
    `  { reasoning = 'check the request', text = '${SHORT}' },`,
    `  { text = '${LONG}' },`,
    "  { },",
    `  { text = 'first workdir turn' },`,
    `  { tool = 'pwsh', args = { command = \"Write-Output rm file\" } },`,
    `  { text = 'ran it' },`,
    `  { tool = 'pwsh', args = { command = \"Write-Output rm file\" } },`,
    `  { text = 'refused' },`,
    `  { tool = 'pwsh', args = { command = \"Write-Output rm file\" } },`,
    `  { text = 'ran it anyway' },`,
    `  { tool = 'task', args = { prompt = 'read note.txt and tell me what it says', description = 'look at the note', subagent_type = 'explore' } },`,
    `  { tool = 'read', args = { file_path = 'note.txt' } },`,
    `  { text = 'the note says hi' },`,
    `  { text = 'the subagent read the note' },`,
    "]",
    "",
    "[plugins.agent-core.config.thinking]",
    'medium = { tools = false }',
    "[plugins.model-router.config]",
    "file = '" + join(home, "models.json").replace(/\\/g, "/") + "'",
    "",
    "",
    "[plugins.web.config]",
    "port = 0",
    "dev = false",
    "",
  ].join("\n"),
);

export interface Frame {
  event?: string;
  turn_id?: string;
  session_id?: string;
  text?: string;
  code?: number;
  message?: string;
  request_id?: string;
  id?: string;
  tool?: string;
  call_id?: string;
  subagent_id?: string;
  parent_call_id?: string;
  type?: string;
  description?: string;
  reason?: string;
  outcome?: string;
  ok?: boolean;
  output?: any;
}

export const logs: string[] = [];
export const kernel = await boot(config, {
  bin,
  env: { ...process.env, MAOTA_HOME: home },
  onLog: (line) => logs.push(`${String(line.level ?? "?")} ${String(line.message ?? JSON.stringify(line))}`),
});

export const info = (await kernel.invoke("web", "info")) as {
  url: string;
  version: string;
  dev: boolean;
  sessions_dir: string | null;
  levels: string[];
  thinking: Record<string, { model?: string; tools?: boolean }> | null;
};
export const base = info.url;

export const events: Frame[] = [];
const watchers: Array<(event: Frame) => void> = [];
let finished = false;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function call(method: string, params: unknown = {}): Promise<any> {
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = (await response.json()) as { result?: any; error?: { code: number; message: string } };
  if (payload.error) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
  return payload.result;
}

async function listen(): Promise<void> {
  const response = await fetch(`${base}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as Frame;
        events.push(event);
        for (const watch of [...watchers]) watch(event);
      }
    }
  }
}

export function waitFor(match: (event: Frame) => boolean, timeout = 30_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const seen = events.find(match);
    if (seen) {
      resolve(seen);
      return;
    }
    const watch = (event: Frame): void => {
      if (!match(event)) return;
      clearTimeout(timer);
      watchers.splice(watchers.indexOf(watch), 1);
      resolve(event);
    };
    const timer = setTimeout(() => {
      watchers.splice(watchers.indexOf(watch), 1);
      reject(
        new Error(
          `no matching event after ${timeout}ms; seen: ${JSON.stringify(events.slice(-8))}; ` +
            `plugin log: ${logs.slice(-5).join(" | ")}`,
        ),
      );
    }, timeout);
    watchers.push(watch);
  });
}

export function textOf(turnId: string): string {
  return events
    .filter((event) => event.event === "text" && event.turn_id === turnId)
    .map((event) => event.text ?? "")
    .join("");
}

/// The harness writes the skill catalog into the history itself, so a check
/// about what a person said has to look past it.
export function isCatalog(message: unknown): boolean {
  const source = (message as { source?: { kind?: unknown } } | null)?.source;
  return source?.kind === "skill-catalog";
}

export async function turn(session: string, input: string, cwd = "", thinking = "off"): Promise<string> {
  return (await call("chat.send", { session_id: session, cwd, input, thinking })).turn_id as string;
}

let passed = 0;
export async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ok  ${name}`);
}

export function passedCount(): number {
  return passed;
}

/// Reads the event stream into memory. A stream that breaks is worth reporting
/// only while the run is still going; the kernel closing ends it on purpose.
export function startStream(): void {
  void listen().catch((error: unknown) => {
    if (!finished) console.error(`event stream broke: ${String(error)}`);
  });
}

export function finish(): void {
  finished = true;
}
