import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Call, Channel } from "@maota/plugin-kit";

import { definition, GIT_FAILURE } from "../src/index.ts";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const home = mkdtempSync(join(tmpdir(), "maota-git-smoke-"));
const repo = join(home, "repo");
const worktree = join(home, "repo-worktree");
const channel = {} as Channel;
const call = {
  channel,
  config: {},
  capabilities: {},
  capability: "git",
  method: "status",
  caller: "test",
  signal: new AbortController().signal,
  stream: undefined,
} as unknown as Call;

try {
  git(home, "init", "-b", "main", repo);
  git(repo, "config", "user.email", "maota@example.invalid");
  git(repo, "config", "user.name", "MaoTa");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "branch", "topic");

  definition.setup?.({ channel, config: {}, capabilities: {} } as never);
  const initial = await definition.methods.status?.({ cwd: repo }, call) as {
    is_repo: boolean;
    branch: string;
    dirty: boolean;
    branches: string[];
  };
  assert.equal(initial.is_repo, true);
  assert.equal(initial.branch, "main");
  assert.deepEqual(initial.branches, ["main", "topic"]);

  const switched = await definition.methods.switch_branch?.({ cwd: repo, branch: "topic" }, call) as { branch: string };
  assert.equal(switched.branch, "topic");
  await definition.methods.switch_branch?.({ cwd: repo, branch: "main" }, call);

  writeFileSync(join(repo, "README.md"), "dirty\n");
  await assert.rejects(
    async () => await definition.methods.switch_branch?.({ cwd: repo, branch: "topic" }, call),
    (error: unknown) => (error as { code?: number }).code === GIT_FAILURE.dirty,
  );
  git(repo, "checkout", "--", "README.md");

  const created = await definition.methods.create_worktree?.({
    cwd: repo,
    branch: "maota/test",
    path: worktree,
    base: "main",
  }, call) as { path: string; branch: string; status: { branch: string } };
  assert.equal(created.path, worktree);
  assert.equal(created.branch, "maota/test");
  assert.equal(created.status.branch, "maota/test");

  await assert.rejects(
    async () => await definition.methods.create_worktree?.(
      { cwd: repo, branch: "maota/again", path: worktree, base: "main" },
      call,
    ),
    (error: unknown) => (error as { code?: number }).code === GIT_FAILURE.conflict,
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("git ok: status, branch switching, dirty refusal and worktree creation");
