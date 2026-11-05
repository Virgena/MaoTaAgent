/// Every plugin instance this process owns: load, initialize, start, route,
/// stream, cancel, reload, unload. The Kernel sees a capability table and call
/// results; it never sees a plugin.

import { PROTOCOL_VERSION } from "@maota/plugin-kit";

import { HOST_METHOD, type HostFrame, type PluginProcess } from "./process.ts";
import type { Row } from "./discovery.ts";
import type { Fail, Reply, Trunk } from "./trunk.ts";

interface Declaration {
  provides?: string[];
  injects?: Array<{ capability?: string; optional?: boolean }>;
  registrations?: Array<{ service?: string; capability?: string }>;
  host_calls?: string[];
}

const UNKNOWN_CAPABILITY = -32010;
const PROVIDER_UNAVAILABLE = -32011;
const INVALID_PARAMS = -32602;
const INTERNAL = -32603;

/// The five states a capability snapshot may carry (PROTOCOL.md 16.4).
/// A row in any other state — disabled, stopped, never loaded — is left out of
/// the snapshot entirely: the kernel drops the whole snapshot on an unknown state.
const SNAPSHOT_STATE: Record<string, string | undefined> = {
  starting: "starting",
  running: "ready",
  recovering: "recovering",
  quarantined: "quarantined",
  failed: "failed",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/// Segment-wise, `*` matches exactly one segment — the kernel's rule
/// (crates/kernel/src/events.rs). The Runtime is the event source in this
/// arrangement, so it matches here instead.
function matchesTopic(pattern: string, topic: string): boolean {
  const left = pattern.split(".");
  const right = topic.split(".");
  return left.length === right.length && left.every((part, index) => part === "*" || part === right[index]);
}

export class Registry {
  private readonly rows: Row[];
  private host: PluginProcess;
  private readonly trunk: Trunk;
  private readonly states = new Map<string, string>();
  private readonly table = new Map<string, string>();
  private readonly entries = new Map<string, string>();
  private readonly routes = new Map<string, string>();
  private readonly streams = new Map<string, { plugin: string; stream: string }>();
  /// Provider-side streams opened by a plugin-to-plugin call: the key is the
  /// provider's stream, the value is the caller that must receive the chunks.
  private readonly pluginStreams = new Map<string, { to: string; stream: string }>();
  private readonly declarations = new Map<string, Declaration>();
  private readonly subscriptions = new Map<string, { plugin: string; patterns: string[] }>();
  private nextSubscription = 0;
  private nextCall = 0;
  private seq = 0;

  constructor(rows: Row[], host: PluginProcess, trunk: Trunk) {
    this.rows = rows;
    this.host = host;
    this.trunk = trunk;
    host.onFrame((frame) => this.relay(frame));
  }

  running(): Row[] {
    return this.rows.filter((row) => this.states.get(row.id) === "running");
  }

  snapshot(): void {
    const table: Record<string, { plugin: string }> = {};
    for (const [capability, plugin] of this.table) table[capability] = { plugin };
    const plugins: Array<{ id: string; state: string }> = [];
    for (const row of this.rows) {
      const state = SNAPSHOT_STATE[this.states.get(row.id) ?? ""];
      if (state !== undefined) plugins.push({ id: row.id, state });
    }
    this.trunk.capabilities(table, plugins);
  }

  status(): Record<string, unknown> {
    const running = this.rows.filter((row) => this.states.get(row.id) === "running").length;
    const states = [...this.states.values()];
    const state = states.includes("failed")
      ? "failed"
      : states.includes("quarantined")
        ? "quarantined"
        : running === this.rows.filter((row) => !row.disabled).length
          ? "ready"
          : "recovering";
    const blamed = this.rows.find((row) => this.states.get(row.id) === "failed");
    return {
      state,
      ready: running,
      total: this.rows.filter((row) => !row.disabled).length,
      ...(blamed === undefined ? {} : { plugin: blamed.id }),
    };
  }

  async boot(): Promise<void> {
    for (const row of this.rows) {
      if (row.disabled) {
        this.states.set(row.id, "disabled");
        continue;
      }
      await this.loadRow(row);
    }
    this.publishStatus();
    for (const row of this.startOrder()) await this.startRow(row);
    this.snapshot();
    this.publishStatus();
  }

  private async loadRow(row: Row): Promise<void> {
    if (row.entry === "") {
      this.markFailed(row, "the entry does not resolve");
      return;
    }
    this.states.set(row.id, "starting");
    try {
      await this.host.request(HOST_METHOD.LOAD, { plugin: row.id, entry: row.entry });
      const declaration = (await this.host.request(
        "initialize",
        { protocol: PROTOCOL_VERSION, plugin_id: row.id, config: row.config },
        row.id,
      )) as Declaration;
      this.entries.set(row.id, row.entry);
      this.declarations.set(row.id, declaration);
      for (const capability of stringList(declaration.provides)) {
        const owner = this.table.get(capability);
        if (owner !== undefined) {
          process.stderr.write(
            `runtime: ${capability} is provided by both ${owner} and ${row.id}; keeping ${owner}\n`,
          );
          continue;
        }
        this.table.set(capability, row.id);
      }
      for (const registration of declaration.registrations ?? []) {
        const service = String(registration.service ?? "");
        if (service !== "") this.routes.set(`${row.id}\u0000${service}`, String(registration.capability ?? ""));
      }
    } catch (error) {
      this.markFailed(row, messageOf(error));
    }
  }

  private async startRow(row: Row): Promise<void> {
    try {
      await this.host.request("start", { capabilities: this.tableJson() }, row.id);
      this.states.set(row.id, "running");
      this.publish("kernel.plugin.started", {
        plugin: row.id,
        pid: this.host.child.pid ?? null,
        trigger: "boot",
        cwd: process.cwd(),
        command: process.execPath,
        args: [row.entry],
      });
    } catch (error) {
      this.markFailed(row, messageOf(error));
    }
  }

  private markFailed(row: Row, message: string): void {
    process.stderr.write(`runtime: ${row.id} failed: ${message}\n`);
    this.states.set(row.id, "failed");
    this.publish("kernel.plugin.degraded", {
      plugin: row.id,
      code: 1,
      signal: null,
      message,
    });
  }

  private tableJson(): Record<string, { plugin: string }> {
    const table: Record<string, { plugin: string }> = {};
    for (const [capability, plugin] of this.table) table[capability] = { plugin };
    return table;
  }

  /// The meta the kernel writes when it forwards a call (kernel.rs `forward`):
  /// the caller's id and, when the caller declared it, the registration it is
  /// allowed to use. A provider such as `tools` refuses work without it.
  private callMeta(
    caller: string,
    capability: string,
    inner: unknown,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const requested =
      typeof inner === "object" && inner !== null && typeof (inner as { capability?: unknown }).capability === "string"
        ? (inner as { capability: string }).capability
        : "";
    const meta: Record<string, unknown> = { caller, request_id: ++this.nextCall, ...extra };
    const registration = (this.declarations.get(caller)?.registrations ?? []).find(
      (item) =>
        requested !== "" &&
        String(item.service ?? "") === capability &&
        String(item.capability ?? "") === requested,
    );
    if (registration !== undefined) {
      meta["authorized_registration"] = {
        service: registration.service,
        capability: registration.capability,
      };
    }
    return meta;
  }

  private publishStatus(): void {
    this.publish("kernel.runtime.status", this.status());
  }

  /// In runtime mode the Runtime is the event source: everything a plugin or the
  /// lifecycle emits goes to the kernel's bus and to the plugins watching it.
  publish(topic: string, payload: unknown, plugin?: string): void {
    this.trunk.send("$/runtime/event", {
      topic,
      payload,
      ...(plugin === undefined ? {} : { plugin }),
    });
    this.seq += 1;
    const seq = this.seq;
    for (const [subscription, found] of this.subscriptions) {
      if (!found.patterns.some((pattern) => matchesTopic(pattern, topic))) continue;
      this.host.notify(
        "$/event",
        { topic, seq, payload, subscription_id: subscription },
        found.plugin,
      );
    }
  }

  /// Rows start after the providers they inject and after the service they
  /// register with — the kernel's rule (crates/loader/src/graph.rs start_order).
  /// A cycle is not an error here: the rest start in id order.
  private startOrder(): Row[] {
    const pending = this.rows
      .filter((row) => this.states.get(row.id) === "starting")
      .sort((left, right) => left.id.localeCompare(right.id));
    const known = new Set(pending.map((row) => row.id));
    const started = new Set<string>();
    const order: Row[] = [];
    let progress = true;
    while (order.length < pending.length && progress) {
      progress = false;
      for (const row of pending) {
        if (started.has(row.id)) continue;
        const declaration = this.declarations.get(row.id);
        const dependencies = [
          ...(declaration?.injects ?? []).map((inject) =>
            typeof inject.capability === "string" ? inject.capability : "",
          ),
          ...(declaration?.registrations ?? []).map((registration) =>
            String(registration.service ?? ""),
          ),
        ]
          .map((capability) => this.table.get(capability))
          .filter((id): id is string => id !== undefined && id !== row.id && known.has(id));
        if (!dependencies.every((id) => started.has(id))) continue;
        started.add(row.id);
        order.push(row);
        progress = true;
      }
    }
    for (const row of pending) if (!started.has(row.id)) order.push(row);
    return order;
  }

  async invoke(params: Record<string, unknown>, reply: Reply, fail: Fail): Promise<void> {
    const capability = typeof params["capability"] === "string" ? params["capability"] : "";
    const method = typeof params["method"] === "string" ? params["method"] : "";
    const inner = params["params"];
    const meta = (params["meta"] ?? {}) as { stream?: boolean; stream_id?: string };
    const plugin = this.table.get(capability);
    if (plugin === undefined) {
      fail(UNKNOWN_CAPABILITY, `no provider for ${capability}`);
      return;
    }
    if (this.states.get(plugin) !== "running") {
      fail(PROVIDER_UNAVAILABLE, `provider ${plugin} is not available`, { plugin });
      return;
    }
    if (meta.stream !== true) {
      try {
        const forwarded = this.callMeta("host", capability, inner, {});
        reply(await this.host.request("invoke", { capability, method, params: inner, meta: forwarded }, plugin));
      } catch (error) {
        fail(PROVIDER_UNAVAILABLE, messageOf(error), { plugin });
      }
      return;
    }
    const kernelStream = typeof meta.stream_id === "string" ? meta.stream_id : "";
    if (kernelStream === "") {
      fail(INVALID_PARAMS, "a streamed call needs meta.stream_id");
      return;
    }
    try {
      const forwarded = this.callMeta("host", capability, inner, { stream: true });
      const opened = (await this.host.request(
        "invoke",
        { capability, method, params: inner, meta: forwarded },
        plugin,
      )) as { stream_id?: unknown };
      const stream = typeof opened?.stream_id === "string" ? opened.stream_id : "";
      if (stream === "") throw new Error("the plugin opened no stream");
      this.streams.set(kernelStream, { plugin, stream });
      this.routes.set(`${plugin}\u0000${stream}`, kernelStream);
      reply({ stream_id: kernelStream });
    } catch (error) {
      fail(PROVIDER_UNAVAILABLE, messageOf(error), { plugin });
    }
  }

  cancel(streamId: string): void {
    const forwarding = this.streams.get(streamId);
    if (forwarding === undefined) return;
    this.host.notify("$/cancel", { stream_id: forwarding.stream }, forwarding.plugin);
    this.forget(streamId, forwarding.plugin, forwarding.stream);
  }

  /// Every tagged frame a plugin sends that is not a reply to a call the Runtime
  /// made. Requests carry the string ids plugin-kit hands out; stream frames and
  /// notices carry no id.
  private relay(frame: HostFrame): void {
    const plugin = typeof frame.plugin === "string" ? frame.plugin : "";
    if (plugin === "") return;
    const method = typeof frame.method === "string" ? frame.method : "";
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (method === "$/stream/chunk" || method === "$/stream/error") {
      this.relayStream(plugin, method, params);
      return;
    }
    if (typeof frame.id === "string") {
      void this.relayRequest(plugin, frame.id, method, params);
      return;
    }
    this.relayNotice(plugin, method, params);
  }

  private relayStream(plugin: string, method: string, params: Record<string, unknown>): void {
    const stream = typeof params["stream_id"] === "string" ? params["stream_id"] : "";
    const done = params["done"] === true || method === "$/stream/error";
    const kernelStream = this.routes.get(`${plugin}\u0000${stream}`);
    if (kernelStream !== undefined) {
      this.trunk.send(method, { ...params, stream_id: kernelStream });
      if (done) this.forget(kernelStream, plugin, stream);
      return;
    }
    const key = `${plugin}\u0000${stream}`;
    const downstream = this.pluginStreams.get(key);
    if (downstream === undefined) return;
    this.host.notify(method, { ...params, stream_id: downstream.stream }, downstream.to);
    if (done) this.pluginStreams.delete(key);
  }

  private relayNotice(plugin: string, method: string, params: Record<string, unknown>): void {
    if (method === "kernel.log") {
      const level = typeof params["level"] === "string" ? params["level"] : "info";
      const message = typeof params["message"] === "string" ? params["message"] : "";
      process.stderr.write(`runtime: ${plugin} ${level}: ${message}\n`);
      return;
    }
    if (method === "$/cancel") {
      const stream = typeof params["stream_id"] === "string" ? params["stream_id"] : "";
      if (stream !== "") this.cancelFrom(plugin, stream);
      return;
    }
    process.stderr.write(`runtime: ${plugin} sent an unknown notification ${method}\n`);
  }

  private async relayRequest(
    plugin: string,
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case "kernel.publish": {
        const topic = typeof params["topic"] === "string" ? params["topic"] : "";
        if (topic === "") {
          this.host.respondError(plugin, id, INVALID_PARAMS, "publish needs a topic");
          return;
        }
        this.publish(topic, params["payload"] ?? null, plugin);
        this.host.respond(plugin, id, {});
        return;
      }
      case "kernel.invoke": {
        const capability = typeof params["capability"] === "string" ? params["capability"] : "";
        const call = typeof params["method"] === "string" ? params["method"] : "";
        const inner = params["params"];
        const meta = (params["meta"] ?? {}) as { stream?: boolean };
        const provider = this.table.get(capability);
        if (provider === undefined) {
          this.host.respondError(plugin, id, UNKNOWN_CAPABILITY, `no provider for ${capability}`);
          return;
        }
        if (this.states.get(provider) !== "running") {
          this.host.respondError(plugin, id, PROVIDER_UNAVAILABLE, `provider ${provider} is not available`);
          return;
        }
        try {
          if (meta.stream === true) {
            const forwarded = this.callMeta(plugin, capability, inner, { stream: true });
            const opened = (await this.host.request(
              "invoke",
              { capability, method: call, params: inner, meta: forwarded },
              provider,
            )) as { stream_id?: unknown };
            const stream = typeof opened?.stream_id === "string" ? opened.stream_id : "";
            if (stream === "") throw new Error("the provider opened no stream");
            this.pluginStreams.set(`${provider}\u0000${stream}`, { to: plugin, stream });
            this.host.respond(plugin, id, { stream_id: stream });
            return;
          }
          const forwarded = this.callMeta(plugin, capability, inner, {});
          const result = await this.host.request(
            "invoke",
            { capability, method: call, params: inner, meta: forwarded },
            provider,
          );
          this.host.respond(plugin, id, result);
        } catch (error) {
          this.host.respondError(plugin, id, PROVIDER_UNAVAILABLE, messageOf(error));
        }
        return;
      }
      case "kernel.subscribe": {
        const patterns = stringList(params["patterns"]);
        if (patterns.length === 0) {
          this.host.respondError(plugin, id, INVALID_PARAMS, "subscribe needs at least one pattern");
          return;
        }
        const subscription = `sub-${++this.nextSubscription}`;
        this.subscriptions.set(subscription, { plugin, patterns });
        if (params["replay"] === true && patterns.some((pattern) => matchesTopic(pattern, "kernel.runtime.status"))) {
          this.host.notify(
            "$/event",
            { topic: "kernel.runtime.status", seq: 0, payload: this.status(), subscription_id: subscription },
            plugin,
          );
        }
        this.host.respond(plugin, id, { subscription_id: subscription });
        return;
      }
      case "kernel.unsubscribe": {
        const subscription =
          typeof params["subscription_id"] === "string" ? params["subscription_id"] : "";
        const found = this.subscriptions.get(subscription);
        if (found === undefined || found.plugin !== plugin) {
          this.host.respondError(plugin, id, -32012, "no such subscription");
          return;
        }
        this.subscriptions.delete(subscription);
        this.host.respond(plugin, id, {});
        return;
      }
      default:
        this.host.respondError(plugin, id, -32601, `unknown method ${method}`);
    }
  }

  private cancelFrom(plugin: string, stream: string): void {
    const key = `${plugin}\u0000${stream}`;
    const downstream = this.pluginStreams.get(key);
    if (downstream === undefined) return;
    this.pluginStreams.delete(key);
    this.host.notify("$/cancel", { stream_id: downstream.stream }, downstream.to);
  }

  private forget(kernelStream: string, plugin: string, stream: string): void {
    this.streams.delete(kernelStream);
    this.routes.delete(`${plugin}\u0000${stream}`);
  }

  async restart(plugin: string, reason: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === plugin);
    if (row === undefined) throw new Error(`no plugin ${plugin}`);
    for (const [subscription, found] of [...this.subscriptions]) {
      if (found.plugin === plugin) this.subscriptions.delete(subscription);
    }
    this.states.set(plugin, "recovering");
    this.publishStatus();
    for (const [capability, owner] of [...this.table]) if (owner === plugin) this.table.delete(capability);
    this.snapshot();
    try {
      await this.host.request(HOST_METHOD.UNLOAD, { plugin, reason: "reload" });
      await this.loadRow(row);
      await this.startRow(row);
      this.publish("kernel.plugin.stopped", { plugin, reason: "shutdown", trigger: reason });
    } catch (error) {
      this.markFailed(row, messageOf(error));
      this.snapshot();
      this.publishStatus();
      throw new Error(`restart ${plugin} failed: ${messageOf(error)}`);
    }
    this.snapshot();
    this.publishStatus();
  }

  async shutdown(reason: string): Promise<void> {
    for (const row of this.rows) {
      if (this.states.get(row.id) !== "running") continue;
      this.states.set(row.id, "stopped");
      try {
        await this.host.request(HOST_METHOD.UNLOAD, { plugin: row.id, reason });
      } catch {
        continue;
      }
      this.publish("kernel.plugin.stopped", { plugin: row.id, reason: "shutdown" });
    }
    this.host.kill();
    this.snapshot();
  }

  /// A restarted Plugin Process: every plugin instance it held is gone, so the
  /// tables go with it and `boot()` rebuilds them.
  rebind(host: PluginProcess): void {
    this.host = host;
    this.states.clear();
    this.table.clear();
    this.entries.clear();
    this.declarations.clear();
    this.subscriptions.clear();
    this.routes.clear();
    this.streams.clear();
    this.pluginStreams.clear();
    host.onFrame((frame) => this.relay(frame));
  }

  /// One plugin's failure: its slot stays, its siblings keep running.
  degrade(plugin: string, message: string): void {
    const row = this.rows.find((candidate) => candidate.id === plugin);
    if (row === undefined) {
      this.publish("kernel.plugin.degraded", {
        plugin,
        code: INTERNAL,
        signal: null,
        message,
      });
      return;
    }
    this.markFailed(row, message);
    this.snapshot();
    this.publishStatus();
  }
}
