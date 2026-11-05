import { writeSync } from "node:fs";

import { Channel, CallError, type Route } from "./channel.ts";
import { canonicalPath, hostAdapter } from "./host.ts";

/// The other half of this number is `PROTOCOL_VERSION` in the kernel's
/// `crates/protocol`; a mismatch fails startup with -32015.
export const PROTOCOL_VERSION = 3;

export interface Inject {
  capability: string;
  optional?: boolean;
}

export interface Registration {
  service: string;
  capability: string;
}

export interface Wiring {
  channel: Channel;
  config: Record<string, unknown>;
  capabilities: Record<string, Route>;
}

export interface Call extends Wiring {
  capability: string;
  method: string;
  caller: string;
  registration?: Registration;
  signal: AbortSignal;
  stream: ProviderStream | undefined;
}

export type Method = (params: any, call: Call) => Promise<unknown> | unknown;

export interface Definition {
  provides: string[];
  injects: Inject[];
  registrations: Registration[];
  hostCalls: string[];
  configKeys?: readonly string[];
  setup?(wiring: Wiring): void | Promise<void>;
  start?(wiring: Wiring): void | Promise<void>;
  methods: Record<string, Method>;
  close?(reason: string): void | Promise<void>;
  selfCheck?(): string[] | Promise<string[]>;
}

export class ProviderStream {
  readonly id: string;
  private readonly channel: Channel;
  private open = false;
  private seq = 0;
  private buffered: unknown[] = [];
  private finished = false;

  constructor(id: string, channel: Channel) {
    this.id = id;
    this.channel = channel;
  }

  push(data: unknown): void {
    if (this.finished) return;
    if (!this.open) {
      this.buffered.push(data);
      return;
    }
    this.channel.notify("$/stream/chunk", { stream_id: this.id, seq: this.seq++, data, done: false });
  }

  opened(): void {
    if (this.open) return;
    this.open = true;
    const buffered = this.buffered;
    this.buffered = [];
    for (const data of buffered) this.push(data);
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.channel.notify("$/stream/chunk", { stream_id: this.id, seq: this.seq++, data: null, done: true });
  }

  fail(code: number, message: string, data?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.channel.notify("$/stream/error", { stream_id: this.id, code, message, data });
  }

  stop(): void {
    this.finished = true;
  }
}

export function serve(definition: Definition, moduleUrl: string | null = null): void {
  const wiring: Wiring = { channel: null as unknown as Channel, config: {}, capabilities: {} };
  const aborts = new Map<number, AbortController>();
  const registered: Registration[] = [];

  const channel = new Channel({
    request: (method, params, reply) =>
      handle(definition, wiring, aborts, registered, method, params, reply),
    notification: (method, params) => {
      if (method !== "$/cancel") return;
      const requestId = params?.request_id;
      if (typeof requestId === "number") aborts.get(requestId)?.abort();
    },
    event: () => {},
  });
  wiring.channel = channel;
  const adapter = hostAdapter();
  if (adapter === null) channel.listen();
  else adapter.adopt(definition, channel, moduleUrl);
}

/// The module that called into this package, from a stack trace. A shared host
/// uses it to bind a plugin definition to the entry it is importing: a package
/// that calls `runPlugin` from its top level gets pulled into another plugin's
/// module graph, and it must not take that plugin's slot.
function callerUrl(): string | null {
  const stack = new Error().stack;
  if (stack === undefined) return null;
  for (const line of stack.split("\n").slice(1)) {
    const at = line.indexOf("file://");
    if (at < 0) continue;
    const url = line.slice(at).replace(/:\d+:\d+\)?\s*$/, "").trim();
    if (url.includes("/plugin-kit/")) continue;
    return url;
  }
  return null;
}

export function unknownConfigKeys(known: readonly string[] | undefined, config: Record<string, unknown>): string[] {
  if (!known) return [];
  return Object.keys(config).filter((key) => !known.includes(key));
}

export function unknownConfigWarning(id: string, known: readonly string[], unknown: readonly string[]): string {
  const reads = known.length > 0 ? `this plugin reads: ${known.join(", ")}` : "this plugin reads no config";
  const keys = unknown.length === 1 ? "key" : "keys";
  return `unknown config ${keys} in plugins.${id}.config: ${unknown.join(", ")} (${reads})`;
}

function warnUnknownConfig(definition: Definition, params: any, wiring: Wiring): void {
  const known = definition.configKeys;
  const unknown = unknownConfigKeys(known, wiring.config);
  if (known === undefined || unknown.length === 0) return;
  const id = String(params?.plugin_id ?? "?");
  wiring.channel.log("warn", unknownConfigWarning(id, known, unknown), { plugin_id: id, unknown, known });
}

async function handle(
  definition: Definition,
  wiring: Wiring,
  aborts: Map<number, AbortController>,
  registered: Registration[],
  method: string,
  params: any,
  reply: (result: unknown) => void,
): Promise<void> {
  switch (method) {
    case "initialize": {
      wiring.config = { ...(params?.config ?? {}) };
      warnUnknownConfig(definition, params, wiring);
      const problems = declarationProblems(definition);
      if (problems.length > 0) {
        throw new CallError(-32602, `invalid plugin declaration: ${problems.join("; ")}`);
      }
      await definition.setup?.(wiring);
      reply({
        protocol: PROTOCOL_VERSION,
        provides: definition.provides,
        injects: definition.injects,
        registrations: definition.registrations,
        host_calls: definition.hostCalls,
      });
      return;
    }
    case "start": {
      wiring.capabilities = { ...(params?.capabilities ?? {}) };
      await definition.start?.(wiring);
      await registerAll(definition, wiring, registered);
      reply({});
      return;
    }
    case "invoke": {
      await invoke(definition, wiring, aborts, params, reply);
      return;
    }
    case "shutdown": {
      await unregisterAll(wiring, registered);
      reply({});
      await definition.close?.(String(params?.reason ?? ""));
      wiring.channel.exit(0);
      return;
    }
    default:
      throw new CallError(-32601, `no ${method} here`);
  }
}

async function registerAll(definition: Definition, wiring: Wiring, registered: Registration[]): Promise<void> {
  try {
    for (const registration of definition.registrations) {
      await wiring.channel.call(
        registration.service,
        "register",
        { capability: registration.capability },
        { timeout_ms: 5000 },
      );
      registered.push(registration);
    }
  } catch (error) {
    await unregisterAll(wiring, registered);
    throw error;
  }
}

async function unregisterAll(wiring: Wiring, registered: Registration[]): Promise<void> {
  while (registered.length > 0) {
    const registration = registered.pop()!;
    try {
      await wiring.channel.call(
        registration.service,
        "unregister",
        { capability: registration.capability },
        { timeout_ms: 1000 },
      );
    } catch {
    }
  }
}

async function invoke(
  definition: Definition,
  wiring: Wiring,
  aborts: Map<number, AbortController>,
  params: any,
  reply: (result: unknown) => void,
): Promise<void> {
  const method = String(params?.method ?? "");
  const handler = definition.methods[method];
  if (!handler) throw new CallError(-32601, `no method ${method} here`);

  const meta = params?.meta ?? {};
  const kernelId = Number(meta.request_id);
  const known = Number.isFinite(kernelId);
  const controller = new AbortController();
  if (known) aborts.set(kernelId, controller);

  const streaming = meta.stream === true;
  const stream = streaming ? new ProviderStream(`s-${kernelId}`, wiring.channel) : undefined;
  const call: Call = {
    ...wiring,
    capability: String(params?.capability ?? ""),
    method,
    caller: String(meta.caller ?? ""),
    ...(meta.authorized_registration === undefined || meta.authorized_registration === null
      ? {}
      : { registration: meta.authorized_registration as Registration }),
    signal: controller.signal,
    stream,
  };

  try {
    if (stream) {
      reply({ stream_id: stream.id });
      stream.opened();
      await handler(params?.params, call);
      stream.end();
    } else {
      reply(await handler(params?.params, call));
    }
  } catch (error) {
    if (!stream) throw error;
    if (controller.signal.aborted) stream.stop();
    else if (error instanceof CallError) stream.fail(error.code, error.message, error.data);
    else stream.fail(-32603, error instanceof Error ? error.message : String(error));
  } finally {
    if (known) aborts.delete(kernelId);
  }
}

export function runPlugin(definition: Definition, argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes("--check")) {
    void check(definition);
    return;
  }
  serve(definition, callerUrl());
}

/// A package that is spawned as a plugin and imported by its siblings as a
/// library cannot serve on an import: `runPlugin` runs at module scope, so an
/// import would open a second server on the same stdin and one plugin would
/// answer twice. A module that can be imported asks this first, and only the
/// file the process was started with is the plugin; both sides are resolved so
/// a package reached through a linked `node_modules` still matches.
export function isPluginEntry(moduleUrl: string, started: string | undefined = process.argv[1]): boolean {
  const adapter = hostAdapter();
  if (adapter !== null && adapter.expecting(moduleUrl)) return true;
  if (started === undefined || started === "") return false;
  const here = canonicalPath(moduleUrl);
  const main = canonicalPath(started);
  return here !== null && main !== null && here === main;
}

async function check(definition: Definition): Promise<void> {
  const problems = declarationProblems(definition);
  if (definition.configKeys === undefined) {
    problems.push("configKeys is not declared: list the config keys initialize reads ([] if none)");
  }
  try {
    problems.push(...((await definition.selfCheck?.()) ?? []));
  } catch (error) {
    problems.push(`selfCheck threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  const ok = problems.length === 0;
  writeSync(1, `${JSON.stringify({
    ok,
    provides: definition.provides,
    injects: definition.injects,
    registrations: definition.registrations,
    host_calls: definition.hostCalls,
    problems,
  })}\n`);
  process.exit(ok ? 0 : 1);
}

function declarationProblems(definition: Definition): string[] {
  const problems: string[] = [];
  const capabilityId = /^[a-z][a-z0-9._-]*$/;
  if (definition.provides.length === 0) problems.push("provides is empty");
  for (const capability of definition.provides) {
    if (!capabilityId.test(capability)) {
      problems.push(`capability "${capability}" should be a lowercase id`);
    }
  }
  if (!Array.isArray(definition.injects)) problems.push("injects is not an array");
  if (!Array.isArray(definition.registrations)) problems.push("registrations is not an array");
  if (!Array.isArray(definition.hostCalls)) problems.push("hostCalls is not an array");
  for (const inject of definition.injects ?? []) {
    if (!capabilityId.test(String(inject?.capability ?? ""))) {
      problems.push(`injection "${String(inject?.capability ?? "")}" is not a capability id`);
    }
    if (inject?.optional !== undefined && typeof inject.optional !== "boolean") {
      problems.push(`injection "${inject.capability}" has a non-boolean optional flag`);
    }
  }
  const provided = new Set(definition.provides);
  const registered = new Set<string>();
  for (const registration of definition.registrations ?? []) {
    if (!capabilityId.test(String(registration?.service ?? ""))) {
      problems.push(`registration service "${String(registration?.service ?? "")}" is not a capability id`);
    }
    if (!capabilityId.test(String(registration?.capability ?? ""))) {
      problems.push(`registration capability "${String(registration?.capability ?? "")}" is not a capability id`);
    }
    if (!provided.has(registration.capability)) {
      problems.push(`registration capability "${registration.capability}" is not in provides`);
    }
    if (registration.service === registration.capability) {
      problems.push(`registration "${registration.capability}" cannot target itself`);
    }
    if (registered.has(registration.capability)) {
      problems.push(`registration "${registration.capability}" is declared twice`);
    }
    registered.add(registration.capability);
  }
  const hostCalls = new Set<string>();
  for (const capability of definition.hostCalls ?? []) {
    if (!capabilityId.test(String(capability))) problems.push(`host call "${String(capability)}" is not a capability id`);
    if (!provided.has(capability)) problems.push(`host call "${capability}" is not in provides`);
    if (hostCalls.has(capability)) problems.push(`host call "${capability}" is declared twice`);
    hostCalls.add(capability);
  }
  return problems;
}
