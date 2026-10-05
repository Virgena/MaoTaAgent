import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kernel as installedKernel } from "@virgena/blmoadll";

import { boot } from "@maota/host";

const root = join(import.meta.dirname, "..", "..");
const kernelBin = process.argv[2] ?? process.env.BLMOADLL_BIN ?? installedKernel ?? join(root, "..", "blmoadll", "target", "debug", "blmoadll.exe");
const dir = mkdtempSync(join(tmpdir(), "maota-cron-"));
function plugin(id: string, pkg: string): string[] {
  return [`[plugins.${id}]`, `command = '${process.execPath}'`, `args = ['${join(root, "packages", pkg, "src", "index.ts")}']`, ""];
}
const config = join(dir, "blmoadll.toml");
writeFileSync(config, [
  ...plugin("api", "api"),
  ...plugin("model-api", "model/model-api"),
  ...plugin("model-router", "model/model-router"),
  ...plugin("jobs", "jobs/jobs"),
  ...plugin("shell", "shell/pwsh-local"),
  ...plugin("permission", "interaction/permission"),
  ...plugin("tools", "agent/tools"),
  ...plugin("session", "session"),
  ...plugin("system-prompt", "agent/system-prompt"),
  ...plugin("agent-core", "agent/agent-core"),
  ...plugin("agent-runner", "agent/agent-runner"),
  ...plugin("schedule", "schedule/schedule"),
  "",
].join("\n"));
async function open() {
  return await boot(config, { bin: kernelBin, env: { ...process.env, MAOTA_HOME: dir } });
}
let kernel = await open();
const created = (await kernel.invoke("schedule", "create", {
  title: "smoke reminder",
  mode: "remind",
  prompt: "check smoke",
  schedule_kind: "after",
  after_seconds: 3600,
  source_session_id: "s1",
  source_cwd: dir,
  permission: "ask",
})) as { id: string };
assert.match(created.id, /^sch-/);
await kernel.shutdown("ui_quit");
kernel = await open();
const listed = (await kernel.invoke("schedule", "list", {})) as { schedules: Array<{ id: string }> };
assert.ok(listed.schedules.some((record) => record.id === created.id));
await kernel.invoke("schedule", "delete", { id: created.id });
await kernel.shutdown("ui_quit");
console.log("cron smoke ok");
