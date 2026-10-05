import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

function plugin(id: string, pkg: string): string[] {
  return [
    `[plugins.${id}]`,
    `command = '${process.execPath}'`,
    `args = ['${join(root, "packages", pkg, "src", "index.ts")}']`,
    "",
  ];
}

const dir = mkdtempSync(join(tmpdir(), "maota-conversation-"));
mkdirSync(join(dir, "skills", "hello"), { recursive: true });
writeFileSync(
  join(dir, "skills", "hello", "SKILL.md"),
  "---\nname: hello\ndescription: greet the user\n---\n\nSay hello politely.\n",
);

writeFileSync(
  join(dir, "blmoadll.toml"),
  [
    ...plugin("model-scripted", "model/model-scripted"),
    ...plugin("model-router", "model/model-router"),
    ...plugin("pwsh-local", "shell/pwsh-local"),
    ...plugin("tool-pwsh", "shell/tool-pwsh"),
    ...plugin("tool-fs", "fs/tool-fs"),
    ...plugin("tool-fs-search", "fs/tool-fs-search"),
    ...plugin("tools", "agent/tools"),
    ...plugin("skill-filesystem", "skill/skill-filesystem"),
    ...plugin("skill", "skill/skill"),
    ...plugin("tool-skill", "skill/tool-skill"),
    ...plugin("session", "session"),
    ...plugin("system-prompt", "agent/system-prompt"),
    ...plugin("agent", "agent/agent-core"),
    "",
  ].join("\n"),
);
const config = join(dir, "blmoadll.local.toml");
writeFileSync(
  config,
  [
    'extends = ["blmoadll.toml"]',
    "",
    "[plugins.model-scripted.config]",
    "script = [",
    '  { tool = "pwsh", args = { command = "echo hi" } },',
    '  { tool = "skill", args = { name = "hello" } },',
    '  { text = "all done" },',
    '  { text = "second turn" },',
    "]",

    "[plugins.model-router.config]",
    "file = '" + join(dir, "models.json").replace(/\\/g, "/") + "'",

    "",
    "[plugins.skill-filesystem.config]",
    `dirs = ['${join(dir, "skills").replace(/\\/g, "/")}']`,
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

function show(label: string, events: any[]): void {
  for (const event of events) {
    const detail =
      event.type === "tool_call"
        ? JSON.stringify(event.args)
        : event.type === "tool_result"
          ? (event.ok ? "" : "FAILED ") + JSON.stringify(event.output).slice(0, 160)
          : event.type === "text" || event.type === "done"
            ? JSON.stringify(event.text)
            : "";
    console.log(`  ${label} ${event.type.padEnd(11)} ${detail}`);
  }
}

const table = await kernel.capabilities();
for (const [capability, route] of Object.entries(table)) console.log(`  ${capability} = ${route.plugin}`);
assert.equal(table["agent.loop"]?.plugin, "agent");
assert.equal(table["shell"]?.plugin, "pwsh-local");
assert.equal(table["tool.pwsh"]?.plugin, "tool-pwsh");
assert.equal(table["tool.read"]?.plugin, "tool-fs");
assert.equal(table["tool.glob"]?.plugin, "tool-fs-search");

const tools = (await kernel.invoke("tools", "list", {})) as { tools: Array<{ name: string }> };
assert.deepEqual(
  tools.tools.map((tool) => tool.name),
  Object.keys(table)
    .filter((capability) => capability.startsWith("tool."))
    .map((capability) => capability.slice("tool.".length))
    .sort(),
  "the agent sees every tool.* capability the mounted plugins provide, in name order",
);
const skills = (await kernel.invoke("skill", "list", {})) as { skills: Array<{ name: string }> };
assert.deepEqual(
  skills.skills.map((skill) => skill.name),
  ["hello"],
);
const ran = (await kernel.invoke("tool.pwsh", "run", {
  command: "echo hi",
  workdir: dir,
  session_id: "direct",
  call_id: "direct_1",
})) as {
  exit_code: number | null;
  stdout: string;
};
assert.equal(ran.exit_code, 0);
assert.ok(ran.stdout.includes("hi"), `shell printed ${JSON.stringify(ran.stdout)}`);

console.log("\nturn 1 (say hi)");
const first = await turn({ session_id: "smoke", cwd: dir, input: "say hi" });
show("1", first);
assert.ok(first.some((event) => event.type === "step"), "loop should emit step events");
const shelled = first.find((event) => event.type === "tool_result" && event.tool === "pwsh");
assert.equal(shelled?.ok, true);
assert.equal(typeof shelled?.id, "string", "a tool result should carry the call id it answers");
assert.ok(String(shelled?.output?.stdout).includes("hi"), `pwsh result: ${JSON.stringify(shelled?.output)}`);
const read = first.find((event) => event.type === "tool_result" && event.tool === "skill");
assert.ok(String(read?.output?.content).includes("Say hello"), `skill result: ${JSON.stringify(read?.output)}`);
const done = first.at(-1);
assert.equal(done?.type, "done");
assert.equal(done?.text, "all done");
assert.equal(done?.steps, 3);

console.log("\nturn 2 (again)");
const second = await turn({ session_id: "smoke", cwd: dir, input: "again" });
show("2", second);
assert.equal(second.at(-1)?.text, "second turn");
assert.equal(second.at(-1)?.steps, 1, "the second turn should ask for no tool");

assert.equal(await kernel.shutdown("kernel_exit"), 0, "a clean shutdown exits 0");
console.log(`\n${logs.length} plugin log lines, the last few:`);
for (const line of logs.slice(-6)) console.log(`  ${line}`);
console.log("\nconversation ok: capabilities / tools.list / skill.list / tool.pwsh.run / agent.loop (two turns) / shutdown");
