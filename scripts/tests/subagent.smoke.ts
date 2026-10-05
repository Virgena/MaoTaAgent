import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kernel as installedKernel } from "@virgena/blmoadll";

import { boot, type Chunk, type Event } from "@maota/host";

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

const dir = mkdtempSync(join(tmpdir(), "maota-subagent-"));
writeFileSync(join(dir, "note.txt"), "hi\n");

writeFileSync(
  join(dir, "blmoadll.toml"),
  [
    ...plugin("model-scripted", "model/model-scripted"),
    ...plugin("model-router", "model/model-router"),
    ...plugin("tool-fs", "fs/tool-fs"),
    ...plugin("tool-fs-search", "fs/tool-fs-search"),
    ...plugin("tools", "agent/tools"),
    ...plugin("session", "session"),
    ...plugin("system-prompt", "agent/system-prompt"),
    ...plugin("tool-subagent", "subagent/tool-subagent"),
    ...plugin("agent-core", "agent/agent-core"),
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
    '  { tool = "task", args = { prompt = "read note.txt and tell me what it says", description = "look at the note", subagent_type = "explore" } },',
    '  { tool = "read", args = { file_path = "note.txt" } },',
    '  { text = "the note says hi" },',
    '  { text = "the subagent read the note" },',
    '  { tool = "task", args = { prompt = "write something into note.txt", description = "change the note", subagent_type = "explore" } },',
    '  { tool = "write", args = { file_path = "note.txt", content = "x" } },',
    '  { text = "I cannot write anything" },',
    '  { text = "understood" },',
    "  { text = \"(the script ran out)\" },",
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

const bus: Event[] = [];
kernel.on(["agent.subagent.*"], (event) => bus.push(event));

async function run(params: Record<string, unknown>): Promise<any[]> {
  const chunks: Chunk[] = [];
  const stream = await kernel.invoke("agent.loop", "run", params, { stream: true });
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.map((chunk) => chunk.data).filter((data) => data !== null) as any[];
}

function field(event: Event | undefined): Record<string, any> {
  return (event?.payload ?? {}) as Record<string, any>;
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
assert.equal(table["tool.task"]?.plugin, "tool-subagent");
assert.equal(table["tool.grep"]?.plugin, "tool-fs-search");

const tools = (await kernel.invoke("tools", "list", {})) as { tools: Array<{ name: string }> };
assert.deepEqual(
  tools.tools.map((tool) => tool.name),
  ["edit", "glob", "grep", "read", "task", "write"],
);

console.log("\nturn 1 (delegate to an explore subagent)");
const before = bus.length;
const first = await run({ session_id: "sub1", cwd: dir, input: "look around" });
show("1", first);

const calls = first.filter((event) => event.type === "tool_call");
assert.deepEqual(calls.map((event) => event.tool), ["task"], "the parent should only call task");
assert.equal(calls[0]?.id, "call_0", "the scripted backend numbers the parent's first call call_0");
const handoff = first.find((event) => event.type === "tool_result");
assert.equal(handoff?.tool, "task");
assert.equal(handoff?.ok, true, `the task call failed: ${JSON.stringify(handoff?.output)}`);
assert.equal(handoff?.output, "the note says hi", "only the subagent's last message should come back");
assert.equal(
  first.filter((event) => event.type === "tool_result" && event.tool === "read").length,
  0,
  "the subagent's own tool traffic must not land in the parent's stream",
);
assert.equal(first.at(-1)?.text, "the subagent read the note");
assert.equal(first.at(-1)?.steps, 2, "the parent's own steps are all it counts");

const heard = bus.slice(before);
assert.deepEqual(
  heard.map((event) => event.topic),
  [
    "agent.subagent.started",
    "agent.subagent.step",
    "agent.subagent.tool_call",
    "agent.subagent.tool_result",
    "agent.subagent.step",
    "agent.subagent.finished",
  ],
  `the subagent published ${JSON.stringify(heard.map((event) => event.topic))}`,
);
const born = heard[0]?.payload as {
  subagent_id: string;
  parent_session_id: string;
  parent_call_id: string;
  type: string;
  description: string;
};
assert.match(born.subagent_id, /^sub-[0-9a-f]{12}$/, `the child session is ${born.subagent_id}`);
assert.equal(born.parent_session_id, "sub1");
assert.equal(born.parent_call_id, "call_0", "the subagent should hang under the call that started it");
assert.equal(born.parent_call_id, calls[0]?.id, "the event's call id should be the tool row's id");
assert.equal(born.type, "explore");
assert.equal(born.description, "look at the note");
assert.ok(
  heard.every((event) => (event.payload as { parent_call_id?: string }).parent_call_id === "call_0"),
  "every subagent event should name the call it belongs to",
);
assert.equal(field(heard[2]).tool, "read", "the bus should carry what the subagent actually called");
assert.equal(field(heard[5]).ok, true, `the subagent finished badly: ${JSON.stringify(heard[5]?.payload)}`);

const child = (await kernel.invoke("session", "load", { id: born.subagent_id, cwd: dir })) as {
  title: string;
  parent: { id: string; cwd: string; call_id: string; type: string; description: string } | null;
  messages: Array<{ role: string }>;
};
assert.deepEqual(
  child.messages.map((message) => message.role),
  ["user", "assistant", "tool", "assistant"],
  `the child session holds ${JSON.stringify(child.messages.map((message) => message.role))}`,
);
assert.equal(child.parent?.id, "sub1", "the child session should carry its parent");
assert.equal(child.parent?.call_id, "call_0");
assert.equal(child.parent?.type, "explore");
assert.equal(child.title, "look at the note", "the child's title is the call's label");

const listed = (await kernel.invoke("session", "list", {})) as {
  sessions: Array<{ id: string; parent?: { call_id?: string } | null }>;
};
assert.deepEqual(
  listed.sessions.map((session) => session.id).sort(),
  ["sub1", born.subagent_id].sort(),
  "the index should carry the session and the subagent it started",
);
assert.equal(
  listed.sessions.find((session) => session.id === born.subagent_id)?.parent?.call_id,
  "call_0",
  "a listed child should say which call started it, so a sidebar can leave it out",
);
const kids = (await kernel.invoke("session", "children", { id: "sub1", cwd: dir })) as {
  children: Array<{ id: string; parent?: { call_id?: string } | null }>;
};
assert.deepEqual(kids.children.map((entry) => entry.id), [born.subagent_id]);
assert.equal(kids.children[0]?.parent?.call_id, "call_0", "a listed child should still say where it came from");

console.log("\nturn 2 (an explore subagent may not write)");
const beforeSecond = bus.length;
const second = await run({ session_id: "sub1", cwd: dir, input: "change the note" });
show("2", second);
const heard2 = bus.slice(beforeSecond);

const refusedEvent = heard2.find((event) => event.topic === "agent.subagent.tool_result");
const refused = (refusedEvent?.payload ?? {}) as { tool?: string; ok?: boolean; output?: unknown };
assert.equal(refused.tool, "write");
assert.equal(refused.ok, false, "an explore subagent must not be able to write");
assert.ok(
  String(refused.output).includes("not available to this subagent"),
  `the refusal said ${JSON.stringify(refused.output)}`,
);
const answer = second.find((event) => event.type === "tool_result" && event.tool === "task");
assert.equal(answer?.ok, true, "a refused tool is a result the subagent reads, not a broken call");
assert.equal(answer?.output, "I cannot write anything");
assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "hi\n", "the file should be untouched");

const grown = (await kernel.invoke("session", "children", { id: "sub1", cwd: dir })) as {
  children: Array<{ id: string }>;
};
assert.equal(grown.children.length, 2, "the second subagent should be a session of its own");

assert.equal(await kernel.shutdown("kernel_exit"), 0, "a clean shutdown exits 0");
console.log(`\n${logs.length} plugin log lines, the last few:`);
for (const line of logs.slice(-4)) console.log(`  ${line}`);
console.log("\nsubagent ok: the delegation, the parent's clean history, the bus, the child document, the read-only type");
