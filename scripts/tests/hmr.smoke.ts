import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { kernel as kernelBin } from "@virgena/blmoadll";

import { restartOnSourceChange } from "../../apps/cli/src/hmr.ts";
import { boot, type Event } from "@maota/host";

const [blmoadllArg] = process.argv.slice(2);
const blmoadll = blmoadllArg ?? kernelBin;
if (!blmoadll) throw new Error("usage: node scripts/tests/hmr.smoke.ts [blmoadll]");

const root = join(import.meta.dirname, "..", "..");
const slashes = (path: string) => path.replaceAll("\\", "/");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function pluginSource(capability: string, imports: string[]): string {
  const kit = pathToFileURL(join(root, "packages", "plugin-kit", "src", "index.ts")).href;
  const rel = kit;
  return [
    `import { runPlugin, type Definition } from "${rel}";`,
    ...imports.map((specifier) => `import "${specifier}";`),
    "",
    "export const definition: Definition = {",
    `  provides: ["${capability}"],`,
    "  injects: [],",
    "  registrations: [],",
    `  hostCalls: ["${capability}"],`,
    "  configKeys: [],",
    "  methods: { ping() { return 1; } },",
    "};",
    "",
    "runPlugin(definition);",
    "",
  ].join("\n");
}

const dir = mkdtempSync(join(tmpdir(), "maota-hmr-"));
for (const name of ["shared", "one", "two", "node_modules"]) {
  mkdirSync(join(dir, name), { recursive: true });
}

const kit = join(dir, "shared", "kit.ts");
const local = join(dir, "one", "local.ts");
const one = join(dir, "one", "main.ts");
const two = join(dir, "two", "main.ts");
const ignored = join(dir, "node_modules", "ignored.js");

writeFileSync(kit, "export const kit = 1;\n");
writeFileSync(local, 'import "../shared/kit.ts";\nexport const local = 1;\n');
writeFileSync(one, pluginSource("smoke.one", ["./local.ts", "../shared/kit.ts"]));
writeFileSync(two, pluginSource("smoke.two", ["../shared/kit.ts"]));
writeFileSync(ignored, "export const ignored = 1;\n");

const config = join(dir, "blmoadll.toml");
writeFileSync(
  config,
  [
    "[plugins.one]",
    'command = "node"',
    `args = ["${slashes(one)}"]`,
    "",
    "[plugins.two]",
    'command = "node"',
    `args = ["${slashes(two)}"]`,
    "",
    "[plugins.hmr]",
    'command = "node"',
    `args = ["${slashes(join(root, "packages", "boot", "hmr", "src", "index.ts"))}"]`,
    "[plugins.hmr.config]",
    `roots = ["${slashes(dir)}"]`,
    "",
  ].join("\n"),
);

const kernel = await boot(config, { bin: blmoadll });
const started: Array<{ plugin?: string; pid?: number; trigger?: string }> = [];
const changed: string[] = [];
kernel.on(["kernel.plugin.started"], (event: Event) => started.push(event.payload as { plugin?: string }));
kernel.on(["dev.source.changed"], (event: Event) => changed.push(String((event.payload as { path?: unknown }).path)));
restartOnSourceChange(kernel);

const mine = () => started.filter((event) => event.trigger === "source");
await until(() => started.some((event) => event.plugin === "one"), "boot replay");
await sleep(200);

started.length = 0;
writeFileSync(local, 'import "../shared/kit.ts";\nexport const local = 2;\n');
await until(() => mine().some((event) => event.plugin === "one"), "one restart");
await sleep(600);
assert.deepEqual(mine().map((event) => event.plugin), ["one"], "only the plugin importing local.ts should restart");
assert.ok(changed.includes(local), `dev.source.changed should carry the changed file: ${JSON.stringify(changed)}`);

const firstPid = mine()[0]!.pid;
started.length = 0;
changed.length = 0;
writeFileSync(kit, "export const kit = 2;\n");
await until(() => mine().length >= 2, "both restart");
await sleep(600);
assert.deepEqual([...new Set(mine().map((event) => event.plugin))].sort(), ["one", "two"], "a shared dependency should restart both importers");
assert.notEqual(mine().find((event) => event.plugin === "one")!.pid, firstPid, "a restart is a new process");

const quietStarted = started.length;
const quietChanged = changed.length;
writeFileSync(ignored, "export const ignored = 2;\n");
await sleep(700);
assert.equal(changed.length, quietChanged, "an ignored directory publishes no dev.source.changed");
assert.equal(started.length, quietStarted, "an ignored directory triggers no restart");

assert.equal(await kernel.shutdown("kernel_exit"), 0);
console.log("hmr ok: module graph maps a change to exactly the plugins that import it");
