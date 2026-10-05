import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureProfile, maotaHome, profileDir, resolveBundleDir } from "@maota/app-boot";

interface ProfileManifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  maota?: { profile?: { bundles?: string[] } };
}

interface PluginCommand {
  action: string;
  args: string[];
  profile?: string | undefined;
  cwd: string;
  installAnchor: string;
}

function readManifest(dir: string): ProfileManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as ProfileManifest;
}

function writeManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, undefined, 2) + "\n");
}

function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
  if (match?.groups?.path === undefined) return argument;
  return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
}

function packageManager(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function runPnpm(dir: string, args: readonly string[]): number {
  const result = spawnSync(packageManager(), args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  return result.status ?? 1;
}

function bundleDeclaresPatch(name: string, installAnchor: string, dir: string): boolean {
  try {
    const packageRoot = resolveBundleDir(name, installAnchor, dir);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      maota?: { bundle?: { patch?: unknown } };
    };
    return typeof manifest.maota?.bundle?.patch === "string" && manifest.maota.bundle.patch !== "";
  } catch {
    return false;
  }
}

function reconcile(dir: string, previous: ProfileManifest, installAnchor: string): ProfileManifest {
  const before = new Set(Object.keys(previous.dependencies ?? {}));
  const manifest = readManifest(dir);
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const current = manifest.maota?.profile?.bundles ?? [];
  const bundles = current.filter((name) => !before.has(name) || dependencies.includes(name));
  for (const name of dependencies) {
    if (bundleDeclaresPatch(name, installAnchor, dir) && !bundles.includes(name)) bundles.push(name);
  }
  const updated: ProfileManifest = {
    ...manifest,
    maota: { ...manifest.maota, profile: { ...manifest.maota?.profile, bundles } },
  };
  writeManifest(dir, updated);
  return updated;
}

export async function runPluginCommand(command: PluginCommand): Promise<number> {
  const profile = command.profile ?? "default";
  const home = maotaHome();
  const dir = profileDir(home, profile);
  await ensureProfile(home, profile, command.installAnchor);
  const previous = readManifest(dir);

  if (command.action === "why") return runPnpm(dir, ["why", ...command.args]);
  if (!["add", "remove", "update"].includes(command.action)) {
    console.error(`maota: unknown plugin action ${JSON.stringify(command.action)}`);
    return 2;
  }
  if (command.action === "update") {
    const status = runPnpm(dir, ["update", ...command.args]);
    if (status !== 0) return status;
    reconcile(dir, previous, command.installAnchor);
    await ensureProfile(home, profile, command.installAnchor);
    return 0;
  }

  const args = command.args.map((arg) => anchorPathSpec(arg, command.cwd));
  const status = runPnpm(dir, [command.action, ...args]);
  if (status !== 0) return status;

  const updated = reconcile(dir, previous, command.installAnchor);
  const bundles = updated.maota?.profile?.bundles ?? [];
  const dependencies = Object.keys(updated.dependencies ?? {});
  if (command.action === "add") {
    for (const name of dependencies) {
      if (!bundles.includes(name)) console.error(`maota: ${name} is installed but declares no maota.bundle.patch, so it was not activated`);
    }
  }
  await ensureProfile(home, profile, command.installAnchor);
  return 0;
}