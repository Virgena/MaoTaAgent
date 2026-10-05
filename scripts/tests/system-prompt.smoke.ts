import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kernel as installedKernel } from "@virgena/blmoadll";

import { boot } from "@maota/host";

const root = join(import.meta.dirname, "..", "..");
const kernelBin =
  process.argv[2] ??
  process.env.BLMOADLL_BIN ??
  installedKernel ??
  join(root, "..", "blmoadll", "target", "debug", "blmoadll.exe");

const PERSONA = "speak in the deployment's own voice";

type Assembly = { text: string; sections: Array<{ name: string; order: number; scope: string }>; variables: string[] };

const dir = mkdtempSync(join(tmpdir(), "maota-prompt-"));
writeFileSync(
  join(dir, "blmoadll.toml"),
  [
    "[plugins.system-prompt]",
    `command = '${process.execPath}'`,
    `args = ['${join(root, "packages", "agent", "system-prompt", "src", "index.ts")}']`,
    "",
  ].join("\n"),
);
const config = join(dir, "config.toml");
writeFileSync(
  config,
  [
    'extends = ["blmoadll.toml"]',
    "",
    "[plugins.system-prompt.config]",
    `persona = "${PERSONA}"`,
    "",
  ].join("\n"),
);

const kernel = await boot(config, {
  bin: kernelBin,
  env: { ...process.env, MAOTA_HOME: dir },
});

const assemble = async (facts: Record<string, string>): Promise<Assembly> =>
  (await kernel.invoke("system-prompt", "assemble", facts)) as Assembly;

const bare = await assemble({ session_id: "s1" });
assert.ok(bare.text.includes(PERSONA), `the deployment persona is missing: ${JSON.stringify(bare.text)}`);
assert.ok(
  !bare.text.includes("working directory:") && !bare.text.includes("approval:"),
  "an assembly with no facts stated a place or a policy",
);
assert.deepEqual(
  bare.sections.map((section) => section.name),
  ["harness", "persona"],
  `the built-in sections assembled as ${bare.sections.map((section) => section.name).join(",")}`,
);

const placed = await assemble({ session_id: "s1", cwd: "E:\\proj", approval: "ask" });
assert.ok(placed.text.includes("working directory: E:\\proj"), "the working directory was not stated");
assert.ok(placed.text.includes("waits for the user's decision"), "the ask policy was not stated");
assert.deepEqual(
  placed.sections.map((section) => section.name),
  ["harness", "persona", "working-directory", "approval"],
  "the sections assembled out of order",
);
assert.equal(placed.variables.join(","), "cwd,session_id");

await kernel.invoke("system-prompt", "register", { name: "broken", order: 2000, text: "see {{nowhere}}" });
await assert.rejects(
  () => assemble({ session_id: "s1" }),
  /unknown prompt variable/,
  "a section naming an unregistered variable still assembled",
);
await kernel.invoke("system-prompt", "unregister", { name: "broken" });

await kernel.invoke("system-prompt", "register", { name: "extra", order: 2000, text: "session {{session_id}}" });
const grown = await assemble({ session_id: "s1" });
assert.equal(grown.sections.at(-1)?.name, "extra", "a registered section did not sort last");
assert.ok(grown.text.endsWith("session s1"), `the registered variable resolved as ${JSON.stringify(grown.text)}`);
assert.ok(!grown.text.includes("{{"), "an assembled prompt kept a variable");

await kernel.invoke("system-prompt", "register", { name: "extra", text: "only for s2", scope: "s2" });
const other = await assemble({ session_id: "s2" });
assert.ok(other.text.includes("only for s2"), "a session section did not appear in its own session");
assert.ok(!other.text.includes("session s2\n"), "a session section duplicated the global one");
const first = await assemble({ session_id: "s1" });
assert.ok(first.text.endsWith("session s1"), "a session section leaked into another session");

await assert.rejects(
  () => kernel.invoke("system-prompt", "register", { name: "extra", text: "again" }),
  "a name already taken in one scope was registered twice",
);
await assert.rejects(
  () => kernel.invoke("system-prompt", "register", { name: "bad", text: 7 }),
  "a non-string section text reached the registry",
);
await assert.rejects(
  () => kernel.invoke("system-prompt", "release", { scope: "global" }),
  "the global scope was released over the wire",
);

const released = (await kernel.invoke("system-prompt", "release", { scope: "s2" })) as { sections: number };
assert.equal(released.sections, 1, "a released scope reported the wrong count");
assert.ok(!(await assemble({ session_id: "s2" })).text.includes("only for s2"), "a released scope kept its section");

const removed = (await kernel.invoke("system-prompt", "unregister", { name: "extra" })) as { removed: boolean };
assert.equal(removed.removed, true, "a registered section could not be removed");
assert.equal((await assemble({ session_id: "s1" })).text, bare.text, "an unregistered section stayed in the assembly");

assert.equal(await kernel.shutdown("kernel_exit"), 0, "a clean shutdown exits 0");
console.log("\nsystem-prompt ok: the deployment persona, the stated place and policy, the registry over the wire");
