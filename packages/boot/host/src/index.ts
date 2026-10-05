
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface KernelOptions {
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: Record<string, unknown>) => void;
}

export interface Chunk {
  stream_id: string;
  seq: number;
  data: unknown;
  done: boolean;
  error?: { code: number; message: string; data?: unknown };
}

export interface Event {
  topic: string;
  seq: number;
  payload: unknown;
}

export class KernelError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.data = data;
  }
}

const HEADER_END = Buffer.from("\r\n\r\n");
const PAUSE_BYTES = 1 << 20;
const RESUME_BYTES = 1 << 18;

interface Call {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Sink {
  patterns: string[];
  queue: Queue<Event>;
}

interface WireFrame {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class Queue<T> implements AsyncIterable<T> {
  private readonly onTake: () => void;
  private items: Array<{ value: T; bytes: number }> = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private queued = 0;
  private done = false;

  constructor(onTake: () => void = () => {}) {
    this.onTake = onTake;
  }

  push(value: T, bytes = 0): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      this.onTake();
      return;
    }
    this.items.push({ value, bytes });
    this.queued += bytes;
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  get pendingBytes(): number {
    return this.queued;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const head = this.items.shift();
      if (head) {
        this.queued -= head.bytes;
        this.onTake();
        yield head.value;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

function contentLength(head: Buffer): number | null {
  for (const line of head.toString("utf8").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = Number(line.slice(colon + 1).trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}

function matches(pattern: string, topic: string): boolean {
  if (pattern.includes("**")) return false;
  const want = pattern.split(".");
  const got = topic.split(".");
  return want.length === got.length && want.every((segment, i) => segment === "*" || segment === got[i]);
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
export class Host {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onLog: ((line: Record<string, unknown>) => void) | undefined;
  private readonly calls = new Map<number, Call>();
  private readonly streams = new Map<string, Queue<Chunk>>();
  private readonly parked = new Map<string, Array<{ value: Chunk; bytes: number }>>();
  private readonly sinks: Sink[] = [];
  private readonly stderrTail: string[] = [];
  readonly exited: Promise<number>;
  private buffer: Buffer = Buffer.alloc(0);
  private subscription: { id: string; patterns: string[] } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private paused = false;
  private nextId = 0;
  private dead: Error | null = null;
  private tail = "";

  constructor(child: ChildProcessWithoutNullStreams, onLog?: (line: Record<string, unknown>) => void) {
    this.child = child;
    this.onLog = onLog;
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => this.feed(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.log(chunk));
    this.exited = new Promise((resolve) => {
      child.once("exit", (code) => {
        this.dead = this.died(code ?? -1);
        this.fail(this.dead);
        resolve(code ?? -1);
      });
    });
  }

  async capabilities(): Promise<Record<string, { plugin: string; version: string }>> {
    return (await this.request("capabilities", {})) as Record<string, { plugin: string; version: string }>;
  }

  invoke(capability: string, method: string, params?: unknown): Promise<unknown>;
  invoke(capability: string, method: string, params: unknown, opts: { stream: true }): Promise<AsyncIterable<Chunk>>;
  invoke(capability: string, method: string, params: unknown, opts: { stream: false }): Promise<unknown>;
  async invoke(capability: string, method: string, params?: unknown, opts?: { stream?: boolean }): Promise<unknown> {
    if (!opts?.stream) return await this.request("invoke", { capability, method, params });

    const reply = (await this.request("invoke", {
      capability,
      method,
      params,
      meta: { stream: true },
    })) as { stream_id?: string };
    const streamId = String(reply?.stream_id ?? "");
    const queue = new Queue<Chunk>(() => this.flow());
    this.streams.set(streamId, queue);
    const parked = this.parked.get(streamId);
    if (parked) {
      this.parked.delete(streamId);
      for (const item of parked) queue.push(item.value, item.bytes);
      if (parked.some((item) => item.value.done)) queue.close();
    }
    const host = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* queue;
        } finally {
          host.cancel(streamId);
          host.streams.delete(streamId);
          queue.close();
        }
      },
    };
  }

  cancel(streamId: string): void {
    if (this.dead) return;
    this.send({ jsonrpc: "2.0", method: "$/cancel", params: { stream_id: streamId } });
  }

  subscribe(patterns: string[]): AsyncIterable<Event> {
    const sink: Sink = { patterns, queue: new Queue<Event>(() => this.flow()) };
    this.sinks.push(sink);
    void this.sync();
    const host = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* sink.queue;
        } finally {
          const at = host.sinks.indexOf(sink);
          if (at >= 0) host.sinks.splice(at, 1);
          void host.sync();
        }
      },
    };
  }

  on(patterns: string[], handler: (event: Event) => void): () => void {
    const iterator = this.subscribe(patterns)[Symbol.asyncIterator]();
    void (async () => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          handler(next.value);
        }
      } catch {
      }
    })();
    return () => void iterator.return?.(undefined);
  }

  async shutdown(reason: "ui_quit" | "kernel_exit" = "ui_quit"): Promise<number> {
    if (!this.dead) {
      try {
        await this.request("shutdown", { reason });
      } catch {
      }
    }
    return await this.exited;
  }

  async restart(plugin: string, reason: "source" | "manual" = "manual"): Promise<void> {
    await this.request("restart", { plugin, reason });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(frame: unknown): void {
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.buffer.indexOf(HEADER_END);
      if (head < 0) return;
      const length = contentLength(this.buffer.subarray(0, head));
      if (length === null) {
        this.fail(new Error("kernel sent a frame with no usable Content-Length"));
        return;
      }
      if (this.buffer.length < head + 4 + length) return;
      const body = this.buffer.subarray(head + 4, head + 4 + length);
      this.buffer = this.buffer.subarray(head + 4 + length);
      let frame: WireFrame;
      try {
        frame = JSON.parse(body.toString("utf8")) as WireFrame;
      } catch {
        continue;
      }
      this.dispatch(frame, body.length);
    }
  }

  private dispatch(frame: WireFrame, bytes: number): void {
    if (typeof frame.id === "number") {
      const call = this.calls.get(frame.id);
      if (!call) return;
      this.calls.delete(frame.id);
      const error = frame.error;
      if (error) call.reject(new KernelError(Number(error.code), String(error.message), error.data));
      else call.resolve(frame.result);
      return;
    }

    const params = (frame.params ?? {}) as Record<string, any>;
    switch (frame.method) {
      case "$/stream/chunk": {
        const chunk = params as Chunk;
        const queue = this.streams.get(chunk.stream_id);
        if (!queue) {
          this.park(chunk, bytes);
          break;
        }
        queue.push(chunk, bytes);
        if (chunk.done) {
          this.streams.delete(chunk.stream_id);
          queue.close();
        }
        break;
      }
      case "$/stream/error": {
        const end: Chunk = {
          stream_id: String(params.stream_id),
          seq: -1,
          data: null,
          done: true,
          error: { code: Number(params.code), message: String(params.message ?? ""), data: params.data },
        };
        const queue = this.streams.get(end.stream_id);
        if (!queue) {
          this.park(end, bytes);
          break;
        }
        queue.push(end, bytes);
        this.streams.delete(end.stream_id);
        queue.close();
        break;
      }
      case "$/event": {
        const event = params as Event;
        for (const sink of this.sinks) {
          if (sink.patterns.some((pattern) => matches(pattern, event.topic))) sink.queue.push(event, bytes);
        }
        break;
      }
      default:
        break;
    }
    this.flow();
  }

  private park(chunk: Chunk, bytes: number): void {
    const parked = this.parked.get(chunk.stream_id);
    if (parked) parked.push({ value: chunk, bytes });
    else this.parked.set(chunk.stream_id, [{ value: chunk, bytes }]);
  }
  private flow(): void {
    if (this.dead) return;
    let bytes = 0;
    for (const queue of this.streams.values()) bytes += queue.pendingBytes;
    for (const sink of this.sinks) bytes += sink.queue.pendingBytes;
    if (!this.paused && bytes > PAUSE_BYTES) {
      this.paused = true;
      this.child.stdout.pause();
    } else if (this.paused && bytes < RESUME_BYTES) {
      this.paused = false;
      this.child.stdout.resume();
    }
  }

  private sync(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const want = [...new Set(this.sinks.flatMap((sink) => sink.patterns))].sort();
        if (this.subscription && same(want, this.subscription.patterns)) return;
        const previous = this.subscription?.id ?? null;
        if (want.length === 0) {
          this.subscription = null;
        } else {
          const reply = (await this.request("subscribe", { patterns: want, replay: true })) as {
            subscription_id?: string;
          };
          this.subscription = { id: String(reply?.subscription_id ?? ""), patterns: want };
        }
        if (previous) void this.request("unsubscribe", { subscription_id: previous }).catch(() => {});
      })
      .catch(() => {
        for (const sink of this.sinks) sink.queue.close();
        this.sinks.length = 0;
        this.subscription = null;
      });
    return this.chain;
  }

  private log(chunk: Buffer): void {
    this.tail += chunk.toString("utf8");
    const lines = this.tail.split("\n");
    this.tail = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 32) this.stderrTail.shift();
    if (!this.onLog) {
      process.stderr.write(line + "\n");
      return;
    }
    try {
      this.onLog(JSON.parse(line) as Record<string, unknown>);
    } catch {
    }
  }

  private fail(error: Error): void {
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
    for (const queue of this.streams.values()) queue.close();
    this.streams.clear();
    for (const sink of this.sinks) sink.queue.close();
    this.sinks.length = 0;
    this.subscription = null;
  }

  private died(code: number): Error {
    if (this.tail.trim() !== "") {
      this.line(this.tail);
      this.tail = "";
    }
    const report = [...this.stderrTail].reverse().find((line) => line.includes('"ok"'));
    return new Error([`blmoadll exited (code ${code})`, ...reportLines(report)].join("\n"));
  }
}

function reportLines(report: string | undefined): string[] {
  if (report === undefined) return [];
  try {
    const parsed = JSON.parse(report) as {
      errors?: Array<{ code?: unknown; field?: unknown; message?: unknown }>;
    };
    const errors = parsed.errors ?? [];
    if (errors.length === 0) return [`  ${report}`];
    return errors.map(
      (error) =>
        `  ${String(error.field ?? "kernel")} [${String(error.code ?? "?")}]: ${String(error.message ?? "")}`,
    );
  } catch {
    return [`  ${report}`];
  }
}

export async function boot(configPath: string, options: KernelOptions = {}): Promise<Host> {
  const bin = options.bin ?? process.env.BLMOADLL_BIN ?? "blmoadll";
  const child = spawn(bin, [configPath], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  const host = new Host(child, options.onLog);
  try {
    await host.capabilities();
  } catch (error) {
    child.kill();
    throw error;
  }
  return host;
}
