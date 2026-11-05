/// The plugins this process hosts: one module graph each, one channel each, and
/// one pipe to the kernel for all of them.
///
/// The kernel addresses a plugin with a frame's `plugin` member. A frame for a
/// plugin goes to that plugin's channel; a reply the plugin writes comes back
/// here and leaves tagged. Nothing is loaded before the kernel asks for it, and
/// a closed plugin leaves only its generation behind: the next load is a fresh
/// module graph.

import { AsyncLocalStorage } from "node:async_hooks";
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

import { canonicalPath, type Adoptable, type HostAdapter, type Transport } from "@maota/plugin-kit";

import { HOST_FAILED, HOST_METHOD } from "./control.ts";
import type { Outbound } from "./outbound.ts";

/// How long an unload waits for a plugin's `close()` before it abandons it.
const UNLOAD_GRACE_MS = 5_000;
const RELOAD_TAG = "maota";
const RELOAD_GEN = "gen";

interface Member {
  id: string;
  entry: string;
  channel: Adoptable | null;
  loaded: boolean;
  closed: boolean;
  resolveClosed: () => void;
  closedPromise: Promise<void>;
}

interface Pending {
  id: string;
  adopted: boolean;
}

export class Members {
  private readonly outbound: Outbound;
  private readonly storage = new AsyncLocalStorage<{ plugin: string; entry: string }>();
  private readonly current = new Map<string, Member>();
  private readonly loading = new Map<string, Pending>();
  private readonly generations = new Map<string, number>();
  private readonly warned = new Set<string>();
  private nextRequest = 0;

  constructor(outbound: Outbound) {
    this.outbound = outbound;
    installReloadHooks();
  }

  /// The adapter `plugin-kit` looks for on `globalThis`.
  adapter(): HostAdapter {
    return {
      expecting: (moduleUrl) => {
        const key = canonicalPath(moduleUrl);
        return key !== null && this.loading.has(key);
      },
      adopt: (_definition, channel, moduleUrl) => this.adopt(channel, moduleUrl),
    };
  }

  /// The plugin whose code is running on this turn of the loop, for crash
  /// attribution. `undefined` means the code belongs to the host itself.
  attribution(): string | undefined {
    return this.storage.getStore()?.plugin;
  }

  async load(plugin: string, entry: string): Promise<void> {
    if (plugin === "") throw new HostError("load needs a plugin id");
    const existing = this.current.get(plugin);
    if (existing !== undefined && existing.loaded && !existing.closed) {
      throw new HostError(`plugin ${plugin} is already loaded`);
    }
    const real = canonicalPath(entry);
    if (real === null) throw new HostError(`plugin ${plugin} has no entry at ${entry}`);
    if (this.loading.has(real)) throw new HostError(`plugin ${plugin} is already loading`);
    const wanted = pathToFileURL(real);
    const generation = this.generations.get(plugin) ?? 0;
    if (generation > 0) {
      wanted.searchParams.set(RELOAD_TAG, plugin);
      wanted.searchParams.set(RELOAD_GEN, String(generation));
    }

    const member = newMember(plugin, real);
    this.current.set(plugin, member);
    const pending: Pending = { id: plugin, adopted: false };
    this.loading.set(real, pending);
    this.notify(HOST_METHOD.LOADING, { plugin });

    try {
      await this.storage.run({ plugin, entry: real }, () => import(wanted.href));
      if (!pending.adopted) throw new HostError(`plugin ${plugin} was imported but never started a plugin`);
      member.loaded = true;
    } catch (error) {
      const message = textOf(error);
      this.notify(HOST_METHOD.FAILED, { plugin, message, code: HOST_FAILED });
      member.closed = true;
      member.resolveClosed();
      throw new HostError(message);
    } finally {
      this.loading.delete(real);
    }
  }

  /// Ends one plugin: `shutdown` through its channel, then the channel's own
  /// exit. A plugin that will not close is reported stuck and abandoned, so the
  /// kernel can decide what to do with the whole host.
  async unload(plugin: string, reason: string): Promise<void> {
    const member = this.current.get(plugin);
    if (member === undefined || member.closed || member.channel === null) return;
    const channel = member.channel;
    const id = `u-${++this.nextRequest}`;
    channel.deliver(
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "shutdown", params: { reason } })),
    );
    const closed = await Promise.race([
      member.closedPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), UNLOAD_GRACE_MS)),
    ]);
    if (!closed) {
      this.notify(HOST_METHOD.STUCK, { plugin, stage: "shutdown" });
      this.close(plugin, null, true);
    }
  }

  /// Drops a plugin's channel without asking it to close. The process boundary
  /// is the only hard isolation there is, so "kill" stops delivery and nothing
  /// more; the kernel kills the host when it really is stuck.
  kill(plugin: string): void {
    this.close(plugin, null, true);
  }

  deliver(plugin: string, body: Buffer): void {
    const member = this.current.get(plugin);
    if (member === undefined || member.closed || member.channel === null) {
      if (!this.warned.has(plugin)) {
        this.warned.add(plugin);
        process.stderr.write(`plugin-host: a frame for ${plugin} arrived with no channel\n`);
      }
      return;
    }
    this.storage.run({ plugin, entry: member.entry }, () => {
      try {
        member.channel!.deliver(body);
      } catch (error) {
        this.crash(error, plugin);
      }
    });
  }

  crash(error: unknown, plugin?: string): void {
    const message = textOf(error);
    process.stderr.write(`plugin-host: uncaught in ${plugin ?? "host"}: ${message}\n`);
    this.notify(HOST_METHOD.CRASH, { plugin: plugin ?? null, error: message });
  }

  notify(method: string, params: unknown): void {
    this.outbound.write({ jsonrpc: "2.0", method, params });
  }

  private adopt(channel: Adoptable, moduleUrl: string | null): void {
    const store = this.storage.getStore();
    if (store === undefined) throw new HostError("a plugin started outside a load");
    const pending = this.loading.get(store.entry);
    if (pending === undefined) throw new HostError("a plugin started outside a load");
    // Evaluation order is bottom-up: a dependency that calls `runPlugin` runs
    // before the entry does. Only the entry may take the slot; anything else is
    // a package being pulled in, and it stays inert.
    const caller = moduleUrl === null ? null : canonicalPath(moduleUrl);
    if (caller !== null && caller !== store.entry) {
      process.stderr.write(
        `plugin-host: ${caller} is not the entry of ${pending.id}; it stays inert\n`,
      );
      return;
    }
    if (pending.adopted) throw new HostError(`plugin ${pending.id} started twice in one load`);
    pending.adopted = true;
    const member = this.current.get(pending.id);
    if (member === undefined) throw new HostError(`plugin ${pending.id} has no record`);
    member.channel = channel;
    channel.attach(this.transportFor(pending.id));
  }

  private transportFor(plugin: string): Transport {
    return {
      write: (frame) => {
        this.outbound.write({ ...(frame as Record<string, unknown>), plugin });
      },
      exit: (code) => this.close(plugin, code, false),
    };
  }

  private close(plugin: string, code: number | null, killed: boolean): void {
    const member = this.current.get(plugin);
    if (member === undefined || member.closed) return;
    closeMember(member, code, killed, (method, params) => this.notify(method, params));
    if (member.loaded) this.generations.set(plugin, (this.generations.get(plugin) ?? 0) + 1);
    member.loaded = false;
  }
}

function newMember(plugin: string, entry: string): Member {
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return { id: plugin, entry, channel: null, loaded: false, closed: false, resolveClosed, closedPromise };
}

function closeMember(
  member: Member,
  code: number | null,
  killed: boolean,
  notify: (method: string, params: unknown) => void,
): void {
  if (member.closed) return;
  member.closed = true;
  member.resolveClosed();
  notify(HOST_METHOD.EXITED, {
    plugin: member.id,
    exit_code: code,
    signal: null,
    ...(killed ? { killed: true } : {}),
  });
}

export class HostError extends Error {
  readonly code: number;

  constructor(message: string) {
    super(message);
    this.name = "HostError";
    this.code = HOST_FAILED;
  }
}

export function textOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/// A reloaded plugin's module graph must be evaluated again. Node caches a
/// module by its URL, so the generation rides in the query string and this hook
/// propagates it to every file the tagged module imports. A first load is
/// untagged: sharing the graph with other plugins is the point of one host.
let hooksInstalled = false;

function installReloadHooks(): void {
  if (hooksInstalled) return;
  const register = (nodeModule as { registerHooks?: (hooks: unknown) => unknown }).registerHooks;
  if (typeof register !== "function") return;
  hooksInstalled = true;
  register({
    resolve(specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => { url: string }) {
      const parent = context.parentURL;
      if (parent === undefined) return nextResolve(specifier, context);
      const carried = tagOf(parent);
      if (carried === null) return nextResolve(specifier, context);
      const resolved = nextResolve(specifier, context);
      if (!resolved.url.startsWith("file:")) return resolved;
      const url = new URL(resolved.url);
      if (url.searchParams.has(RELOAD_TAG)) return resolved;
      url.searchParams.set(RELOAD_TAG, carried.plugin);
      url.searchParams.set(RELOAD_GEN, carried.generation);
      return { ...resolved, url: url.href };
    },
  });
}

function tagOf(url: string): { plugin: string; generation: string } | null {
  try {
    const parsed = new URL(url);
    const plugin = parsed.searchParams.get(RELOAD_TAG);
    const generation = parsed.searchParams.get(RELOAD_GEN);
    if (plugin === null || generation === null) return null;
    return { plugin, generation };
  } catch {
    return null;
  }
}
