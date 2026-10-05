#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", "dist", "lib", "target", "tmp"]);
const WATCHED = ["packages", "apps", "i18n", "scripts"];
const IMPORT = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)"([^"]+)"/g;

function at(path: string): string {
  return relative(root, path).split("\\").join("/");
}

function sourcesUnder(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) sourcesUnder(join(dir, entry.name), found);
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function manifestOf(file: string): string {
  let dir = dirname(file);
  while (dir !== root) {
    if (isWorkspacePackage(dir)) return join(dir, "package.json");
    dir = dirname(dir);
  }
  return join(root, "package.json");
}

/// The workspace globs, so a directory pnpm does not install is read as what it
/// actually is: a file whose imports resolve through the repository root.
function workspaceGlobs(): RegExp[] {
  const found: string[] = [];
  let inside = false;
  for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/)) {
    if (/^packages:/.test(line)) {
      inside = true;
    } else if (inside) {
      const match = /^\s+-\s+(.+?)\s*$/.exec(line);
      if (match === null) {
        if (line.trim() !== "") inside = false;
      } else {
        found.push(match[1]!);
      }
    }
  }
  return found.map((glob) => {
    const body = glob
      .split("")
      .map((character) =>
        character === "*" ? "[^/]+" : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${body}$`);
  });
}

const globs = workspaceGlobs();

function isWorkspacePackage(dir: string): boolean {
  const path = at(dir);
  return existsSync(join(dir, "package.json")) && globs.some((glob) => glob.test(path));
}

const cached = new Map<string, Set<string>>();

function declarations(manifest: string): Set<string> {
  const known = cached.get(manifest);
  if (known !== undefined) return known;
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const names = new Set([
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
    ...Object.keys(parsed.peerDependencies ?? {}),
  ]);
  cached.set(manifest, names);
  return names;
}

function packageOf(specifier: string): string | null {
  if (specifier === "@virgena/blmoadll") return specifier;
  if (!specifier.startsWith("@maota/")) return null;
  return specifier.split("/").slice(0, 2).join("/");
}

const problems: string[] = [];
let files = 0;

for (const dir of WATCHED) {
  for (const file of sourcesUnder(join(root, dir))) {
    files += 1;
    const manifest = manifestOf(file);
    const names = declarations(manifest);
    const reported = new Set<string>();
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const name = packageOf(match[1] ?? "");
      if (name === null || names.has(name) || reported.has(name)) continue;
      reported.add(name);
      problems.push(`${at(file)} imports \`${name}\`, which ${at(manifest)} does not declare`);
    }
  }
}

for (const problem of problems) console.log(problem);
console.log(problems.length === 0 ? `imports ok: ${files} files declare what they import` : `${problems.length} undeclared imports`);
if (problems.length > 0) process.exitCode = 1;
