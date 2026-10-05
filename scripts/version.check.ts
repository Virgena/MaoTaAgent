import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const skipped = new Set(["node_modules", "lib", "dist", "target", ".git"]);
const manifests: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name === "package.json") manifests.push(path);
  }
};
for (const group of ["packages", "apps", "i18n"]) walk(join(root, group));
const expected = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const problems: string[] = [];
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "@virgena/maota" && manifest.name?.startsWith("@maota/") !== true) continue;
  if (manifest.version !== expected) problems.push(`${manifest.name}: ${String(manifest.version)} != ${expected}`);
}
for (const problem of problems) console.log(`FAIL ${problem}`);
console.log(problems.length === 0 ? `versions ok: @maota/* and @virgena/maota match ${expected}` : `${problems.length} version mismatches`);
if (problems.length > 0) process.exitCode = 1;