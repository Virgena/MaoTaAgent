/// What this profile runs: the plugin rows the bundles list, with the machine
/// layer applied on top. The kernel hands the plugin rows to this process, so
/// discovery happens here and nowhere else.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { bundlesOfProfile, entryOf, resolveBundleRows } from "@maota/app-boot";
import { parse } from "smol-toml";

export interface Row {
  id: string;
  name: string;
  disabled: boolean;
  config: Record<string, unknown>;
  entry: string;
}

/// How often this Runtime may restart the Plugin Process, and inside which
/// window. Mirrors the kernel's `[kernel] host_restarts` defaults.
export interface Limits {
  restarts: number;
  windowMs: number;
}

interface Override {
  disabled?: boolean;
  config?: Record<string, unknown>;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] = isTable(existing) && isTable(value) ? merge(existing, value) : value;
  }
  return out;
}

/// Follows `extends` (a string or an array) and merges base first, this file
/// last: tables key by key, arrays replaced whole, exactly the kernel's rule.
function layered(path: string, seen: Set<string> = new Set()): Record<string, unknown> {
  const real = resolve(path);
  if (seen.has(real) || !existsSync(real)) return {};
  seen.add(real);
  let table: Record<string, unknown>;
  try {
    const parsed = parse(readFileSync(real, "utf8"));
    table = isTable(parsed) ? parsed : {};
  } catch {
    return {};
  }
  const extendsList = table["extends"];
  const parents = typeof extendsList === "string" ? [extendsList] : Array.isArray(extendsList) ? extendsList : [];
  let merged: Record<string, unknown> = {};
  for (const parent of parents) {
    if (typeof parent === "string") merged = merge(merged, layered(resolve(dirname(real), parent), seen));
  }
  return merge(merged, table);
}

function overrides(configPath: string): Map<string, Override> {
  const found = new Map<string, Override>();
  const plugins = layered(configPath)["plugins"];
  if (!isTable(plugins)) return found;
  for (const [id, row] of Object.entries(plugins)) {
    if (!isTable(row)) continue;
    const override: Override = {};
    if (typeof row["disabled"] === "boolean") override.disabled = row["disabled"];
    if (isTable(row["config"])) override.config = row["config"];
    if (override.disabled !== undefined || override.config !== undefined) found.set(id, override);
  }
  return found;
}

/// The `[runtime]` row of the same layered config the kernel handed us.
export function limitsFrom(configPath: string): Limits {
  const runtime = layered(configPath)["runtime"];
  const table = isTable(runtime) ? runtime : {};
  const restarts = typeof table["host_restarts"] === "number" ? table["host_restarts"] : 3;
  const windowMs =
    typeof table["host_restart_window_ms"] === "number" ? table["host_restart_window_ms"] : 600_000;
  return { restarts, windowMs };
}

export async function discover(
  profileDir: string,
  installAnchor: string,
  profile: string,
  configPath: string,
): Promise<Row[]> {
  const bundles = bundlesOfProfile(profileDir, profile);
  const resolved = await resolveBundleRows(bundles, installAnchor, profileDir);
  for (const warning of resolved.warnings) process.stderr.write(`runtime: skipped ${warning}\n`);
  const machine = overrides(configPath);
  const rows: Row[] = [];
  for (const row of resolved.rows) {
    const override = machine.get(row.id);
    const config = merge(row.config ?? {}, override?.config ?? {});
    const disabled = override?.disabled ?? row.disabled === true;
    let entry = "";
    try {
      entry = entryOf(row.name, profileDir);
    } catch (error) {
      process.stderr.write(
        `runtime: ${row.id} names ${row.name}, which does not resolve: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    rows.push({ id: row.id, name: row.name, disabled, config, entry });
  }
  return rows;
}
