import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Channel } from "./channel.ts";
import {
  canonicalPath,
  hostAdapter,
  installHostAdapter,
  type Adoptable,
  type HostAdapter,
  type Transport,
} from "./host.ts";
import { isPluginEntry, serve, type Definition } from "./plugin.ts";

installHostAdapter(null);
assert.equal(hostAdapter(), null, "no host adapter is installed by default");

const scratch = mkdtempSync(join(tmpdir(), "plugin-kit-host-"));
const entryFile = join(scratch, "entry.mjs");
writeFileSync(entryFile, "export {};\n");
const entryUrl = pathToFileURL(entryFile).href;
const real = realpathSync.native(entryFile);
const folded = process.platform === "win32" ? real.toLowerCase() : real;
assert.equal(canonicalPath(entryUrl), folded, "a module URL resolves to the real file");
assert.equal(canonicalPath(real), folded, "a plain path resolves to the same real file");
assert.equal(canonicalPath(join(scratch, "missing.mjs")), null, "a path that does not exist has no canonical form");

assert.equal(isPluginEntry(entryUrl, entryFile), true, "the file the process was started with is the entry");
assert.equal(isPluginEntry(entryUrl, join(scratch, "other.mjs")), false, "another file is not the entry");
assert.equal(isPluginEntry(entryUrl, undefined), false, "no started file means not the entry");

const adopted: { value: { definition: Definition; channel: Adoptable } | null } = { value: null };
let expected: string | null = null;
const adapter: HostAdapter = {
  expecting(moduleUrl) {
    return expected !== null && canonicalPath(moduleUrl) === canonicalPath(expected);
  },
  adopt(definition, channel) {
    adopted.value = { definition, channel };
  },
};
installHostAdapter(adapter);
assert.equal(hostAdapter(), adapter, "the adapter is visible through the global symbol");

assert.equal(
  isPluginEntry(entryUrl, join(scratch, "other.mjs")),
  false,
  "with no adapter the main script still decides",
);
expected = entryFile;
assert.equal(isPluginEntry(entryUrl, "nothing.mjs"), true, "an adopted module is the entry whatever argv says");
expected = null;
assert.equal(isPluginEntry(entryUrl, "nothing.mjs"), false, "a module the host is not loading is not the entry");

interface Written {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

const written: Written[] = [];
const exits: number[] = [];
const transport: Transport = {
  write: (frame) => written.push(frame as Written),
  exit: (code) => exits.push(code),
};
const channel = new Channel({ request: () => {}, notification: () => {}, event: () => {} });
channel.attach(transport);
channel.notify("kernel.log", { level: "info", message: "hello" });
assert.deepEqual([...written], [{ jsonrpc: "2.0", method: "kernel.log", params: { level: "info", message: "hello" } }]);

channel.deliver(Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "$/event", params: { topic: "demo.a", seq: 1 } })));
assert.equal(written.length, 1, "a notification the channel does not answer writes nothing");

const definition: Definition = {
  provides: ["demo"],
  injects: [],
  registrations: [],
  hostCalls: [],
  configKeys: [],
  methods: { ping: () => ({ pong: true }) },
};
serve(definition);
if (adopted.value === null) throw new Error("serve did not hand the plugin to the adapter");
const bound = adopted.value;
assert.equal(bound.definition, definition, "the adapter receives the definition the module declared");
bound.channel.attach(transport);

bound.channel.deliver(
  Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocol: 3, plugin_id: "demo", config: {} },
    }),
  ),
);
await new Promise((resolve) => setImmediate(resolve));
const initialized = written.at(-1);
assert.equal(initialized?.id, 1);
assert.equal(initialized?.result?.protocol, 3);
assert.deepEqual(initialized?.result?.provides, ["demo"]);

bound.channel.deliver(
  Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "invoke", params: { capability: "demo", method: "ping", params: {}, meta: {} } }),
  ),
);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(written.at(-1)?.result, { pong: true });

const started = written.length;
bound.channel.deliver(
  Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "shutdown", params: { reason: "manual" } })),
);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(written.length, started + 1, "shutdown answers before it exits");
assert.deepEqual(exits, [0], "shutdown asks the transport to exit rather than the process");

installHostAdapter(null);
assert.equal(hostAdapter(), null, "the adapter can be removed");

console.log("ok   plugin-kit host: adapter, canonical entry, transport and adoption");
