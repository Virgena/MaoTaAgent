#!/usr/bin/env node
/// Stages a self-contained Windows desktop build: no Node install, no Rust, no
/// pnpm, no symlinks. Output: dist/desktop/MaoTa-<version>-win32-x64.zip
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const parent = join(root, "..");
const out = join(root, "dist", "desktop");
const work = join(out, "work");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
const skipDirs = new Set([".git", "node_modules", "target", ".maota", ".webview", ".cache", "tmp"]);
const log = (message) => process.stdout.write(`${message}\n`);

function goBinary() {
  const candidates = [process.env.GO, join(parent, "tools", "go", "bin", "go.exe"), "go"];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    if (candidate === "go") return candidate;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("desktop: no go binary (set GO)");
}

function goEnv() {
  const gopath = process.env.GOPATH ?? (existsSync(join(parent, "gopath")) ? join(parent, "gopath") : join(out, "gopath"));
  const cache = join(out, ".gocache");
  const tmp = join(out, ".gotmp");
  mkdirSync(cache, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return {
    ...process.env,
    GOPATH: gopath,
    GOCACHE: cache,
    GOTMPDIR: tmp,
    GOFLAGS: "-mod=mod",
    GOWORK: "off",
  };
}

function copyPackage(from, to) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const name = basename(source);
      if (source === from) return true;
      if (skipDirs.has(name)) return false;
      if (name.endsWith(".ts") || name.endsWith(".tsx")) return false;
      return true;
    },
  });
}

function packageDirs(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (skipDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (nameOf(path) !== undefined) found.push(path);
    packageDirs(path, found);
  }
  return found;
}

function nameOf(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).name;
  } catch {
    return undefined;
  }
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function resolveFrom(dir, name) {
  const require = createRequire(join(dir, "package.json"));
  let entry;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch {
    entry = require.resolve(name);
  }
  let at = dirname(entry);
  for (;;) {
    const manifest = join(at, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).name === name) return at;
      } catch {}
    }
    const next = dirname(at);
    if (next === at) throw new Error(`desktop: cannot locate the package directory of ${name} from ${dir}`);
    at = next;
  }
}

function productionClosure(anchors) {
  const found = new Map();
  const conflicts = [];
  const visit = (name, fromDir) => {
    if (found.has(name)) return;
    const dir = resolveFrom(fromDir, name);
    const manifest = readManifest(dir);
    if (fromDir !== undefined && found.has(name) && found.get(name) !== dir) {
      conflicts.push(`${name}: ${found.get(name)} vs ${dir}`);
    }
    found.set(name, dir);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, dir);
  };
  for (const anchor of anchors) {
    const manifest = readManifest(anchor);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, anchor);
  }
  if (conflicts.length > 0) {
    throw new Error(`desktop: two versions of one package cannot share a flat node_modules:\n  ${conflicts.join("\n  ")}`);
  }
  return found;
}

function dropTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

function stageSources() {
  mkdirSync(work, { recursive: true });
  const manifest = { name: "maota-app", private: true, type: "module", version };
  writeFileSync(join(work, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);

  for (const group of ["apps/cli", "apps/web", "packages", "i18n"]) {
    const from = join(root, group);
    if (!existsSync(from)) continue;
    const to = join(work, group);
    mkdirSync(dirname(to), { recursive: true });
    copyPackage(from, to);
  }
  dropTree(join(work, "apps", "web", "ui"));
  dropTree(join(work, "apps", "desktop"));
}

function workspacePackages() {
  const found = new Map();
  for (const group of ["apps/cli", "apps/web", "packages", "i18n"]) {
    const base = join(root, group);
    for (const dir of [base, ...packageDirs(base)]) {
      const name = nameOf(dir);
      if (name !== undefined && !found.has(name)) found.set(name, dir);
    }
  }
  return found;
}

function linkWorkspace(workspace) {
  for (const [name, dir] of workspace) {
    if (name.startsWith("@virgena/")) continue;
    const to = join(work, "node_modules", ...name.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyPackage(dir, to);
  }
}

function linkThirdParty(workspace) {
  const closure = productionClosure([...workspace.values()]);
  let bytes = 0;
  for (const [name, dir] of closure) {
    if (name.startsWith("@maota/") || name.startsWith("@virgena/") || name.startsWith("@dsh/")) continue;
    const to = join(work, "node_modules", ...name.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyPackage(dir, to);
    bytes += 1;
  }
  return bytes;
}

function installKernel() {
  const blmoadllRoot = process.env.BLMOADLL_ROOT ?? join(parent, "blmoadll");
  const binary =
    process.env.BLMOADLL_BIN ??
    [
      join(blmoadllRoot, "bin", "blmoadll.exe"),
      join(blmoadllRoot, "target", "release", "blmoadll.exe"),
      join(blmoadllRoot, "target", "debug", "blmoadll.exe"),
      join(root, "node_modules", "@virgena", "blmoadll", "bin", "blmoadll.exe"),
    ].find((path) => existsSync(path));
  if (binary === undefined) throw new Error("desktop: no blmoadll.exe (set BLMOADLL_BIN or build the kernel)");
  const target = join(work, "node_modules", "@virgena", "blmoadll");
  mkdirSync(join(target, "bin"), { recursive: true });
  for (const file of ["index.js", "index.d.ts", "bin.js", "LICENSE"]) {
    const from = join(blmoadllRoot, file);
    if (existsSync(from)) copyFileSync(from, join(target, file));
  }
  const manifest = readManifest(blmoadllRoot);
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.optionalDependencies = {};
  writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
  copyFileSync(binary, join(target, "bin", "blmoadll.exe"));
  return binary;
}

function installNode() {
  const node = process.env.MAOTA_NODE ?? process.execPath;
  const name = basename(node).toLowerCase();
  if (name !== "node.exe" && name !== "node") throw new Error(`desktop: MAOTA_NODE must be a standalone node, got ${node}`);
  if (node.includes(".pnpm") || node.includes("shim")) throw new Error(`desktop: MAOTA_NODE looks like a wrapper: ${node}`);
  if (statSync(node).size < 40 * 1024 * 1024) throw new Error(`desktop: ${node} is too small to be a full node runtime`);
  copyFileSync(node, join(work, "node.exe"));
  return node;
}

function buildShell() {
  const env = goEnv();
  const result = spawnSync(
    goBinary(),
    ["build", "-trimpath", "-tags", "desktop,production", "-ldflags", `-H windowsgui -s -w -X main.version=${version}`, "-o", join(work, "maota.exe"), "."],
    { cwd: join(root, "apps", "desktop"), env, encoding: "utf8", stdio: "inherit" },
  );
  if ((result.status ?? 1) !== 0) throw new Error(`desktop: go build exited ${result.status}`);
}

/// The icon, the version fields and the manifest live in apps/desktop/build;
/// Go only links them through a .syso beside the package.
function ensureResources() {
  const dir = join(root, "apps", "desktop");
  if (existsSync(join(dir, "rsrc_windows_amd64.syso"))) return;
  log("  generate windows resources");
  const result = spawnSync(
    goBinary(),
    [
      "run",
      "github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.7.0",
      "-icon",
      join("build", "appicon.ico"),
      "-manifest",
      join("build", "maota.manifest"),
      "-o",
      "rsrc_windows_amd64.syso",
      join("build", "versioninfo.json"),
    ],
    { cwd: dir, env: goEnv(), encoding: "utf8", stdio: "inherit" },
  );
  if ((result.status ?? 1) !== 0) throw new Error(`desktop: windows resources exited ${result.status}`);
}

/// SmartScreen trusts a signed binary and the publisher's reputation; nothing in
/// this tree can earn that. Set MAOTA_SIGN_CERT (plus MAOTA_SIGN_PASSWORD when
/// the certificate has one) and the shell is signed; otherwise it ships unsigned
/// and Windows may ask the user to confirm.
function sign(file: string): void {
  const cert = process.env.MAOTA_SIGN_CERT ?? "";
  if (cert === "") return;
  const args = [
    "sign",
    "/fd",
    "SHA256",
    "/td",
    "SHA256",
    "/tr",
    process.env.MAOTA_SIGN_TIMESTAMP ?? "http://timestamp.digicert.com",
    "/f",
    cert,
  ];
  if ((process.env.MAOTA_SIGN_PASSWORD ?? "") !== "") args.push("/p", process.env.MAOTA_SIGN_PASSWORD!);
  args.push(file);
  log(`  sign ${basename(file)}`);
  const result = spawnSync(process.env.MAOTA_SIGNTOOL ?? "signtool", args, {
    encoding: "utf8",
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) throw new Error(`desktop: signing ${file} failed`);
}

function assertStaged() {
  const required = [
    "maota.exe",
    "node.exe",
    "apps/cli/lib/index.js",
    "apps/web/dist/index.html",
    "node_modules/@maota/app-boot/lib/index.js",
    "node_modules/@maota/plugin-kit/lib/index.js",
    "node_modules/@virgena/blmoadll/bin/blmoadll.exe",
    "README.txt",
  ];
  const missing = required.filter((path) => !existsSync(join(work, path)));
  if (missing.length > 0) throw new Error(`desktop: staged tree is missing ${missing.join(", ")}`);

  const links = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) links.push(relative(work, path));
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(work);
  if (links.length > 0) throw new Error(`desktop: staged tree still holds links:\n  ${links.slice(0, 10).join("\n  ")}`);

  const probe = join(out, ".probe-home");
  dropTree(probe);
  const env = {
    ...process.env,
    MAOTA_HOME: probe,
    NODE_ENV: "production",
    PATH: `${work};C:\\Windows\\System32;C:\\Windows`,
  };
  for (const profile of ["default", "serve"]) {
    const result = spawnSync(join(work, "node.exe"), [join(work, "apps/cli/lib/index.js"), "check", "--profile", profile], {
      cwd: work,
      env: { ...env, MAOTA_HOME: join(probe, profile) },
      encoding: "utf8",
      timeout: 180000,
    });
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `desktop: staged app failed its own ${profile} check:\n${(result.stderr ?? "").slice(-4000)}${(result.stdout ?? "").slice(-4000)}`,
      );
    }
  }
  dropTree(probe);
}

function sizeOf(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (lstatSync(path).isSymbolicLink()) continue;
    bytes += entry.isDirectory() ? sizeOf(path) : statSync(path).size;
  }
  return bytes;
}

function writeReadme() {
  writeFileSync(
    join(work, "README.txt"),
    [
      "MaoTa",
      "",
      "双击 maota.exe 运行。不要双击 zip；zip 只用于传输，先解压整个文件夹。",
      "程序已经开着时再双击，只会把窗口叫到前面。",
      "配置与会话存在 %APPDATA%\\MaoTa。",
      "出问题看 %LOCALAPPDATA%\\MaoTa\\logs\\desktop.log。",
      "",
    ].join("\r\n"),
  );
}

function zip() {
  const name = `MaoTa-${version}-win32-x64.zip`;
  const target = join(out, name);
  rmSync(target, { force: true });
  const tar = spawnSync("tar", ["-a", "-c", "-f", target, "-C", work, "."], { encoding: "utf8" });
  if ((tar.status ?? 1) !== 0) {
    const powershell = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${work}\\*' -DestinationPath '${target}' -Force`],
      { encoding: "utf8" },
    );
    if ((powershell.status ?? 1) !== 0) throw new Error(`desktop: zip failed: ${tar.stderr} ${powershell.stderr}`);
  }
  return { target, name };
}

main();

function main() {
  log(`desktop: staging ${version}`);
  dropTree(work);

  log("  copy sources");
  stageSources();

  log("  copy workspace packages");
  const workspace = workspacePackages();
  linkWorkspace(workspace);

  log("  copy production dependencies");
  const count = linkThirdParty(workspace);
  log(`    ${count} packages`);

  log("  install kernel");
  installKernel();
  log("  install node runtime");
  installNode();
  log("  build window shell");
  ensureResources();
  buildShell();
  sign(join(work, "maota.exe"));
  log("  write readme");
  writeReadme();
  log("  verify staged tree");
  assertStaged();
  const bytes = sizeOf(work);
  log("  zip");
  const { target, name } = zip();
  log(`desktop: ok ${name} ${(statSync(target).size / 1024 / 1024).toFixed(1)} MB (tree ${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}
