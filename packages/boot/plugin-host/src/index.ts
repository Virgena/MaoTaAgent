/// The extension host: one process for every Node plugin, one pipe to the kernel.
///
/// fd 1 is the kernel protocol and nothing else. Any write a plugin makes to
/// stdout is redirected to stderr, which the kernel forwards as a host log, so a
/// `console.log` can never split a frame. fd 0 carries the kernel's frames:
/// untagged ones are the control plane, tagged ones belong to a plugin.

import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { frameReader, installHostAdapter } from "@maota/plugin-kit";

import { HOST_METHOD } from "./control.ts";
import { HostError, Members, textOf } from "./members.ts";
import { createOutbound } from "./outbound.ts";

const outbound = createOutbound();
protectPipe();
enableCompileCacheSafely();

const members = new Members(outbound);
installHostAdapter(members.adapter());

process.on("uncaughtException", (error) => members.crash(error, members.attribution()));
process.on("unhandledRejection", (reason) => members.crash(reason, members.attribution()));

const read = frameReader((body) => {
  let frame: any;
  try {
    frame = JSON.parse(body.toString("utf8"));
  } catch {
    fatal("the kernel sent a frame that is not JSON");
    return;
  }
  dispatch(frame, body);
});

process.stdin.on("data", (chunk: Buffer) => {
  try {
    read(chunk);
  } catch (error) {
    fatal(`reading a frame from the kernel failed: ${textOf(error)}`);
  }
});
// The kernel closed our stdin: a host without a kernel has nothing to serve.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));

function dispatch(frame: any, body: Buffer): void {
  const plugin = typeof frame?.plugin === "string" ? frame.plugin : "";
  if (plugin !== "") {
    members.deliver(plugin, body);
    return;
  }
  if (typeof frame?.method === "string") {
    control(frame);
    return;
  }
  process.stderr.write("plugin-host: an untagged response arrived; the host makes no calls\n");
}

function control(frame: { id?: unknown; method: string; params?: unknown }): void {
  const id = frame.id;
  const params = (frame.params ?? {}) as Record<string, unknown>;
  const plugin = typeof params.plugin === "string" ? params.plugin : "";
  switch (frame.method) {
    case HOST_METHOD.LOAD: {
      const entry = typeof params.entry === "string" ? params.entry : "";
      void members.load(plugin, entry).then(
        () => reply(id, {}),
        (error: unknown) => fail(id, error),
      );
      return;
    }
    case HOST_METHOD.UNLOAD: {
      const reason = typeof params.reason === "string" ? params.reason : "";
      void members.unload(plugin, reason).then(
        () => reply(id, {}),
        (error: unknown) => fail(id, error),
      );
      return;
    }
    case HOST_METHOD.KILL:
      members.kill(plugin);
      reply(id, {});
      return;
    case HOST_METHOD.PING:
      reply(id, { pong: true });
      return;
    default:
      fail(id, new HostError(`unknown host method ${frame.method}`));
  }
}

function reply(id: unknown, result: unknown): void {
  if (id === undefined || id === null) return;
  outbound.write({ jsonrpc: "2.0", id, result });
}

function fail(id: unknown, error: unknown): void {
  if (id === undefined || id === null) {
    process.stderr.write(`plugin-host: ${textOf(error)}\n`);
    return;
  }
  const code = error instanceof HostError ? error.code : -32603;
  outbound.write({ jsonrpc: "2.0", id, error: { code, message: textOf(error) } });
}

/// The kernel is gone, or the pipe is unusable. Say so once and leave: keeping
/// the process alive would leave the kernel's plugin set in the dark.
function fatal(message: string): void {
  process.stderr.write(`plugin-host: ${message}\n`);
  try {
    outbound.write({ jsonrpc: "2.0", method: HOST_METHOD.FATAL, params: { message } });
  } catch {
    // Nothing left to tell anyone.
  }
  process.exit(70);
}

function protectPipe(): void {
  process.stdout.write = ((chunk: any, encoding?: any, callback?: any) =>
    process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
}

function enableCompileCacheSafely(): void {
  try {
    const home = process.env.MAOTA_HOME ?? join(homedir(), ".maota");
    enableCompileCache(join(home, "compile-cache"));
  } catch {
    // A home that cannot hold a cache costs startup time, not correctness.
  }
}
