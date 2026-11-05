import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { frameReader } from "@maota/plugin-kit";

/// The kernel side of the pipe, played by this file. The Runtime is spawned the
/// way the kernel spawns it and speaks the same framing; the Plugin Process it
/// starts is real, so the whole Kernel -> Runtime -> Plugin Process path is
/// exercised without a profile or a Rust binary.

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const RUNTIME = join(ROOT, "packages", "boot", "runtime", "lib", "index.js");
const KIT = pathToFileURL(join(ROOT, "packages", "plugin-kit", "lib", "index.js")).href;
const PATIENCE = 15_000;
const SNAPSHOT_STATES = ["starting", "ready", "recovering", "quarantined", "failed"];

interface Frame {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
  plugin?: string;
}

const scratch = mkdtempSync(join(tmpdir(), "maota-runtime-"));
const installRoot = join(scratch, "install");
const profileDir = join(scratch, "profiles", "default");
mkdirSync(installRoot, { recursive: true });
mkdirSync(profileDir, { recursive: true });

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, undefined, 2) + "\n");
}

function linkPackage(root: string, name: string, target: string): void {
  const link = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}

function plugin(name: string, provides: string, methods: string, preamble = ""): string {
  const dir = join(scratch, "plugins", name.replace("/", "-"));
  writeJson(join(dir, "package.json"), {
    name,
    version: "0.1.0",
    type: "module",
    main: "index.js",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  });
  writeFileSync(
    join(dir, "index.js"),
    `import { isPluginEntry, runPlugin } from ${JSON.stringify(KIT)};\n` +
      preamble +
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
  return dir;
}

const kitDir = join(scratch, "plugins", "plugin-kit");
writeJson(join(kitDir, "package.json"), { name: "@maota/plugin-kit", version: "0.1.0", type: "module" });
linkPackage(installRoot, "@maota/plugin-kit", kitDir);

const alpha = plugin(
  "@scratch/alpha",
  "demo.one",
  `    ping: async (params, call) => { await call.channel.publish("demo.topic", { from: "alpha" }); return { plugin: "alpha", echo: params }; },\n` +
    `    watch: async (params, call) => { if (!watching) { await call.channel.subscribe(["demo.topic"], (topic, seq, payload) => { last = { topic, payload }; }); watching = true; } return {}; },\n` +
    `    seen: async () => ({ last }),\n` +
    `    die: () => { process.exit(3); },`,
  `let last = null;\nlet watching = false;\n`,
);
const beta = plugin(
  "@scratch/beta",
  "demo.two",
  `    ping: async (params) => ({ plugin: "beta", echo: params }),\n` +
    `    emit: async (params, call) => { await call.channel.publish("demo.topic", { from: "beta" }); return {}; },`,
);
const gamma = plugin("@scratch/gamma", "demo.three", `    ping: async () => ({ plugin: "gamma" }),`);

const bundleDir = join(scratch, "bundles", "core");
writeJson(join(bundleDir, "package.json"), {
  name: "@scratch/core",
  version: "0.1.0",
  type: "module",
  maota: { bundle: { patch: "./patch.toml", protocol: 3 } },
  dependencies: {
    "@scratch/alpha": "workspace:*",
    "@scratch/beta": "workspace:*",
    "@scratch/gamma": "workspace:*",
  },
  peerDependencies: { "@maota/plugin-kit": "^0.1.0" },
});
writeFileSync(
  join(bundleDir, "patch.toml"),
  "[[patch]]\n" +
    'insert = [\n' +
    '  { id = "alpha", name = "@scratch/alpha" },\n' +
    '  { id = "beta", name = "@scratch/beta" },\n' +
    '  { id = "off", name = "@scratch/gamma", disabled = true },\n' +
    "]\n",
);
for (const [name, dir] of [
  ["@scratch/alpha", alpha],
  ["@scratch/beta", beta],
  ["@scratch/gamma", gamma],
] as const) {
  linkPackage(bundleDir, name, dir);
  linkPackage(profileDir, name, dir);
}
linkPackage(profileDir, "@scratch/core", bundleDir);

writeJson(join(profileDir, "package.json"), {
  name: "maota-profile-default",
  private: true,
  maota: { profile: { bundles: ["@scratch/core"] } },
});

const configPath = join(scratch, "profile.toml");
writeFileSync(configPath, "[runtime]\nhost_restarts = 2\nhost_restart_window_ms = 600000\n");

function frameOf(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

class Wire {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: Frame[] = [];
  stderr = "";
  private readonly waiters: Array<{ test: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  private nextId = 1;

  constructor() {
    this.child = spawn(process.execPath, [RUNTIME, profileDir, installRoot, "default"], {
      env: {
        ...process.env,
        MAOTA_HOME: join(scratch, "home"),
        BLMOADLL_CONFIG: configPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on(
      "data",
      frameReader((body) => {
        const frame = JSON.parse(body.toString("utf8")) as Frame;
        this.frames.push(frame);
        for (const waiter of [...this.waiters]) {
          if (!waiter.test(frame)) continue;
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }),
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  wait(test: (frame: Frame) => boolean, timeout = PATIENCE): Promise<Frame> {
    const found = this.frames.find(test);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`runtime sent nothing within ${String(timeout)} ms; stderr:\n${this.stderr}`));
      }, timeout);
      this.waiters.push({
        test,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  send(value: unknown): void {
    this.child.stdin.write(frameOf(value));
  }

  request(method: string, params: Record<string, unknown>, timeout = PATIENCE): Promise<Frame> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.wait((frame) => frame.id === id, timeout);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise<number | null>((resolve) => {
      this.child.on("exit", (code) => resolve(code));
    });
  }
}

const wire = new Wire();
let failures = 0;

async function waitForStderr(pattern: RegExp, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!pattern.test(wire.stderr)) {
    if (Date.now() - started > timeout) {
      throw new Error(`stderr never matched ${String(pattern)}; stderr:\n${wire.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

try {
  const ready = await wire.wait((frame) => frame.method === "$/runtime/ready");
  assert.equal(ready.params?.v, 1, "the first frame is the runtime's protocol version");

  const first = await wire.wait((frame) => frame.method === "$/runtime/capabilities");
  assert.equal(first.params?.v, 1);
  const table = first.params?.table ?? {};
  assert.deepEqual(Object.keys(table).sort(), ["demo.one", "demo.two"], "only the enabled rows register");
  assert.equal(table["demo.one"]?.plugin, "alpha");

  const plugins: Array<{ id: string; state: string }> = first.params?.plugins ?? [];
  assert.deepEqual(
    plugins.map((row) => row.id).sort(),
    ["alpha", "beta"],
    "a disabled row is not in the snapshot at all",
  );
  for (const row of plugins) {
    assert.ok(
      SNAPSHOT_STATES.includes(row.state),
      `${row.id} carries ${row.state}, which the kernel would reject`,
    );
    assert.equal(row.state, "ready");
  }

  const ping = await wire.request("invoke", {
    capability: "demo.one",
    method: "ping",
    params: { n: 1 },
  });
  assert.equal(ping.error, undefined, `invoke failed: ${JSON.stringify(ping.error)}`);
  assert.deepEqual(ping.result, { plugin: "alpha", echo: { n: 1 } });

  const published = await wire.wait(
    (frame) => frame.method === "$/runtime/event" && frame.params?.topic === "demo.topic",
  );
  assert.equal(published.params?.plugin, "alpha", "a plugin's publish names the plugin");
  assert.deepEqual(published.params?.payload, { from: "alpha" });

  // A plugin's subscribe reaches a sibling's publish in the same Plugin Process.
  await wire.request("invoke", { capability: "demo.one", method: "watch", params: {} });
  await wire.request("invoke", { capability: "demo.two", method: "emit", params: {} });
  const seen = await wire.request("invoke", { capability: "demo.one", method: "seen", params: {} });
  assert.deepEqual(seen.result, {
    last: { topic: "demo.topic", payload: { from: "beta" } },
  });

  const restarted = await wire.request("restart", { plugin: "alpha", reason: "manual" });
  assert.deepEqual(restarted.result, {});
  await wire.wait(
    (frame) =>
      frame.method === "$/runtime/capabilities" &&
      (frame.params?.plugins ?? []).some((row: { id: string; state: string }) => row.id === "alpha" && row.state === "ready"),
  );

  // A plugin that takes the whole Plugin Process down: the Runtime restarts it
  // and every plugin comes back, instead of ending the run.
  void wire.request("invoke", { capability: "demo.one", method: "die", params: {} }).catch(() => undefined);
  const recovered = await wire.wait(
    (frame) =>
      frame.method === "$/runtime/capabilities" &&
      (frame.params?.plugins ?? []).length === 2 &&
      (frame.params?.plugins ?? []).every((row: { state: string }) => row.state === "ready"),
    20_000,
  );
  assert.equal((recovered.params?.table ?? {})["demo.two"]?.plugin, "beta");
  await waitForStderr(/restarting it/);

  const shutdown = await wire.request("shutdown", { reason: "ui_quit" });
  assert.deepEqual(shutdown.result, {});
  const code = await wire.close();
  assert.equal(code, 0, `the runtime should exit 0 on shutdown; stderr:\n${wire.stderr}`);
} catch (error) {
  failures = 1;
  wire.child.kill();
  throw error;
} finally {
  if (failures === 1) wire.child.kill();
}

console.log("runtime ok: snapshot states, invoke, publish, subscribe, restart, plugin-process recovery, shutdown");
