import type { HostEvent, RpcFailure } from "../../../src/protocol.ts";

export type * from "../../../src/protocol.ts";

export class CallFailed extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "CallFailed";
    this.code = code;
  }
}

export async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!response.ok) throw new CallFailed(response.status, `the host did not answer (HTTP ${response.status})`);
  const payload = (await response.json()) as { result?: T; error?: RpcFailure };
  if (payload.error) throw new CallFailed(payload.error.code, payload.error.message);
  return payload.result as T;
}

export function subscribe(onEvent: (event: HostEvent) => void, onReconnect: () => void): () => void {
  const source = new EventSource("/events");
  let opened = false;
  source.onopen = () => {
    if (opened) onReconnect();
    opened = true;
  };
  source.onmessage = (raw: MessageEvent) => {
    try {
      onEvent(JSON.parse(raw.data) as HostEvent);
    } catch {
    }
  };
  return () => source.close();
}
