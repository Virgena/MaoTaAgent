import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture as fixtureBin, kernel as kernelBin } from "@virgena/blmoadll";

import { boot, KernelError, type Chunk, type Event } from "../src/index.ts";

const [blmoadllArg, fixtureArg] = process.argv.slice(2);
const blmoadll = blmoadllArg ?? kernelBin;
const fixture = fixtureArg ?? fixtureBin;
if (!blmoadll || !fixture) {
  throw new Error("usage: node packages/boot/host/tests/bridge.smoke.ts [blmoadll] [blmoadll-fixture] (defaults to node_modules/@virgena/blmoadll/bin)");
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextMatching(events: AsyncIterator<Event>, topic: string): Promise<Event> {
  for (;;) {
    const next = await Promise.race([
      events.next(),
      sleep(5000).then(() => Promise.reject(new Error(`timed out waiting for ${topic}`))),
    ]);
    if (next.done) throw new Error(`the event stream ended before ${topic} arrived`);
    if (next.value.topic === topic) return next.value;
  }
}

const dir = mkdtempSync(join(tmpdir(), "maota-bridge-"));
const config = join(dir, "blmoadll.toml");
writeFileSync(
  config,
  `
[plugins.provider]
command = '${fixture}'
args = ["--provides", "demo.text", "--chunks", "3"]

[plugins.doomed]
command = '${fixture}'
args = ["--provides", "demo.other", "--exit-on-invoke"]
`,
);

const logs: string[] = [];
const kernel = await boot(config, {
  bin: blmoadll,
  onLog: (line) => logs.push(String(line.message ?? "")),
});

const table = await kernel.capabilities();
assert.equal(table["demo.text"]?.plugin, "provider", "the capability table should list demo.text");

const echoed = (await kernel.invoke("demo.text", "echo", { hi: 1 })) as { got: { hi: number } };
assert.equal(echoed.got.hi, 1);
await assert.rejects(
  kernel.invoke("demo.nope", "echo"),
  (error: unknown) => error instanceof KernelError && error.code === -32010,
);

const chunks: Chunk[] = [];
for await (const chunk of await kernel.invoke("demo.text", "chat", {}, { stream: true })) chunks.push(chunk);
assert.deepEqual(chunks.map((chunk) => chunk.seq), [0, 1, 2, 3]);
assert.deepEqual(chunks[2]!.data, { delta: "c2" });
assert.equal(chunks[3]!.done, true);
assert.equal(chunks[3]!.data, null);

const one: Chunk[] = [];
for await (const chunk of await kernel.invoke("demo.text", "chat", {}, { stream: true })) {
  one.push(chunk);
  break;
}
assert.equal(one.length, 1, "only one chunk arrives before the break");
for (let i = 0; i < 100 && !logs.some((line) => line.includes("fixture: cancelled request=")); i += 1) await sleep(20);
assert.ok(
  logs.some((line) => line.includes("fixture: cancelled request=")),
  "leaving the stream should make the kernel send $/cancel to the plugin",
);

const events = kernel.subscribe(["kernel.plugin.*"])[Symbol.asyncIterator]();
const viaOn: string[] = [];
const off = kernel.on(["kernel.plugin.*"], (event) => viaOn.push(event.topic));
await tick();
await kernel.invoke("demo.text", "echo", {});

const refused = (await kernel.invoke("demo.other", "echo").catch((error: unknown) => error)) as KernelError;
assert.equal(refused.code, -32011, "that capability slot reports -32011 once the provider died");
const event = await nextMatching(events, "kernel.plugin.degraded");
assert.equal((event.payload as { plugin: string }).plugin, "doomed");
assert.ok(viaOn.includes("kernel.plugin.degraded"), "the on() path should receive the same event");

off();
await events.return?.(undefined);
assert.equal(await kernel.shutdown("kernel_exit"), 0, "a clean shutdown exits 0");
await sleep(50);
assert.ok(
  logs.some((line) => line.includes("fixture: shutdown reason=kernel_exit")),
  "the reason the host picked should reach the plugin",
);

console.log("bridge ok: boot / capabilities / invoke / stream / cancel / subscribe / on / shutdown(reason)");
