import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kernel as installedKernel } from "@virgena/blmoadll";

import { boot, type Chunk } from "@maota/host";

const root = join(import.meta.dirname, "..", "..");
const kernelBin =
  process.argv[2] ??
  process.env.BLMOADLL_BIN ??
  installedKernel ??
  join(root, "..", "blmoadll", "target", "debug", "blmoadll.exe");

function packageEntry(name: string): string {
  return join(root, "packages", name, "src", "index.ts");
}

function plugin(id: string, entry: string): string[] {
  return [`[plugins.${id}]`, `command = '${process.execPath}'`, `args = ['${entry}']`, ""];
}

function slash(path: string): string {
  return path.split("\\").join("/");
}

const dir = mkdtempSync(join(tmpdir(), "maota-hooks-"));
const keeper = join(dir, "keeper");
const keptFile = join(keeper, "important.txt");
const refusedFile = join(dir, "hook-denied.txt");
mkdirSync(keeper, { recursive: true });
writeFileSync(keptFile, "still here\n");

const config = join(dir, "blmoadll.toml");
writeFileSync(
  config,
  [
    ...plugin("model-scripted", packageEntry("model/model-scripted")),
    ...plugin("model-router", packageEntry("model/model-router")),
    ...plugin("pwsh-local", packageEntry("shell/pwsh-local")),
    ...plugin("permission", packageEntry("interaction/permission")),
    ...plugin("tool-pwsh", packageEntry("shell/tool-pwsh")),
    ...plugin("tool-fs", packageEntry("fs/tool-fs")),
    ...plugin("tool-fs-search", packageEntry("fs/tool-fs-search")),
    ...plugin("tools", packageEntry("agent/tools")),
    ...plugin("skill", packageEntry("skill/skill")),
    ...plugin("session", packageEntry("session")),
    ...plugin("system-prompt", packageEntry("agent/system-prompt")),
    ...plugin("hooks", packageEntry("hooks/hooks-native")),
    ...plugin("hook-deny", join(root, "scripts", "tests", "fixtures", "hook-deny", "src", "index.ts")),
    ...plugin("agent", packageEntry("agent/agent-core")),
    "[plugins.model-scripted.config]",
    "script = [",
    `  { tool = "pwsh", args = { command = "New-Item -Path '${slash(refusedFile)}' -ItemType File -Force; Write-Output MAOTA_HOOK_DENY" } },`,
    `  { tool = "pwsh", args = { command = "rm -Recurse -Force '${slash(keeper)}'" } },`,
    '  { tool = "pwsh", args = { command = "Write-Output hi" } },',
    '  { text = "all done" },',
    '  { text = "after the steer" },',
    "]",

    "[plugins.model-router.config]",
    "file = '" + join(dir, "models.json").replace(/\\/g, "/") + "'",

    "",
  ].join("\n"),
);

writeFileSync(
  join(dir, "models.json"),
  JSON.stringify({
    revision: 1,
    providers: [{ id: "smoke", name: "Smoke", adapter: "scripted", base_url: "http://smoke", auth: { kind: "file" }, enabled: true, verified: true }],
    models: [{ provider: "smoke", model: "smoke", name: "Smoke", capabilities: { tools: true, vision: false }, reasoning_efforts: [], enabled: true, verified: true }],
    default_route: { provider: "smoke", model: "smoke" },
  }, null, 2) + "\n",
);

const logs: string[] = [];
const kernel = await boot(config, {
  bin: kernelBin,
  env: { ...process.env, MAOTA_HOME: dir },
  onLog: (line) => logs.push(String(line.message ?? JSON.stringify(line))),
});

async function turn(params: Record<string, unknown>): Promise<any[]> {
  const chunks: Chunk[] = [];
  const stream = await kernel.invoke("agent.loop", "run", params, { stream: true });
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.map((chunk) => chunk.data).filter((data) => data !== null) as any[];
}

async function stored(): Promise<Array<{ role: string; name?: string; content?: string }>> {
  const reply = (await kernel.invoke("session", "load", { id: "hooks", cwd: dir })) as {
    messages: Array<{ role: string; name?: string; content?: string }>;
  };
  return reply.messages;
}

function show(label: string, events: any[]): void {
  for (const event of events) {
    const detail =
      event.type === "tool_call"
        ? JSON.stringify(event.args)
        : event.type === "tool_result"
          ? (event.ok ? "" : "REFUSED ") + JSON.stringify(event.output).slice(0, 120)
          : event.type === "done"
            ? `${JSON.stringify(event.text)} steps=${event.steps} reason=${event.reason}`
            : "";
    console.log(`  ${label} ${event.type.padEnd(11)} ${detail}`);
  }
}

const table = await kernel.capabilities();
assert.equal(table["hooks"]?.plugin, "hooks", "the hook engine is mounted");
assert.equal(table["hook.deny"]?.plugin, "hook-deny", "the fixture hook is mounted");
const hooks = (await kernel.invoke("hooks", "list", {})) as { hooks: Array<{ capability: string; events: string[] }> };
assert.deepEqual(hooks.hooks, [
  { capability: "hook.deny", events: ["UserPromptSubmit", "PreToolUse", "Stop"] },
]);

console.log("\nturn 1 (a refused tool call, a destructive one the hook allows, a harmless one)");
const first = await turn({ session_id: "hooks", cwd: dir, input: "run three things" });
show("1", first);

const results = first.filter((event) => event.type === "tool_result");
const refused = results.find((event) => event.id === "call_0");
assert.equal(refused?.ok, false, "the hook refused this call");
assert.ok(String(refused?.output).includes("hook.deny refused"), `refusal: ${JSON.stringify(refused?.output)}`);
assert.equal(existsSync(refusedFile), false, "a refused call never reached the shell");

const gated = results.find((event) => event.id === "call_1");
assert.equal(gated?.output?.ok, false, "the permission gate refused the destructive command the hook allowed");
assert.equal(gated?.output?.status, "approval denied");
assert.ok(String(gated?.output?.reason).includes("no approval answerer"), `gate: ${JSON.stringify(gated?.output)}`);
assert.ok(existsSync(keptFile), "the destructive command never ran");

const harmless = results.find((event) => event.id === "call_2");
assert.equal(harmless?.ok, true);
assert.ok(String(harmless?.output?.stdout).includes("hi"), `result: ${JSON.stringify(harmless?.output)}`);

const done = first.at(-1);
assert.equal(done?.reason, "completed");
assert.equal(done?.text, "after the steer");
assert.equal(done?.steps, 5, "the stop hook steered exactly one extra step");

const written = await stored();
assert.deepEqual(
  written
    .filter((message) => message.role === "user" && typeof message.name === "string")
    .map((message) => `${message.name}:${message.content}`),
  [
    "hook:deny:hook.deny allowed pwsh",
    "hook:deny:hook.deny allowed pwsh",
    "hook:deny:stop_active=false",
    "hook:stop:say one more thing",
    "hook:deny:stop_active=true",
  ],
  "a hook's context lands in the session tagged with it: once per call it allowed, then the stop seam",
);

console.log("\nturn 2 (a refused prompt)");
const second = await turn({ session_id: "hooks", cwd: dir, input: "please MAOTA_HOOK_REFUSE this" });
show("2", second);
assert.deepEqual(
  second.map((event) => event.type),
  ["done"],
  "a refused prompt costs no step at all",
);
assert.equal(second[0]?.reason, "refused");
assert.equal(second[0]?.steps, 0);
assert.equal(second[0]?.text, "the deny hook refused this prompt");
assert.ok(
  !(await stored()).some((message) => String(message.content).includes("MAOTA_HOOK_REFUSE")),
  "a refused prompt is never written down",
);

assert.equal(await kernel.shutdown("kernel_exit"), 0, "a clean shutdown exits 0");
console.log(`\n${logs.length} plugin log lines, the last few:`);
for (const line of logs.slice(-5)) console.log(`  ${line}`);
console.log("\nhooks ok: a refused call, the gate under it, a refused prompt, and one steered stop");
