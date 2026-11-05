/// The Plugin Process: one child, one pipe, every plugin instance inside it.
/// The control plane is the one `plugin-host` already speaks; the runtime relays
/// the plugin protocol through the same pipe with a `plugin` tag on each frame.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { frameReader } from "@maota/plugin-kit";

export const HOST_METHOD = {
  LOAD: "$/host/load",
  UNLOAD: "$/host/unload",
  KILL: "$/host/kill",
  PING: "$/host/ping",
  LOADING: "$/host/loading",
  EXITED: "$/host/exited",
  FAILED: "$/host/failed",
  CRASH: "$/host/crash",
  STUCK: "$/host/stuck",
  FATAL: "$/host/fatal",
} as const;

export const HOST_FAILED = -32022;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface HostFrame {
  plugin?: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: Record<string, unknown>;
}

export interface Report {
  method: string;
  params: Record<string, unknown>;
}

const ERROR_CODE = -32011;

export class PluginProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly frames = new Set<(frame: HostFrame) => void>();
  private readonly reports = new Set<(report: Report) => void>();
  private readonly exits = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private nextId = 0;
  private dead: Error | null = null;

  static start(entry: string, env: NodeJS.ProcessEnv): PluginProcess {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    return new PluginProcess(child);
  }

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const read = frameReader((body) => this.dispatch(body));
    child.stdout.on("data", read);
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error: Error) => this.fail(new Error(`plugin process: ${error.message}`)));
    child.on("exit", (code, signal) => {
      this.fail(new Error(`plugin process exited (code ${String(code)}, signal ${String(signal)})`));
      for (const handler of this.exits) handler(code, signal);
    });
  }

  onFrame(handler: (frame: HostFrame) => void): void {
    this.frames.add(handler);
  }

  onReport(handler: (report: Report) => void): void {
    this.reports.add(handler);
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exits.add(handler);
  }

  request(method: string, params: unknown, plugin?: string): Promise<unknown> {
    if (this.dead !== null) return Promise.reject(this.dead);
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params, ...(plugin === undefined ? {} : { plugin }) });
    });
  }

  notify(method: string, params: unknown, plugin?: string): void {
    this.write({ jsonrpc: "2.0", method, params, ...(plugin === undefined ? {} : { plugin }) });
  }

  /// Answers a request a plugin made through the shared pipe.
  respond(plugin: string, id: string | number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result, plugin });
  }

  respondError(plugin: string, id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message }, plugin });
  }

  kill(): void {
    this.child.kill();
  }

  private write(frame: unknown): void {
    if (this.dead !== null) return;
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private dispatch(body: Buffer): void {
    let frame: HostFrame;
    try {
      frame = JSON.parse(body.toString("utf8")) as HostFrame;
    } catch {
      return;
    }
    const plugin = typeof frame.plugin === "string" ? frame.plugin : "";
    if (plugin !== "") {
      if (typeof frame.id === "number") {
        const pending = this.pending.get(frame.id);
        if (pending === undefined) return;
        this.pending.delete(frame.id);
        if (frame.error !== undefined) {
          pending.reject(
            new Error(`plugin ${plugin}: ${String(frame.error.message ?? "failed")}`),
          );
        } else {
          pending.resolve(frame.result ?? null);
        }
        return;
      }
      for (const handler of this.frames) handler(frame);
      return;
    }
    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      this.pending.delete(frame.id);
      if (frame.error !== undefined) {
        pending.reject(
          new Error(`host: ${String(frame.error.message ?? "failed")} (${String(frame.error.code ?? ERROR_CODE)})`),
        );
      } else {
        pending.resolve(frame.result ?? null);
      }
      return;
    }
    if (typeof frame.method === "string") {
      for (const handler of this.reports) handler({ method: frame.method, params: frame.params ?? {} });
    }
  }

  private fail(error: Error): void {
    if (this.dead !== null) return;
    this.dead = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
