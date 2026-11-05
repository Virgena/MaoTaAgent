import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { PROTOCOL_VERSION } from "@maota/plugin-kit";
import { kernel as installedKernel } from "@virgena/blmoadll";
import { satisfies } from "semver";
import { parse } from "smol-toml";

export const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

export interface ConfigChoice {
  explicit?: string | undefined;
  env?: NodeJS.ProcessEnv;
  profile?: string | undefined;
  home?: string | undefined;
  root?: string | undefined;
}

export interface KernelChoice {
  explicit?: string | undefined;
  env?: NodeJS.ProcessEnv;
  installed?: string | null;
  root?: string;
}

export interface PluginRow {
  id: string;
  name: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

/// The `[kernel.host]` row: the one Node process that hosts every eligible Node
/// plugin. The launcher writes it on every run, so the user never edits it.
export interface HostRow {
  command: string;
  args: string[];
}

export interface PluginPatchInsert {
  insert: PluginRow[];
}

export interface PluginPatchUpdate {
  id: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

export type PluginPatch = PluginPatchInsert | PluginPatchUpdate;

export interface BundlePluginRow extends PluginRow {
  bundle: string;
  root: string;
}

export interface BundleRows {
  rows: BundlePluginRow[];
  warnings: string[];
}

export interface ProfileTemplate {
  bundles: readonly string[];
}

export const DEFAULT_PROFILE = "default";

export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  default: { bundles: ["@maota/base"] },
  serve: { bundles: ["@maota/base", "@maota/web-bundle"] },
};

const PROFILES = "profiles";
const GENERATED = "blmoadll.toml";
const USER_LAYER = "blmoadll.local.toml";

interface BundleManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  maota?: { bundle?: { patch?: string; protocol?: number } };
}

interface ProfileManifest {
  maota?: { profile?: { bundles?: string[] } };
}

interface LoadedBundle {
  name: string;
  root: string;
  patches: PluginPatch[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function maotaHome(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.MAOTA_HOME;
  return named !== undefined && named !== "" ? named : join(homedir(), ".maota");
}

export function profileDir(home: string, profile: string): string {
  if (!Object.hasOwn(PROFILE_TEMPLATES, profile)) {
    throw new Error(`maota: unknown profile ${JSON.stringify(profile)} (known: ${Object.keys(PROFILE_TEMPLATES).join(", ")})`);
  }
  return join(home, PROFILES, profile);
}

function requireFrom(root: string) {
  return createRequire(join(root, "package.json"));
}

export function packageDir(name: string, root: string = repoRoot): string {
  try {
    return dirname(requireFrom(root).resolve(`${name}/package.json`));
  } catch (error) {
    throw new Error(`maota: cannot find ${name} from ${root}: ${messageOf(error)}`);
  }
}

export function entryOf(name: string, root: string = repoRoot): string {
  try {
    return requireFrom(root).resolve(name);
  } catch (error) {
    throw new Error(`maota: cannot resolve the entry of ${name} from ${root}: ${messageOf(error)}`);
  }
}

function packageDirFromAnchor(anchor: string, name: string): string | undefined {
  try {
    return dirname(createRequire(anchor).resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

export function resolveBundleDir(name: string, installAnchor: string, profileDirPath: string): string {
  const anchors = [join(installAnchor, "package.json"), join(profileDirPath, "package.json")];
  for (const anchor of anchors) {
    const dir = packageDirFromAnchor(anchor, name);
    if (dir !== undefined) return dir;
  }
  throw new Error(`maota: cannot resolve bundle ${name} from ${installAnchor} or ${profileDirPath}`);
}

export function bundlesOfProfile(dir: string, profile: string): readonly string[] {
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    const parsed = readJson(manifest) as ProfileManifest;
    const bundles = parsed.maota?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.length > 0) return bundles;
  }
  const template = PROFILE_TEMPLATES[profile];
  return template === undefined ? [] : template.bundles;
}

function readPluginRow(value: unknown, bundle: string, patch: string): PluginRow {
  if (!isRecord(value)) throw new Error(`${bundle}: ${patch} row must be a table`);
  if (typeof value.id !== "string" || value.id === "") throw new Error(`${bundle}: ${patch} row needs a non-empty id`);
  if (typeof value.name !== "string" || value.name === "") throw new Error(`${bundle}: ${patch} row ${value.id} needs a non-empty name`);
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
    throw new Error(`${bundle}: ${patch} row ${value.id} disabled must be boolean`);
  }
  if (value.config !== undefined && !isRecord(value.config)) {
    throw new Error(`${bundle}: ${patch} row ${value.id} config must be a table`);
  }
  return {
    id: value.id,
    name: value.name,
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
    ...(value.config === undefined ? {} : { config: value.config }),
  };
}

function readPluginPatch(value: unknown, bundle: string, path: string): PluginPatch {
  if (!isRecord(value)) throw new Error(`${bundle}: ${path} patch entry must be a table`);
  const keys = Object.keys(value);
  if (value.insert !== undefined) {
    if (keys.some((key) => key !== "insert")) throw new Error(`${bundle}: ${path} insert patch has extra keys`);
    if (!Array.isArray(value.insert)) throw new Error(`${bundle}: ${path} insert must be an array`);
    return { insert: value.insert.map((row) => readPluginRow(row, bundle, path)) };
  }
  if (typeof value.id !== "string" || value.id === "") throw new Error(`${bundle}: ${path} update patch needs a non-empty id`);
  if (value.name !== undefined && (typeof value.name !== "string" || value.name === "")) {
    throw new Error(`${bundle}: ${path} update patch ${value.id} name must be a non-empty string`);
  }
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
    throw new Error(`${bundle}: ${path} update patch ${value.id} disabled must be boolean`);
  }
  if (value.config !== undefined && !isRecord(value.config)) {
    throw new Error(`${bundle}: ${path} update patch ${value.id} config must be a table`);
  }
  const allowed = new Set(["id", "name", "disabled", "config"]);
  for (const key of keys) if (!allowed.has(key)) throw new Error(`${bundle}: ${path} update patch ${value.id} has unknown key ${key}`);
  return {
    id: value.id,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
    ...(value.config === undefined ? {} : { config: value.config }),
  };
}

function readPatches(path: string, bundle: string): PluginPatch[] {
  const parsed = parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.patch)) throw new Error(`${bundle}: ${path} must contain a [[patch]] array`);
  return parsed.patch.map((item) => readPluginPatch(item, bundle, path));
}

function validateCompatibility(bundle: string, manifest: BundleManifest, root: string): void {
  const declaration = manifest.maota?.bundle;
  if (declaration?.protocol !== PROTOCOL_VERSION) {
    throw new Error(`${bundle}: requires protocol ${String(declaration?.protocol ?? "missing")}, runtime provides ${PROTOCOL_VERSION}`);
  }
  const peer = manifest.peerDependencies?.["@maota/plugin-kit"];
  if (peer === undefined || peer === "") throw new Error(`${bundle}: must declare a peer range for @maota/plugin-kit`);
  const pluginKit = packageDir("@maota/plugin-kit", root);
  const version = (readJson(join(pluginKit, "package.json")) as { version?: unknown }).version;
  if (typeof version !== "string" || !satisfies(version, peer, { includePrerelease: true })) {
    throw new Error(`${bundle}: requires @maota/plugin-kit ${peer}, runtime provides ${String(version ?? "unknown")}`);
  }
}

function validateRowsOwned(bundle: string, manifest: BundleManifest, patches: readonly PluginPatch[]): void {
  for (const patch of patches) {
    if (!("insert" in patch)) continue;
    for (const row of patch.insert) {
      if (manifest.dependencies?.[row.name] === undefined) {
        throw new Error(`${bundle}: row ${row.id} names ${row.name}, which is not a dependency`);
      }
    }
  }
}

async function loadBundles(
  bundles: readonly string[],
  installAnchor: string,
  profileDirPath: string,
): Promise<{ layers: LoadedBundle[]; warnings: string[] }> {
  const layers: LoadedBundle[] = [];
  const warnings: string[] = [];
  for (const bundle of bundles) {
    try {
      const root = resolveBundleDir(bundle, installAnchor, profileDirPath);
      const manifest = readJson(join(root, "package.json")) as BundleManifest;
      const path = manifest.maota?.bundle?.patch;
      if (typeof path !== "string" || path === "") throw new Error(`${bundle}: package.json declares no maota.bundle.patch`);
      validateCompatibility(bundle, manifest, installAnchor);
      const patches = readPatches(join(root, path), bundle);
      validateRowsOwned(bundle, manifest, patches);
      layers.push({ name: bundle, root, patches });
    } catch (error) {
      warnings.push(`${bundle}: ${messageOf(error)}`);
    }
  }
  return { layers, warnings };
}

export function applyPluginPatches(
  rows: readonly BundlePluginRow[],
  patches: readonly PluginPatch[],
  bundle: string,
  root: string,
): BundleRows {
  const result = [...rows];
  const warnings: string[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < result.length; i += 1) index.set(result[i]!.id, i);

  for (const patch of patches) {
    if ("insert" in patch) {
      for (const row of patch.insert) {
        const owned = { ...row, bundle, root };
        const existing = index.get(row.id);
        if (existing === undefined) {
          index.set(row.id, result.length);
          result.push(owned);
        } else {
          result[existing] = owned;
        }
      }
      continue;
    }

    const at = index.get(patch.id);
    if (at === undefined) {
      warnings.push(`${bundle}: patch target ${patch.id} does not exist`);
      continue;
    }
    const target = result[at]!;
    if (patch.name !== undefined && patch.name !== target.name) {
      warnings.push(`${bundle}: patch ${patch.id} expects ${patch.name}, found ${target.name}`);
      continue;
    }
    result[at] = {
      ...target,
      ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }),
      ...(patch.config === undefined ? {} : { config: patch.config }),
    };
  }
  return { rows: result, warnings };
}

export async function resolveBundleRows(
  bundles: readonly string[],
  installAnchor: string = repoRoot,
  profileDirPath: string = installAnchor,
): Promise<BundleRows> {
  const loaded = await loadBundles(bundles, installAnchor, profileDirPath);
  let rows: BundlePluginRow[] = [];
  const warnings = [...loaded.warnings];
  for (const layer of loaded.layers) {
    const applied = applyPluginPatches(rows, layer.patches, layer.name, layer.root);
    rows = applied.rows;
    warnings.push(...applied.warnings);
  }
  return { rows, warnings };
}

export async function resolvedRowsOfBundles(
  bundles: readonly string[],
  root: string = repoRoot,
  profileDirPath: string = root,
): Promise<BundlePluginRow[]> {
  return (await resolveBundleRows(bundles, root, profileDirPath)).rows;
}

export async function rowsOfBundles(bundles: readonly string[], root: string = repoRoot): Promise<PluginRow[]> {
  const rows = await resolvedRowsOfBundles(bundles, root);
  return rows.map(({ id, name, disabled, config }) => ({
    id,
    name,
    ...(disabled === undefined ? {} : { disabled }),
    ...(config === undefined ? {} : { config }),
  }));
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  throw new Error(`a config value has no TOML form: ${JSON.stringify(value)}`);
}

const HEADER: string[] = [
  "# MaoTa's plugin set for one profile: one provider per capability id.",
  "#",
  "# Generated from the bundles this profile lists (maota.profile.bundles in the package.json",
  "# beside this file). A bundle's patch names every row it inserts or updates, and every",
  "# inserted package resolves from that bundle's own dependency tree. Never edit this file:",
  "# overrides belong in blmoadll.local.toml beside it.",
  "",
];

export function renderConfig(
  rows: readonly PluginRow[],
  host: HostRow | null = null,
  runtime: HostRow | null = null,
): string {
  const lines: string[] = [...HEADER];
  if (runtime !== null) {
    lines.push("[kernel.runtime]");
    lines.push(`command = ${tomlValue(runtime.command)}`);
    lines.push(`args = [${runtime.args.map(tomlValue).join(", ")}]`);
    lines.push("");
  }
  if (host !== null) {
    lines.push("[kernel.host]");
    lines.push(`command = ${tomlValue(host.command)}`);
    lines.push(`args = [${host.args.map(tomlValue).join(", ")}]`);
    lines.push("");
  }
  for (const row of rows) {
    lines.push(`[plugins.${row.id}]`);
    if (row.disabled === true) lines.push("disabled = true");
    lines.push(`name = ${tomlValue(row.name)}`);
    if (row.config !== undefined) {
      lines.push(`[plugins.${row.id}.config]`);
      for (const [key, value] of Object.entries(row.config)) lines.push(`${key} = ${tomlValue(value)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/// A Windows junction is a directory to Node: `lstat` reports a directory and
/// `readlink` refuses it, so the only proof that the path already holds the
/// directory we want is the file identity both stats share.
function sameDirectory(link: string, target: string): boolean {
  try {
    const left = statSync(link);
    const right = statSync(target);
    return left.ino === right.ino && left.dev === right.dev;
  } catch {
    return false;
  }
}

function linkPackage(dir: string, row: BundlePluginRow): void {
  let target: string;
  try {
    target = packageDir(row.name, row.root);
  } catch (error) {
    throw new Error(`maota: the row ${row.id} names ${row.name}: ${messageOf(error)}`);
  }
  const link = join(dir, "node_modules", ...row.name.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
    if (sameDirectory(link, target)) return;
    let dangling = false;
    try {
      statSync(link);
    } catch {
      dangling = true;
    }
    if (!dangling) {
      throw new Error(`maota: ${link} already exists and is not the link to ${target}; move it, then boot again`);
    }
    try {
      rmdirSync(link);
    } catch {
      unlinkSync(link);
    }
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/// The runtime row this launch would write. A checkout where the runtime
/// package cannot be resolved still boots: without the row the kernel keeps the
/// legacy arrangement, one process per plugin row.
function runtimeRow(root: string, profileDir: string, profile: string): HostRow | null {
  try {
    return {
      command: process.execPath,
      args: [entryOf("@maota/runtime", root), profileDir, root, profile],
    };
  } catch (error) {
    process.stderr.write(`MaoTa: no runtime (${messageOf(error)}); the kernel keeps the legacy plugin path\n`);
    return null;
  }
}

export async function ensureProfile(
  home: string,
  profile: string = DEFAULT_PROFILE,
  root: string = repoRoot,
): Promise<string> {
  const dir = profileDir(home, profile);
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    const template = PROFILE_TEMPLATES[profile];
    writeFileSync(
      manifest,
      JSON.stringify(
        { name: `maota-profile-${profile}`, private: true, dependencies: {}, maota: { profile: { bundles: [...(template?.bundles ?? [])] } } },
        undefined,
        2,
      ) + "\n",
    );
  }
  const resolved = await resolveBundleRows(bundlesOfProfile(dir, profile), root, dir);
  for (const warning of resolved.warnings) process.stderr.write(`MaoTa: skipped ${warning}\n`);
  for (const row of resolved.rows) linkPackage(dir, row);
  const rendered = renderConfig(resolved.rows, null, runtimeRow(root, dir, profile));
  const target = join(dir, GENERATED);
  if (!existsSync(target) || readFileSync(target, "utf8") !== rendered) {
    writeFileSync(target, rendered);
    process.stderr.write(`MaoTa: wrote ${target}\n`);
  }
  return dir;
}

export async function resolveConfigPath(choice: ConfigChoice = {}): Promise<string> {
  const env = choice.env ?? process.env;
  const explicit = choice.explicit ?? env.BLMOADLL_CONFIG;
  if (explicit !== undefined && explicit !== "") return explicit;
  const profile = choice.profile ?? DEFAULT_PROFILE;
  const home = choice.home ?? maotaHome(env);
  const root = choice.root ?? repoRoot;
  const dir = choice.home === undefined ? await ensureProfile(home, profile, root) : profileDir(home, profile);
  const user = join(dir, USER_LAYER);
  return existsSync(user) ? user : join(dir, GENERATED);
}

export function resolveKernelBin(choice: KernelChoice = {}): string {
  const env = choice.env ?? process.env;
  const root = choice.root ?? repoRoot;
  const installed = choice.installed === undefined ? installedKernel : choice.installed;
  return (
    choice.explicit ??
    env.BLMOADLL_BIN ??
    installed ??
    join(root, "..", "blmoadll", "target", "debug", "blmoadll.exe")
  );
}