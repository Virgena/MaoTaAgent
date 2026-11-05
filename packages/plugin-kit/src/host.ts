/// The seam between a plugin that owns a process and one that shares one.
///
/// A shared host imports a plugin module, and the module calls `runPlugin` as it
/// always did. Nothing in the plugin changes: `isPluginEntry` asks the adapter
/// whether this module is the entry being loaded, and `serve` gives the channel
/// to the adapter instead of binding it to this process's stdin and stdout.
///
/// The registration point is a global symbol, not a module export, because a
/// shared host and a plugin can be reached through different `node_modules`
/// links: two copies of this package must still see one adapter.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Definition } from "./plugin.ts";

/// Where a channel's frames go. A process plugin writes fd 1; a shared plugin
/// hands the frame to the host, which tags it with the plugin id and is the only
/// writer on the pipe.
export interface Transport {
  write(frame: unknown): void;
  exit(code: number): void;
}

/// The channel as the host sees it: write to it, and push a frame into it.
export interface Adoptable {
  attach(transport: Transport): void;
  deliver(body: Buffer): void;
  exit(code: number): void;
}

export interface HostAdapter {
  /// True when the host is loading this very module as a plugin entry.
  expecting(moduleUrl: string): boolean;
  /// Binds the plugin's channel to this host. Called once per module that runs
  /// `runPlugin`; `moduleUrl` is the module that called it, so a dependency
  /// that also calls `runPlugin` cannot take over the load it was pulled into.
  adopt(definition: Definition, channel: Adoptable, moduleUrl: string | null): void;
}

export const HOST_ADAPTER = Symbol.for("@maota/plugin-kit/host-adapter");

export function installHostAdapter(adapter: HostAdapter | null): void {
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (adapter === null) delete slot[HOST_ADAPTER];
  else slot[HOST_ADAPTER] = adapter;
}

export function hostAdapter(): HostAdapter | null {
  const found = (globalThis as unknown as Record<symbol, unknown>)[HOST_ADAPTER];
  if (typeof found !== "object" || found === null) return null;
  const candidate = found as Partial<HostAdapter>;
  if (typeof candidate.expecting !== "function" || typeof candidate.adopt !== "function") return null;
  return candidate as HostAdapter;
}

/// The file a module URL names, resolved the way the filesystem resolves it, so
/// a module reached through a linked `node_modules` still matches the entry the
/// host was asked to load. Windows compares case-insensitively, as the
/// filesystem does. `null` when the path does not exist.
export function canonicalPath(url: string): string | null {
  try {
    const path = url.includes("://") ? fileURLToPath(url) : url;
    const real = realpathSync.native(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}
