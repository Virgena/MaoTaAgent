import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const out = join(root, "dist", "npm");
const skipped = new Set(["node_modules", "lib", "dist", "target", ".git"]);
interface Manifest { name: string; version: string; dependencies?: Record<string, string>; maota?: { bundle?: { patch?: string } } }
const found: Array<{ path: string; manifest: Manifest }> = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name === "package.json") {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
      if (manifest.name === "@virgena/maota" || manifest.name.startsWith("@maota/")) found.push({ path, manifest });
    }
  }
};
for (const group of ["packages", "apps", "i18n"]) walk(join(root, group));
const byName = new Map(found.map((entry) => [entry.manifest.name, entry]));
const order: typeof found = [];
const seen = new Set<string>();
const visiting = new Set<string>();
function visit(name: string): void {
  if (seen.has(name)) return;
  if (visiting.has(name)) throw new Error(`workspace dependency cycle at ${name}`);
  const entry = byName.get(name);
  if (entry === undefined) return;
  visiting.add(name);
  for (const dep of Object.keys(entry.manifest.dependencies ?? {})) visit(dep);
  visiting.delete(name);
  seen.add(name);
  order.push(entry);
}
for (const entry of found) visit(entry.manifest.name);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of order) {
  const dir = dirname(entry.path);
  const packed = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (packed.error) throw packed.error;
  if ((packed.status ?? 1) !== 0) throw new Error(`${entry.manifest.name}: pnpm pack exited ${packed.status}`);
  const tarball = join(out, `${entry.manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${entry.manifest.version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`${entry.manifest.name}: expected ${tarball}`);
  const files = spawnSync("tar", ["-tf", tarball], { encoding: "utf8" });
  if ((files.status ?? 1) !== 0) throw new Error(`${entry.manifest.name}: tar failed`);
  const list = files.stdout ?? "";
  if (!list.includes("package/package.json")) throw new Error(`${entry.manifest.name}: package.json missing`);
  if (list.includes("package/lib/index.js") === false) throw new Error(`${entry.manifest.name}: lib/index.js missing`);
  const patch = entry.manifest.maota?.bundle?.patch;
  if (patch !== undefined && !list.includes(`package/${patch.replace(/^\.\//, "")}`)) throw new Error(`${entry.manifest.name}: ${patch} missing`);
  const packaged = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
  if ((packaged.status ?? 1) !== 0) throw new Error(`${entry.manifest.name}: cannot read packed package.json`);
  if (packaged.stdout?.includes("workspace:")) throw new Error(`${entry.manifest.name}: packed manifest still contains workspace:`);
}
console.log(`pack ok: ${order.length} tarballs in ${relative(root, out)}`);