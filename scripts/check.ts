import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

interface Step {
  name: string;
  cmd: string;
}

interface Result {
  step: Step;
  code: number;
  output: string;
  ms: number;
}

function width(): number {
  const given = Number(process.env["MAOTA_CHECK_JOBS"]);
  if (Number.isInteger(given) && given > 0) return given;
  return Math.min(6, Math.max(2, availableParallelism() - 1));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function run(step: Step): Promise<Result> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ step, code, output, ms: Date.now() - started });
    };
    console.log(`run   ${step.name}`);
    const child = spawn(step.cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error: Error) => {
      output += String(error);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

async function phase(steps: Step[]): Promise<Result[]> {
  const queue = [...steps];
  const results: Result[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const step = queue.shift();
      if (step === undefined) return;
      const result = await run(step);
      results.push(result);
      console.log(`${result.code === 0 ? "ok   " : "FAIL "} ${step.name} ${seconds(result.ms)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width(), steps.length) }, worker));
  return results;
}

const CHECKS: Step[] = [
  { name: "docs/i18n", cmd: "node docs/i18n.check.ts" },
  { name: "i18n/dictionaries", cmd: "node scripts/i18n.check.ts" },
  { name: "imports", cmd: "node scripts/imports.check.ts" },
  { name: "versions", cmd: "node scripts/version.check.ts" },
  { name: "file-size", cmd: "node scripts/file-size.check.ts" },
  { name: "plugin-kit/config-keys", cmd: "node packages/plugin-kit/src/config-keys.check.ts" },
  { name: "plugin-kit/tool-schema", cmd: "node packages/plugin-kit/src/tool-schema.check.ts" },
  { name: "plugin-kit/channel", cmd: "node packages/plugin-kit/src/channel.check.ts" },
  { name: "plugin-kit/host", cmd: "node packages/plugin-kit/src/host.check.ts" },
  { name: "app-boot/plugins", cmd: "node packages/boot/app-boot/src/plugins.check.ts" },
  { name: "web/types", cmd: "pnpm -C apps/web check" },
];

/// Every `*:smoke` script the manifest declares, so a smoke is covered the
/// moment it is written and this list cannot fall behind the manifest.
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const SMOKES: Step[] = Object.entries(manifest.scripts ?? {})
  .filter(([name]) => name.endsWith(":smoke"))
  .map(([name, cmd]) => ({ name, cmd }));

const started = Date.now();

const built = await phase([{ name: "build", cmd: "pnpm build" }]);
const results =
  built[0]?.code === 0
    ? [
        ...built,
        ...(await phase([{ name: "types", cmd: "pnpm exec tsc --noEmit" }, ...CHECKS, ...SMOKES])),
      ]
    : built;

const failed = results.filter((result) => result.code !== 0);

for (const result of failed) {
  console.log(`\n--- ${result.step.name} failed with code ${result.code} ---`);
  process.stdout.write(result.output.endsWith("\n") || result.output === "" ? result.output : `${result.output}\n`);
}

const slowest = [...results]
  .sort((left, right) => right.ms - left.ms)
  .slice(0, 5)
  .map((result) => `${result.step.name} ${seconds(result.ms)}`)
  .join(", ");

console.log(`\n${results.length} steps in ${seconds(Date.now() - started)}, ${failed.length} failed`);
console.log(`slowest: ${slowest}`);
if (failed.length > 0) process.exitCode = 1;
