import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallError } from "@maota/plugin-kit";

import {
  DEFAULT_MAX_EVENTS,
  SCHEMA_VERSION,
  childrenOf,
  encodeDir,
  list,
  load,
  save,
  setThinking,
  type Limits,
} from "../src/store.ts";

const root = mkdtempSync(join(tmpdir(), "maota-session-smoke-"));
const limits: Limits = { max_bytes: 4096, max_path: 250, max_events: DEFAULT_MAX_EVENTS };
const messages = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "there" },
];
const link = { id: "parent", cwd: "E:\\proj", call_id: "call_0", type: "explore", description: "look at it" };

try {
  const born = save(root, { id: "child-a", cwd: "E:\\proj", title: "look at it", messages, parent: link, thinking: "high" }, limits);
  assert.equal(born.parent?.id, "parent", "save should keep the link it was handed");
  assert.equal(born.thinking, "high", "save should keep the session thinking level");
  assert.equal(born.parent?.call_id, "call_0");
  assert.equal(born.parent?.cwd, "E:\\proj");
  save(root, { id: "child-b", cwd: "E:\\proj", title: "then this", messages, parent: link }, limits);
  save(root, { id: "parent", cwd: "E:\\proj", title: "parent", messages }, limits);

  const read = load(root, "child-a", "E:\\proj", limits);
  assert.equal(read.parent?.type, "explore", "a child should know what kind of subagent it was");
  assert.equal(read.parent?.description, "look at it");
  assert.equal(read.title, "look at it", "a child keeps its own title");
  assert.equal(read.thinking, "high", "a child keeps its own thinking level");
  assert.equal(load(root, "parent", "E:\\proj", limits).parent, null, "a session nobody spawned has no link");

  const listed = list(root);
  assert.deepEqual(
    listed.map((entry) => entry.id).sort(),
    ["child-a", "child-b", "parent"],
    "the listing should carry every session, the ones a subagent opened included",
  );
  assert.equal(
    listed.find((entry) => entry.id === "child-a")?.parent?.id,
    "parent",
    "a listed child should carry the link back to the session that spawned it",
  );
  assert.deepEqual(
    childrenOf(root, "parent", "E:\\proj").map((entry) => entry.id),
    ["child-a", "child-b"],
    "children come back in the order they were created",
  );
  assert.equal(childrenOf(root, "child-a", "E:\\proj").length, 0, "a child has no children of its own");
  assert.throws(
    () => save(root, { id: "child-c", cwd: "E:\\proj", messages, parent: { id: "not a session" } }, limits),
    CallError,
    "a malformed link should be refused rather than stored",
  );
  const relinked = save(root, { id: "child-a", cwd: "E:\\proj", messages }, limits);
  assert.equal(relinked.parent?.id, "parent", "re-saving a child should not drop its link");
  assert.equal(relinked.title, "look at it", "re-saving a child should not drop its title either");

  const path = join(root, encodeDir("E:\\proj"), "old.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 2,
      id: "old",
      cwd: "E:\\proj",
      title: "old",
      created_at: "t",
      updated_at: "t",
      messages,
    }),
  );
  const upgraded = load(root, "old", "E:\\proj", limits);
  assert.equal(upgraded.schema_version, SCHEMA_VERSION, "a version 2 document should read as the current one");
  assert.equal(upgraded.parent, null, "a document from before the link should read as unlinked");
  assert.equal(upgraded.thinking, "off", "a document from before thinking should default to off");
  assert.deepEqual(upgraded.messages, messages, "a migration should not touch the messages");
  save(root, { id: "old", cwd: "E:\\proj", messages, parent: link }, limits);
  const written = JSON.parse(readFileSync(path, "utf8")) as { schema_version?: number; parent?: { id?: string } };
  assert.equal(written.schema_version, SCHEMA_VERSION, "the next write should store the current version");
  assert.equal(written.parent?.id, "parent", "the next write should store the link");
  const changed = setThinking(root, { id: "old", cwd: "E:\\proj", thinking: "medium" }, limits);
  assert.equal(changed.thinking, "medium", "setThinking should store the level");
  assert.equal(load(root, "old", "E:\\proj", limits).thinking, "medium", "setThinking should be durable");
  save(root, {
    id: "traced",
    cwd: "E:\\proj",
    messages: [
      { role: "user", content: "inspect" },
      { role: "assistant", content: "done", reasoning: "read first", reasoning_ms: 1250, steps: 2 },
    ],
  }, limits);
  const traced = load(root, "traced", "E:\\proj", limits);
  assert.equal(traced.messages[1]?.reasoning, "read first", "a session should keep read-only reasoning metadata");
  assert.equal(traced.messages[1]?.reasoning_ms, 1250);
  assert.equal(traced.messages[1]?.steps, 2);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const entry = join(import.meta.dirname, "..", "src", "index.ts");
const run = spawnSync(process.execPath, [entry, "--check"], { encoding: "utf8" });
const line = (run.stdout ?? "").trim().split("\n").at(-1) ?? "";
const report = JSON.parse(line) as {
  ok?: boolean;
  provides?: string[];
  problems?: string[];
};
assert.equal(run.status, 0, `the session entry exited ${run.status}: ${(run.stderr ?? "").slice(-400)}`);
assert.equal(report.ok, true, `the session selfCheck reported ${JSON.stringify(report.problems)}`);
assert.deepEqual(report.provides, ["session"]);

console.log("session ok: the parent link, the listed children, their order, the version 2 migration, the entry report");
