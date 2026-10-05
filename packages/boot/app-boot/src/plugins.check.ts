import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  PROFILE_TEMPLATES,
  entryOf,
  repoRoot,
  resolveBundleRows,
  type BundlePluginRow,
} from "./index.ts";

interface Inject {
  capability: string;
  optional?: boolean;
}

interface Report {
  provides?: string[];
  injects?: Inject[];
  registrations?: Array<{ service: string; capability: string }>;
  host_calls?: string[];
  problems?: string[];
}

const packageRoot = join(import.meta.dirname, "..");
const seen = new Map<string, BundlePluginRow>();
const warnings: string[] = [];
for (const template of Object.values(PROFILE_TEMPLATES)) {
  const resolved = await resolveBundleRows(template.bundles, packageRoot, packageRoot);
  warnings.push(...resolved.warnings);
  for (const row of resolved.rows) {
    if (!seen.has(row.name)) seen.set(row.name, row);
  }
}
for (const warning of warnings) console.log(`WARN ${warning}`);
const rows = [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));

const checked = rows.map((row) => {
  const run = spawnSync(process.execPath, [entryOf(row.name, row.root), "--check"], { encoding: "utf8", cwd: repoRoot });
  const line = (run.stdout ?? "").trim().split("\n").at(-1) ?? "";
  let report: Report = {};
  try {
    report = JSON.parse(line) as Report;
  } catch {
  }
  const tail = (run.stderr ?? "").trim().split("\n").slice(-6).join("\n     ");
  return { id: row.id, report, status: run.status, detail: (tail || line).slice(0, 400) };
});

/// A plugin's own report cannot see the rest of the set, so the one thing none
/// of them can check alone is checked here: a require nothing answers.
const offered = new Set<string>();
for (const { report } of checked) {
  for (const capability of report.provides ?? []) offered.add(capability);
}

let failed = 0;
for (const { id, report, status, detail } of checked) {
  const problems = [...(report.problems ?? [])];
  for (const item of report.injects ?? []) {
    if (item.optional !== true && !offered.has(item.capability)) {
      problems.push(`injects \`${item.capability}\`, which no plugin in this set provides`);
    }
  }
  for (const item of report.registrations ?? []) {
    if (!offered.has(item.service)) {
      problems.push(`registers with \`${item.service}\`, which no plugin in this set provides`);
    }
  }
  if (status !== 0 || problems.length > 0) {
    failed += 1;
    console.log(`FAIL ${id}`);
    for (const problem of problems) console.log(`     ${problem}`);
    if (problems.length === 0) console.log(`     exit ${status}: ${detail}`);
    continue;
  }
  console.log(`ok   ${id.padEnd(26)} ${(report.provides ?? []).join(" ")}`);
}
console.log(`${checked.length} plugins checked, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
