#!/usr/bin/env node
/// Cold-start cost of one serve-profile boot: the time from spawning the kernel
/// to the capability table, the kernel's process tree at steady state, and the
/// working set that tree holds. Prints JSON so a before and an after are
/// compared as numbers instead of prose.
///
///     node scripts/tests/boot-cost.ts [--runs <n>] [--config <path>] [--json]
///
/// The profile's generated config is refreshed first, exactly as `maota serve`
/// would, so the run measures the config this checkout produces today.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { frameReader } from "@maota/plugin-kit";

import { resolveConfigPath, resolveKernelBin } from "../../packages/boot/app-boot/src/index.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI_ROOT = join(ROOT, "apps", "cli");
const RUN_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT_MS = 15_000;

interface Options {
  runs: number;
  config: string | undefined;
  json: boolean;
}

function options(argv: string[]): Options {
  const found: Options = { runs: 5, config: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") found.json = true;
    else if (flag === "--runs") found.runs = Number(argv[++i]);
    else if (flag === "--config") found.config = argv[++i];
  }
  if (!Number.isInteger(found.runs) || found.runs < 1) found.runs = 5;
  return found;
}

interface Proc {
  pid: number;
  parent: number;
  rss: number;
}

/// One snapshot of every process the current user can see. Windows only: the
/// other platforms have no equivalent one-shot command here, so the tree is
/// reported as unknown instead of guessed.
function snapshot(): Proc[] | null {
  if (process.platform !== "win32") return null;
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize }";
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 << 20,
  });
  if (run.status !== 0) return null;
  const procs: Proc[] = [];
  for (const line of (run.stdout ?? "").split(/\r?\n/)) {
    const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || parent === undefined || rss === undefined) continue;
    if (!Number.isInteger(pid) || !Number.isInteger(parent) || !Number.isFinite(rss)) continue;
    procs.push({ pid, parent, rss });
  }
  return procs;
}

interface Tree {
  processes: number;
  rss: number;
}

function treeOf(rootPid: number): Tree | null {
  const procs = snapshot();
  if (procs === null) return null;
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const proc of procs) {
    rss.set(proc.pid, proc.rss);
    const list = children.get(proc.parent) ?? [];
    list.push(proc.pid);
    children.set(proc.parent, list);
  }
  if (!rss.has(rootPid)) return null;
  let processes = 0;
  let bytes = 0;
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    processes += 1;
    bytes += rss.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return { processes, rss: bytes };
}

interface Outcome {
  ms: number;
  tree: Tree | null;
}

class KernelLink {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private next = 0;
  private readonly stderrTail: string[] = [];
  private buffer = "";

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on(
      "data",
      frameReader((body) => {
        let frame: any;
        try {
          frame = JSON.parse(body.toString("utf8"));
        } catch {
          return;
        }
        this.settle(frame);
      }),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
  }

  get log(): string {
    return this.stderrTail.join("\n");
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} was never answered`));
      }, RUN_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.child.stdin.write(body);
    });
  }

  fail(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }

  private settle(frame: any): void {
    const id = Number(frame?.id);
    const call = this.pending.get(id);
    if (call === undefined) return;
    this.pending.delete(id);
    if (frame.error) call.reject(new Error(String(frame.error.message ?? "kernel error")));
    else call.resolve(frame.result);
  }
}

function timeout(ms: number, why: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(why)), ms).unref();
  });
}

async function once(config: string, bin: string): Promise<Outcome> {
  const started = performance.now();
  const child = spawn(bin, [config], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const link = new KernelLink(child);
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  void exited.then((code) => link.fail(new Error(`kernel exited (${code})`)));

  try {
    const capped = timeout(RUN_TIMEOUT_MS, "boot took too long").catch((error: Error) => {
      throw new Error(`${error.message}\n${link.log}`);
    });
    await Promise.race([link.request("capabilities", {}), capped]);
    const ms = performance.now() - started;
    const tree = treeOf(child.pid ?? 0);
    await Promise.race([link.request("shutdown", { reason: "ui_quit" }), timeout(EXIT_TIMEOUT_MS, "shutdown was never answered")]).catch(
      () => undefined,
    );
    await Promise.race([exited, timeout(EXIT_TIMEOUT_MS, "the kernel did not exit")]).catch(() => {
      child.kill();
    });
    return { ms, tree };
  } catch (error) {
    child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${link.log.slice(-2000)}`);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function rowsOf(config: string): number {
  const text = readFileSync(config, "utf8");
  return [...text.matchAll(/^\[plugins\.[^.[\]]+\]$/gm)].length;
}

const chosen = options(process.argv.slice(2));
const config = chosen.config ?? (await resolveConfigPath({ profile: "serve", root: CLI_ROOT }));
if (!existsSync(config)) {
  console.error(`boot-cost: no config at ${config}`);
  process.exit(2);
}
const bin = resolveKernelBin({});

process.stderr.write(`boot-cost: ${chosen.runs} cold starts of ${config}\n`);
const outcomes: Outcome[] = [];
for (let run = 1; run <= chosen.runs; run += 1) {
  const outcome = await once(config, bin);
  outcomes.push(outcome);
  process.stderr.write(
    `  run ${run}: ${outcome.ms.toFixed(0)} ms, ` +
      `${outcome.tree === null ? "tree unknown" : `${outcome.tree.processes} processes, ${(outcome.tree.rss / 1048576).toFixed(1)} MiB`}\n`,
  );
}

const times = outcomes.map((outcome) => outcome.ms);
const known = outcomes.flatMap((outcome) => (outcome.tree === null ? [] : [outcome.tree]));
const report = {
  config,
  rows: rowsOf(config),
  runs: chosen.runs,
  time_to_capabilities_ms: { median: median(times), all: times },
  processes: { median: median(known.map((tree) => tree.processes)), all: known.map((tree) => tree.processes) },
  rss_mib: {
    median: median(known.map((tree) => tree.rss)) / 1048576,
    all: known.map((tree) => tree.rss / 1048576),
  },
};
if (chosen.json) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(
    `rows ${report.rows}, time to capability table ${report.time_to_capabilities_ms.median.toFixed(0)} ms, ` +
      `${report.processes.median} processes, ${report.rss_mib.median.toFixed(1)} MiB\n`,
  );
}
