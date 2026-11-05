import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { frameReader } from "@maota/plugin-kit";

/// The kernel side of the pipe, played by this file. The host is spawned as the
/// kernel spawns it and speaks the same framing; no Rust and no profile are
/// involved, so the host's whole contract is checkable on any machine.

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const HOST = join(ROOT, "packages", "boot", "plugin-host", "lib", "index.js");
const KIT = pathToFileURL(join(ROOT, "packages", "plugin-kit", "lib", "index.js")).href;
const PATIENCE = 10_000;

interface Frame {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
  plugin?: string;
}

const scratch = mkdtempSync(join(tmpdir(), "maota-host-"));
const entries = new Map<string, string>();

function plugin(name: string, provides: string, methods: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "index.js");
  writeFileSync(
    entry,
    `import { isPluginEntry, runPlugin } from ${JSON.stringify(KIT)};\n` +
      `const definition = {\n` +
      `  provides: [${JSON.stringify(provides)}],\n` +
      `  injects: [],\n` +
      `  registrations: [],\n` +
      `  hostCalls: [],\n` +
      `  configKeys: [],\n` +
      `  methods: {\n${methods}\n  },\n` +
      `};\n` +
      `if (isPluginEntry(import.meta.url)) runPlugin(definition);\n`,
  );
  entries.set(name, entry);
  return entry;
}

const aMethod = `    ping: async (params, call) => { await call.channel.publish("demo.topic", { from: "a" }); return { plugin: "a", echo: params }; },
    boom: () => { setTimeout(() => { throw new Error("boom-from-a"); }, 0); return {}; },
    streamy: async (params, call) => { call.stream.push({ n: 1 }); },`;

const bMethod = `    ping: async (params) => ({ plugin: "b", echo: params }),`;

const aEntry = plugin("alpha", "demo.one", aMethod);
const bEntry = plugin("beta", "demo.two", bMethod);
const badEntry = plugin("broken", "demo.bad", `    ping: () => ({}),`);
writeFileSync(badEntry, "throw new Error('import exploded');\n");
const twiceEntry = plugin("twice", "demo.twice", `    ping: () => ({}),`);
writeFileSync(
  twiceEntry,
  `import { isPluginEntry, runPlugin } from ${JSON.stringify(KIT)};\n` +
    `const definition = { provides: ["demo.twice"], injects: [], registrations: [], hostCalls: [], configKeys: [], methods: {} };\n` +
    `if (isPluginEntry(import.meta.url)) { runPlugin(definition); runPlugin(definition); }\n`,
);

function frameOf(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

class Wire {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: Frame[] = [];
  private cursor = 0;
  private nextId = 1;
  private stderr = "";

  constructor() {
    this.child = spawn(process.execPath, [HOST], {
      env: { ...process.env, MAOTA_HOME: join(scratch, "home") },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on(
      "data",
      frameReader((body) => {
        const frame = JSON.parse(body.toString("utf8")) as Frame;
        this.frames.push(frame);
        this.answer(frame);
      }),
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  get log(): string {
    return this.stderr;
  }

  send(frame: Frame): void {
    this.child.stdin.write(frameOf(frame));
  }

  tagged(plugin: string, method: string, params: unknown): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params, plugin });
    return id;
  }

  control(method: string, params: unknown): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  /// The next frame, in the order the host wrote it, that `match` accepts. The
  /// frames a step does not assert stay in the log.
  async next(match: (frame: Frame) => boolean, what: string): Promise<Frame> {
    const deadline = Date.now() + PATIENCE;
    for (;;) {
      for (; this.cursor < this.frames.length; this.cursor += 1) {
        const frame = this.frames[this.cursor]!;
        if (match(frame)) {
          this.cursor += 1;
          return frame;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}\nframes: ${JSON.stringify(this.frames)}\nstderr: ${this.log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async reply(id: number): Promise<Frame> {
    return await this.next((frame) => Number(frame.id) === id, `reply ${id}`);
  }

  async exited(): Promise<number> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return await new Promise<number>((resolve) => this.child.once("exit", (code) => resolve(code ?? -1)));
  }

  /// The kernel answers what a plugin asks it; the host only has to tag it.
  private answer(frame: Frame): void {
    if (frame.plugin === undefined || frame.method === undefined || frame.id === undefined) return;
    if (!frame.method.startsWith("kernel.")) return;
    const result = frame.method === "kernel.subscribe" ? { subscription_id: "sub-1" } : {};
    this.send({ jsonrpc: "2.0", id: frame.id, result, plugin: frame.plugin });
  }
}

const wire = new Wire();

try {
  const pong = wire.control("$/host/ping", {});
  assert.deepEqual((await wire.reply(pong)).result, { pong: true }, "the control plane answers a ping before anything is loaded");

  for (const [id, entry, provides] of [
    ["a", aEntry, "demo.one"],
    ["b", bEntry, "demo.two"],
  ] as const) {
    const loaded = wire.control("$/host/load", { plugin: id, entry });
    const loading = await wire.next((frame) => frame.method === "$/host/loading" && frame.params?.plugin === id, `loading ${id}`);
    assert.equal(loading.plugin, undefined, "a control-plane frame is untagged");
    assert.deepEqual((await wire.reply(loaded)).result, {}, `${id} loads`);
    const init = wire.tagged(id, "initialize", { protocol: 3, plugin_id: id, config: {} });
    const initialized = await wire.reply(init);
    assert.equal(initialized.plugin, id, "the plugin's reply is tagged with its id");
    assert.deepEqual(initialized.result.provides, [provides]);
    const start = wire.tagged(id, "start", { capabilities: {} });
    assert.deepEqual((await wire.reply(start)).result, {});
  }

  const invoke = wire.tagged("a", "invoke", { capability: "demo.one", method: "ping", params: { x: 1 }, meta: { request_id: 1 } });
  const published = await wire.next(
    (frame) => frame.method === "kernel.publish" && frame.plugin === "a",
    "the publish the plugin made while answering",
  );
  assert.deepEqual(published.params, { topic: "demo.topic", payload: { from: "a" } });
  const answered = await wire.reply(invoke);
  assert.deepEqual(answered.result, { plugin: "a", echo: { x: 1 } });

  const stream = wire.tagged("a", "invoke", { capability: "demo.one", method: "streamy", params: {}, meta: { request_id: 2, stream: true } });
  const streamId = (await wire.reply(stream)).result.stream_id;
  assert.equal(typeof streamId, "string");
  const chunk = await wire.next((frame) => frame.method === "$/stream/chunk" && frame.plugin === "a", "a stream chunk");
  assert.equal(chunk.params.stream_id, streamId);
  const done = await wire.next((frame) => frame.method === "$/stream/chunk" && frame.params?.done === true, "the stream's terminal chunk");
  assert.equal(done.plugin, "a");

  const boom = wire.tagged("a", "invoke", { capability: "demo.one", method: "boom", params: {}, meta: { request_id: 3 } });
  await wire.reply(boom);
  const crash = await wire.next((frame) => frame.method === "$/host/crash", "the uncaught error report");
  assert.equal(crash.params.plugin, "a", "a detached timer error is attributed to the plugin that ran it");
  assert.match(String(crash.params.error), /boom-from-a/);
  const stillAlive = wire.control("$/host/ping", {});
  assert.deepEqual((await wire.reply(stillAlive)).result, { pong: true }, "an uncaught plugin error does not take the host down");

  const unload = wire.control("$/host/unload", { plugin: "a", reason: "manual" });
  const shutdownReply = await wire.next((frame) => frame.plugin === "a" && frame.id === "u-1", "the plugin's shutdown reply");
  assert.deepEqual(shutdownReply.result, {});
  const exited = await wire.next((frame) => frame.method === "$/host/exited" && frame.params?.plugin === "a", "the exit notice");
  assert.equal(exited.params.exit_code, 0);
  assert.deepEqual((await wire.reply(unload)).result, {});

  const reloaded = wire.control("$/host/load", { plugin: "a", entry: aEntry });
  await wire.next((frame) => frame.method === "$/host/loading" && frame.params?.plugin === "a", "the reload notice");
  assert.deepEqual((await wire.reply(reloaded)).result, {}, "a plugin reloads inside the same host");
  const reinit = wire.tagged("a", "initialize", { protocol: 3, plugin_id: "a", config: {} });
  assert.deepEqual((await wire.reply(reinit)).result.provides, ["demo.one"], "the reloaded graph answers initialize");

  const bad = wire.control("$/host/load", { plugin: "bad", entry: badEntry });
  await wire.next((frame) => frame.method === "$/host/loading" && frame.params?.plugin === "bad", "the broken load notice");
  const failure = await wire.next((frame) => frame.method === "$/host/failed" && frame.params?.plugin === "bad", "the failed load notice");
  assert.match(String(failure.params.message), /import exploded/);
  const badReply = await wire.reply(bad);
  assert.equal(badReply.error?.code, -32022);

  const twice = wire.control("$/host/load", { plugin: "twice", entry: twiceEntry });
  await wire.next((frame) => frame.method === "$/host/loading" && frame.params?.plugin === "twice", "the twice load notice");
  await wire.next((frame) => frame.method === "$/host/failed" && frame.params?.plugin === "twice", "the twice failure notice");
  const twiceReply = await wire.reply(twice);
  assert.equal(twiceReply.error?.code, -32022);
  assert.match(String(twiceReply.error?.message), /started twice/);

  const kill = wire.control("$/host/kill", { plugin: "b" });
  const killed = await wire.next((frame) => frame.method === "$/host/exited" && frame.params?.plugin === "b", "the kill notice");
  assert.equal(killed.params.killed, true);
  assert.deepEqual((await wire.reply(kill)).result, {});

  wire.child.stdin.end();
  const code = await wire.exited();
  assert.equal(code, 0, "a host whose kernel closed the pipe exits cleanly");
  console.log("host ok: load, initialize, invoke, stream, publish, crash, reload, failure, kill, shutdown");
} catch (error) {
  wire.child.kill();
  throw error;
}

