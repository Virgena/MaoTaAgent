import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kernel as installedKernel } from "@virgena/blmoadll";

import { boot } from "@maota/host";

const root = join(import.meta.dirname, "..", "..");
const kernelBin = process.argv[2] ?? process.env.BLMOADLL_BIN ?? installedKernel ?? join(root, "..", "blmoadll", "target", "debug", "blmoadll.exe");
const dir = mkdtempSync(join(tmpdir(), "maota-jobs-"));
function plugin(id: string, pkg: string): string[] {
  return [`[plugins.${id}]`, `command = '${process.execPath}'`, `args = ['${join(root, "packages", pkg, "src", "index.ts")}']`, ""];
}
const config = join(dir, "blmoadll.toml");
writeFileSync(config, [...plugin("jobs", "jobs/jobs"), ...plugin("shell", "shell/pwsh-local"), ""].join("\n"));
const kernel = await boot(config, { bin: kernelBin, env: { ...process.env, MAOTA_HOME: dir } });
try {
  const started = (await kernel.invoke("shell", "start", {
    command: "Write-Output maota-job; Start-Sleep -Milliseconds 100",
    workdir: dir,
    owner: "s1",
    label: "smoke",
  })) as { job_id: string };
  assert.match(started.job_id, /^shell-/);
  let settled = { status: "running" };
  for (let attempt = 0; attempt < 20 && (settled.status === "running" || settled.status === "stopping"); attempt += 1) {
    settled = (await kernel.invoke("jobs", "wait", { id: started.job_id, owner: "s1", timeout_ms: 1000 })) as { status: string };
  }
  assert.equal(settled.status, "completed");
  const read = (await kernel.invoke("jobs", "read", { id: started.job_id, owner: "s1" })) as { chunks: Array<{ text: string }> };
  assert.match(read.chunks.map((chunk) => chunk.text).join(""), /maota-job/);
} finally {
  await kernel.shutdown("ui_quit");
}
console.log("jobs integration smoke ok");