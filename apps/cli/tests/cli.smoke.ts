import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseArgs } from "../src/args.ts";

const main = join(import.meta.dirname, "..", "src", "index.ts");
const VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }
).version;

const cases: Array<[string[], unknown]> = [
  [[], { kind: "repl", config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["what is 2+2"], { kind: "once", question: "what is 2+2", config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["fix", "the", "bug"], { kind: "once", question: "fix the bug", config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["serve"], { kind: "serve", config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["--session", "web", "serve"], { kind: "serve", config: undefined, kernel: undefined, profile: undefined, session: "web" }],
  [["check"], { kind: "check", json: false, config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["check", "--json"], { kind: "check", json: true, config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["--config", "a.toml", "--kernel", "k.exe", "check"], { kind: "check", json: false, config: "a.toml", kernel: "k.exe", profile: undefined, session: "cli" }],
  [["--profile", "serve", "serve"], { kind: "serve", config: undefined, kernel: undefined, profile: "serve", session: "cli" }],
  [["plugin", "add", "pkg"], { kind: "plugin", action: "add", args: ["pkg"], config: undefined, kernel: undefined, profile: undefined, session: "cli" }],
  [["plugin", "--profile", "work", "why", "pkg"], { kind: "plugin", action: "why", args: ["pkg"], config: undefined, kernel: undefined, profile: "work", session: "cli" }],
  [["--help"], { kind: "help" }],
  [["-h"], { kind: "help" }],
  [["--version"], { kind: "version" }],
  [["-v"], { kind: "version" }],
  [["--help", "serve"], { kind: "help" }],
  [["--nope"], { kind: "usage", message: "unknown option: --nope" }],
  [["--config"], { kind: "usage", message: "option --config needs a value" }],
  [["serve", "extra"], { kind: "usage", message: "serve takes no further arguments: extra" }],
  [["check", "now"], { kind: "usage", message: "check takes no further arguments: now" }],
];

for (const [argv, want] of cases) {
  assert.deepEqual(parseArgs(argv), want, `parseArgs(${JSON.stringify(argv)})`);
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [main, ...args], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot spawn ${process.execPath} (${args.join(" ")}): ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const help = run(["--help"]);
assert.equal(help.status, 0, help.stderr);
assert.ok(help.stdout.includes("maota check"), "the help text should list the check subcommand");
assert.ok(help.stdout.includes("maota plugin"), "the help text should list the plugin subcommand");
assert.ok(help.stdout.includes("exit codes:"), "the help text should list the exit codes");

const version = run(["--version"]);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout, `maota ${VERSION}\n`);

const unknown = run(["--nope"]);
assert.equal(unknown.status, 2, `an unknown option should exit 2, got ${unknown.status}`);
assert.ok(unknown.stderr.includes("unknown option: --nope"), unknown.stderr);

const misplaced = run(["serve", "extra"]);
assert.equal(misplaced.status, 2, `serve with a positional argument should exit 2, got ${misplaced.status}`);

console.log(`cli ok: ${cases.length} grammar cases / --help / --version / usage errors exit 2`);
