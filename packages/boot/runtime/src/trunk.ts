/// The parent pipe. The kernel sends requests and notifications on fd 0, and
/// this process answers on fd 1. Framing and the writer are `plugin-kit`'s, so
/// the runtime speaks exactly what a plugin speaks.

import { frameReader, writeFrame } from "@maota/plugin-kit";

export interface Request {
  method: string;
  params: Record<string, unknown>;
}

export type Reply = (result: unknown) => void;
export type Fail = (code: number, message: string, data?: unknown) => void;

export class Trunk {
  private readonly requests = new Set<(request: Request, reply: Reply, fail: Fail) => void>();
  private readonly notices = new Set<(method: string, params: Record<string, unknown>) => void>();
  private closed = false;
  private closeHandler: (() => void) | null = null;

  static start(): Trunk {
    const trunk = new Trunk();
    const read = frameReader((body) => trunk.dispatch(body));
    process.stdin.on("data", read);
    process.stdin.on("end", () => trunk.finish());
    process.stdin.on("error", () => trunk.finish());
    return trunk;
  }

  onRequest(handler: (request: Request, reply: Reply, fail: Fail) => void): void {
    this.requests.add(handler);
  }

  onNotice(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notices.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  get stopped(): boolean {
    return this.closed;
  }

  send(method: string, params: Record<string, unknown>): void {
    writeFrame({ jsonrpc: "2.0", method, params });
  }

  publish(topic: string, payload: unknown): void {
    this.send("$/runtime/event", { topic, payload });
  }

  capabilities(table: Record<string, { plugin: string }>, plugins: Array<{ id: string; state: string }>): void {
    this.send("$/runtime/capabilities", { v: 1, table, plugins });
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }

  private dispatch(body: Buffer): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = typeof frame["method"] === "string" ? frame["method"] : "";
    const id = frame["id"];
    const params = (frame["params"] ?? {}) as Record<string, unknown>;
    if (method !== "" && typeof id === "number") {
      const reply: Reply = (result) => writeFrame({ jsonrpc: "2.0", id, result });
      const fail: Fail = (code, message, data) =>
        writeFrame({
          jsonrpc: "2.0",
          id,
          error: { code, message, ...(data === undefined ? {} : { data }) },
        });
      for (const handler of this.requests) handler({ method, params }, reply, fail);
      return;
    }
    if (method !== "") for (const handler of this.notices) handler(method, params);
  }
}
