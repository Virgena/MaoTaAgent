#!/usr/bin/env node
/// The Runtime: the one process between the kernel and the Plugin Process.
///
///     node lib/index.js <config> <profile-dir> <install-anchor> [profile]
///
/// It discovers the plugin set from the profile's bundles, starts one Plugin
/// Process, loads and starts every plugin in it, registers the capability table
/// with the kernel, and routes calls. The kernel never sees a plugin.
///
/// `--check` validates what can be validated without starting anything: every
/// row resolves to an entry file.

import { createRequire } from "node:module";

import { discover, limitsFrom } from "./discovery.ts";
import { PluginProcess } from "./process.ts";
import type { Fail, Reply } from "./trunk.ts";
import { Trunk } from "./trunk.ts";
import { Registry } from "./registry.ts";

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const [profileDir, installAnchor, profile] = argv.filter((item) => !item.startsWith("--"));
const configPath = process.env["BLMOADLL_CONFIG"] ?? "";
if (profileDir === undefined) {
  process.stderr.write("runtime: usage: runtime <profile-dir> <install-anchor> [profile] [--check]\n");
  process.exit(2);
}

const rows = await discover(profileDir, installAnchor ?? profileDir, profile ?? "default", configPath);

if (check) {
  const missing = rows.filter((row) => !row.disabled && row.entry === "");
  if (missing.length > 0) {
    process.stderr.write(`runtime: ${missing.map((row) => row.id).join(", ")} cannot resolve an entry\n`);
    process.exit(1);
  }
  process.stdout.write(`runtime check ok: ${rows.filter((row) => !row.disabled).length} plugins\n`);
  process.exit(0);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostEntry(): string {
  return createRequire(import.meta.url).resolve("@maota/plugin-host");
}

const limits = limitsFrom(configPath);
const enabled = rows.filter((row) => !row.disabled).length;

const trunk = Trunk.start();
trunk.send("$/runtime/ready", { v: 1 });

let host = PluginProcess.start(hostEntry(), process.env);
const registry = new Registry(rows, host, trunk);
let exiting = false;
let stopping = false;
let recoveries: number[] = [];

function stop(code: number): void {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

function wire(process_: PluginProcess): void {
  process_.onReport((report) => {
    if (stopping || exiting) return;
    if (report.method === "$/host/loading") return;
    const plugin = typeof report.params["plugin"] === "string" ? report.params["plugin"] : "";
    const message =
      typeof report.params["message"] === "string" ? report.params["message"] : report.method;
    if (report.method === "$/host/crash" || report.method === "$/host/failed") {
      registry.degrade(plugin === "" ? "runtime" : plugin, message);
      return;
    }
    if (report.method === "$/host/exited") {
      if (plugin !== "") {
        const code = report.params["exit_code"];
        registry.degrade(plugin, `the plugin exited (code ${String(code ?? -1)})`);
      }
      return;
    }
    if (report.method === "$/host/stuck") {
      if (plugin !== "") {
        registry.degrade(plugin, `close did not finish (stage ${String(report.params["stage"] ?? "?")})`);
      }
      return;
    }
    // `$/host/fatal` is followed by exit code 70: recovery belongs to onExit.
  });
  process_.onExit((code) => {
    if (stopping || exiting) return;
    void recover(code);
  });
}

/// One Plugin Process died: restart it and reload the set, up to the budget of
/// the kernel's `host_restarts` window. Past the budget the run is over.
async function recover(code: number | null): Promise<void> {
  const now = Date.now();
  recoveries = recoveries.filter((at) => now - at < limits.windowMs);
  if (recoveries.length >= limits.restarts) {
    process.stderr.write(
      `runtime: the plugin process exited (code ${String(code)}) and the restart budget is spent\n`,
    );
    registry.publish("kernel.runtime.status", { state: "failed", ready: 0, total: enabled });
    stop(1);
    return;
  }
  recoveries.push(now);
  process.stderr.write(
    `runtime: the plugin process exited (code ${String(code)}); restarting it\n`,
  );
  try {
    host = PluginProcess.start(hostEntry(), process.env);
    registry.rebind(host);
    wire(host);
    await registry.boot();
  } catch (error) {
    process.stderr.write(`runtime: restarting the plugin process failed: ${messageOf(error)}\n`);
    registry.publish("kernel.runtime.status", { state: "failed", ready: 0, total: enabled });
    stop(1);
  }
}

wire(host);

trunk.onNotice((method, params) => {
  if (method === "$/cancel") {
    const stream = typeof params["stream_id"] === "string" ? params["stream_id"] : "";
    registry.cancel(stream);
    return;
  }
  if (method === "$/runtime/subscribe") {
    if (params["replay"] === true) {
      for (const row of registry.running()) {
        registry.publish("kernel.plugin.started", {
          plugin: row.id,
          pid: host.child.pid ?? null,
          trigger: "boot",
          cwd: process.cwd(),
          command: process.execPath,
          args: [row.entry],
        });
      }
    }
    return;
  }
  if (method === "$/runtime/unsubscribe") return;
});

trunk.onRequest((request, reply: Reply, fail: Fail) => {
  const params = request.params;
  switch (request.method) {
    case "invoke":
      void registry.invoke(params, reply, fail);
      return;
    case "restart": {
      const plugin = typeof params["plugin"] === "string" ? params["plugin"] : "";
      const reason = typeof params["reason"] === "string" ? params["reason"] : "manual";
      registry.restart(plugin, reason).then(
        () => reply({}),
        (error: unknown) => fail(-32011, messageOf(error), { plugin }),
      );
      return;
    }
    case "status":
      reply(registry.status());
      return;
    case "capabilities":
      reply({});
      return;
    case "shutdown": {
      const reason = typeof params["reason"] === "string" ? params["reason"] : "ui_quit";
      stopping = true;
      registry.shutdown(reason).then(
        () => {
          reply({});
          stop(0);
        },
        (error: unknown) => {
          fail(-32603, messageOf(error));
          stop(1);
        },
      );
      return;
    }
    default:
      fail(-32601, `unknown method ${request.method}`);
  }
});

trunk.onClose(() => {
  if (stopping) return;
  stopping = true;
  void registry.shutdown("kernel_exit").finally(() => stop(0));
});

try {
  await registry.boot();
} catch (error) {
  process.stderr.write(`runtime: boot failed: ${messageOf(error)}\n`);
  stop(1);
}
