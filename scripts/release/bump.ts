import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const skipped = new Set(["node_modules", "lib", "dist", "target", ".git"]);

function manifests(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "package.json") found.push(path);
    }
  };
  for (const group of ["packages", "apps", "i18n"]) walk(join(root, group));
  return found;
}

function owned(path: string): boolean {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { name?: string };
  return manifest.name === "@virgena/maota" || manifest.name?.startsWith("@maota/") === true;
}

function nextVersion(current: string, request: string): string {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(request)) return request;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (match === null) throw new Error(`cannot read current version ${current}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (request === "major") return `${major + 1}.0.0`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error("usage: node scripts/release/bump.ts <major|minor|patch|x.y.z> [--dry-run]");
}

const request = process.argv[2];
if (request === undefined) throw new Error("usage: node scripts/release/bump.ts <major|minor|patch|x.y.z> [--dry-run]");
const dryRun = process.argv.includes("--dry-run");
const rootPath = join(root, "package.json");
const rootManifest = JSON.parse(readFileSync(rootPath, "utf8")) as { version?: string };
const version = nextVersion(rootManifest.version ?? "0.0.0", request);
const paths = [rootPath, ...manifests().filter(owned)];
console.log(`release bump: ${rootManifest.version ?? "missing"} -> ${version}`);
for (const path of paths) console.log(`  ${relative(root, path)}`);
if (dryRun) process.exit(0);

for (const path of paths) {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { version?: string };
  manifest.version = version;
  writeFileSync(path, JSON.stringify(manifest, undefined, 2) + "\n");
}
const install = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if ((install.status ?? 1) !== 0) process.exit(install.status ?? 1);
const staged = ["package.json", "pnpm-lock.yaml", ...paths.slice(1).map((path) => relative(root, path))];
spawnSync("git", ["add", ...staged], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
const commit = spawnSync("git", ["commit", "-m", `release(maota): ${version}`], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
process.exit(commit.status ?? 1);