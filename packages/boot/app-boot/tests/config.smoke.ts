import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_PROFILE,
  PROFILE_TEMPLATES,
  applyPluginPatches,
  bundlesOfProfile,
  ensureProfile,
  entryOf,
  maotaHome,
  packageDir,
  profileDir,
  renderConfig,
  repoRoot,
  resolveBundleDir,
  resolveBundleRows,
  resolveConfigPath,
  resolveKernelBin,
} from "../src/index.ts";

const appBootRoot = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "maota-config-"));
const home = join(dir, "home");
const env = { MAOTA_HOME: home } as NodeJS.ProcessEnv;

assert.equal(maotaHome(env), home);
assert.ok(maotaHome({} as NodeJS.ProcessEnv).endsWith(".maota"));
assert.equal(profileDir(home, DEFAULT_PROFILE), join(home, "profiles", "default"));
assert.throws(() => profileDir(home, "nope"), /unknown profile/, "an unknown profile is refused by name");

const base = await resolveBundleRows(PROFILE_TEMPLATES["default"]!.bundles, appBootRoot, appBootRoot);
assert.deepEqual(base.warnings, [], "the shipped base bundle loads cleanly");
assert.equal(base.rows.length, 30);
assert.equal(base.rows.find((row) => row.id === "hmr")?.disabled, true, "the development watcher ships off");
for (const row of base.rows) {
  const manifest = JSON.parse(readFileSync(join(packageDir(row.bundle, appBootRoot), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.[row.name], "workspace:*", `${row.name} should be owned by ${row.bundle}`);
}

const serve = await resolveBundleRows(PROFILE_TEMPLATES["serve"]!.bundles, appBootRoot, appBootRoot);
assert.deepEqual(serve.warnings, [], "the shipped serve bundle loads cleanly");
assert.equal(serve.rows.length, base.rows.length + 1);
assert.equal(serve.rows.at(-1)?.name, "@maota/web");

const generated = await ensureProfile(home, "default", appBootRoot);
assert.equal(generated, join(home, "profiles", "default"));
const config = join(generated, "blmoadll.toml");
const manifest = JSON.parse(readFileSync(join(generated, "package.json"), "utf8")) as {
  maota?: { profile?: { bundles?: string[] } };
};
assert.deepEqual(manifest.maota?.profile?.bundles, ["@maota/base"], "the manifest records the profile's bundles");
assert.deepEqual(bundlesOfProfile(generated, "default"), ["@maota/base"], "the manifest is what boot reads back");

const body = readFileSync(config, "utf8");
for (const row of base.rows) assert.ok(body.includes(`[plugins.${row.id}]`), `${row.id} should be configured`);
for (const row of base.rows) {
  const link = join(generated, "node_modules", ...row.name.split("/"));
  assert.ok(existsSync(join(link, "package.json")), `the profile does not link ${row.name}`);
  assert.equal(realpathSync(link), realpathSync(packageDir(row.name, row.root)), `${row.name} should come from ${row.bundle}`);
}

const rewritten = readFileSync(config, "utf8");
await ensureProfile(home, "default", appBootRoot);
assert.equal(readFileSync(config, "utf8"), rewritten, "a second boot rewrites nothing");
await ensureProfile(home, "serve", appBootRoot);
assert.ok(readFileSync(join(home, "profiles", "serve", "blmoadll.toml"), "utf8").includes("[plugins.web]"));

writeFileSync(join(generated, "blmoadll.local.toml"), "[plugins.tools]\n");
assert.equal(
  await resolveConfigPath({ env, home, root: appBootRoot }),
  join(generated, "blmoadll.local.toml"),
  "the user layer wins when it exists",
);
assert.equal(await resolveConfigPath({ env, home, explicit: join(dir, "given.toml") }), join(dir, "given.toml"));

const insert = { insert: [{ id: "tools", name: "@maota/tools" }] };
const configured = applyPluginPatches([], [insert], "base", "C:\\base");
assert.deepEqual(configured.warnings, []);
assert.deepEqual(configured.rows, [{ id: "tools", name: "@maota/tools", bundle: "base", root: "C:\\base" }]);
const updated = applyPluginPatches(configured.rows, [{ id: "tools", config: { mode: "strict" }, disabled: false }], "extra", "C:\\extra");
assert.deepEqual(updated.warnings, []);
assert.deepEqual(updated.rows, [
  { id: "tools", name: "@maota/tools", config: { mode: "strict" }, disabled: false, bundle: "base", root: "C:\\base" },
]);
assert.match(applyPluginPatches(configured.rows, [{ id: "missing", disabled: true }], "extra", "C:\\extra").warnings[0] ?? "", /does not exist/);
assert.match(applyPluginPatches(configured.rows, [{ id: "tools", name: "@maota/other" }], "extra", "C:\\extra").warnings[0] ?? "", /expects/);
const duplicate = applyPluginPatches(configured.rows, [{ insert: [{ id: "tools", name: "@maota/other" }] }], "extra", "C:\\extra");
assert.equal(duplicate.rows[0]?.name, "@maota/other", "a duplicate insert replaces the earlier row");
assert.equal(duplicate.rows[0]?.bundle, "extra");

const scratch = mkdtempSync(join(tmpdir(), "maota-bundles-"));
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, undefined, 2) + "\n");
}
function linkPackage(root: string, name: string, target: string): void {
  const link = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}
function bundleFixture(
  root: string,
  name: string,
  patch: string,
  dependencies: Record<string, string> = {},
  peer = "^0.1.0",
  protocol = 3,
): string {
  const packageRoot = join(root, "bundles", name.replace("/", "-"));
  writeJson(join(packageRoot, "package.json"), {
    name,
    version: "0.1.0",
    type: "module",
    maota: { bundle: { patch: "./patch.toml", protocol } },
    dependencies,
    peerDependencies: { "@maota/plugin-kit": peer },
  });
  writeFileSync(join(packageRoot, "patch.toml"), patch);
  linkPackage(root, name, packageRoot);
  return packageRoot;
}
function pluginFixture(root: string, name: string): string {
  const packageRoot = join(root, "plugins", name.replace("/", "-"));
  writeJson(join(packageRoot, "package.json"), {
    name,
    version: "0.1.0",
    type: "module",
    main: "index.js",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  });
  writeFileSync(join(packageRoot, "index.js"), "export {};\n");
  return packageRoot;
}

writeJson(join(scratch, "package.json"), { name: "scratch", private: true, type: "module" });
const kit = join(scratch, "plugins", "plugin-kit");
writeJson(join(kit, "package.json"), { name: "@maota/plugin-kit", version: "0.1.0", type: "module" });
linkPackage(scratch, "@maota/plugin-kit", kit);

const ownedName = "@scratch/owned-plugin";
const ownedBundle = bundleFixture(
  scratch,
  "@scratch/owned",
  `[[patch]]\ninsert = [{ id = "owned", name = "${ownedName}" }]\n`,
  { [ownedName]: "workspace:*" },
);
const ownedPlugin = pluginFixture(scratch, ownedName);
linkPackage(ownedBundle, ownedName, ownedPlugin);
assert.equal(existsSync(join(scratch, "node_modules", ...ownedName.split("/"))), false, "the row package is not at the install root");

const ownedHome = mkdtempSync(join(tmpdir(), "maota-owned-"));
const ownedProfile = join(ownedHome, "profiles", "default");
mkdirSync(ownedProfile, { recursive: true });
writeJson(join(ownedProfile, "package.json"), {
  name: "maota-profile-default",
  private: true,
  maota: { profile: { bundles: ["@scratch/owned"] } },
});
await ensureProfile(ownedHome, "default", scratch);
assert.ok(readFileSync(join(ownedProfile, "blmoadll.toml"), "utf8").includes("[plugins.owned]"));
assert.equal(realpathSync(join(ownedProfile, "node_modules", ...ownedName.split("/"))), realpathSync(ownedPlugin));

const broken = bundleFixture(scratch, "@scratch/broken", "not = [valid\n");
const skipped = await resolveBundleRows(["@scratch/broken"], scratch, scratch);
assert.equal(skipped.rows.length, 0);
assert.match(skipped.warnings[0] ?? "", /@scratch\/broken/);
assert.ok(existsSync(join(broken, "patch.toml")));

bundleFixture(scratch, "@scratch/incompatible", `[[patch]]\ninsert = [{ id = "x", name = "${ownedName}" }]\n`, { [ownedName]: "workspace:*" }, "^9.0.0");
const incompatibleResult = await resolveBundleRows(["@scratch/incompatible"], scratch, scratch);
assert.equal(incompatibleResult.rows.length, 0);
assert.match(incompatibleResult.warnings[0] ?? "", /plugin-kit/);

const profileBundle = join(scratch, "profiles", "default", "node_modules", "@scratch", "owned");
mkdirSync(dirname(profileBundle), { recursive: true });
symlinkSync(ownedBundle, profileBundle, "junction");
assert.equal(resolveBundleDir("@scratch/owned", scratch, join(scratch, "profiles", "default")), realpathSync(ownedBundle));
assert.throws(() => entryOf("@scratch/missing", scratch), /cannot resolve the entry/);
assert.equal(renderConfig([]).includes("[plugins."), false, "an empty bundle list renders no rows");
assert.ok(resolveKernelBin({ installed: null, root: repoRoot, env: {} as NodeJS.ProcessEnv }).length > 0);

console.log("config ok: patch layers, bundle ownership, profile links, compatibility and user layer");