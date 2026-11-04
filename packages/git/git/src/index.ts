#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { CallError, isPluginEntry, runPlugin, type Definition } from "@maota/plugin-kit";

export const GIT_FAILURE = {
  notRepository: -32080,
  dirty: -32081,
  invalid: -32082,
  conflict: -32083,
  unavailable: -32084,
  command: -32085,
} as const;

export interface GitStatusView {
  is_repo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  branches: string[];
}

interface GitSettings {
  git: string;
  timeout_ms: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

let settings: GitSettings = {
  git: "git",
  timeout_ms: 10_000,
};

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function pathOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CallError(GIT_FAILURE.invalid, "working directory is required");
  }
  const path = resolve(value.trim());
  if (!existsSync(path)) throw new CallError(GIT_FAILURE.invalid, `working directory does not exist: ${path}`);
  return path;
}

function textOf(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CallError(GIT_FAILURE.invalid, `${field} is required`);
  }
  return value.trim();
}

function command(cwd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(settings.git, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      if (settled) return;
      settled = true;
      reject(new CallError(GIT_FAILURE.command, `git ${args[0] ?? ""} timed out`));
    }, settings.timeout_ms);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new CallError(GIT_FAILURE.unavailable, "git is not installed or not on PATH"));
        return;
      }
      reject(new CallError(GIT_FAILURE.command, error.message));
    });
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

async function must(cwd: string, args: string[]): Promise<string> {
  const result = await command(cwd, args);
  if (result.code !== 0) {
    throw new CallError(GIT_FAILURE.command, result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function statusAt(value: unknown): Promise<GitStatusView> {
  const cwd = pathOf(value);
  const rootResult = await command(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    return { is_repo: false, root: null, branch: null, detached: false, dirty: false, branches: [] };
  }
  const root = resolve(rootResult.stdout.trim());
  const symbolic = await command(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const detached = symbolic.code !== 0;
  const branch = detached ? await must(root, ["rev-parse", "--short", "HEAD"]) : symbolic.stdout.trim();
  const dirty = (await must(root, ["status", "--porcelain", "--untracked-files=normal"])) !== "";
  const branches = (await must(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return { is_repo: true, root, branch, detached, dirty, branches };
}

async function requireRepository(cwd: string): Promise<GitStatusView> {
  const status = await statusAt(cwd);
  if (!status.is_repo) throw new CallError(GIT_FAILURE.notRepository, "the selected directory is not a Git repository");
  return status;
}

async function switchBranch(value: unknown, branchValue: unknown): Promise<GitStatusView> {
  const cwd = pathOf(value);
  const branch = textOf(branchValue, "branch");
  const status = await requireRepository(cwd);
  if (status.dirty) throw new CallError(GIT_FAILURE.dirty, "commit or discard changes before switching branches");
  if (!status.branches.includes(branch)) throw new CallError(GIT_FAILURE.invalid, `unknown local branch: ${branch}`);
  if (branch === status.branch) return status;
  await must(status.root!, ["switch", branch]);
  return await statusAt(status.root!);
}

async function createWorktree(value: unknown, branchValue: unknown, pathValue: unknown, baseValue: unknown): Promise<{
  path: string;
  branch: string;
  status: GitStatusView;
}> {
  const cwd = pathOf(value);
  const branch = textOf(branchValue, "branch");
  const path = textOf(pathValue, "worktree path");
  const base = textOf(baseValue, "base branch");
  const status = await requireRepository(cwd);
  if (!isAbsolute(path)) throw new CallError(GIT_FAILURE.invalid, "worktree path must be absolute");
  const target = resolve(path);
  const root = status.root!;
  const inside = relative(root, target);
  if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    throw new CallError(GIT_FAILURE.invalid, "worktree path must be outside the current repository");
  }
  if (existsSync(target)) throw new CallError(GIT_FAILURE.conflict, `worktree path already exists: ${target}`);
  if (status.branches.includes(branch)) throw new CallError(GIT_FAILURE.conflict, `branch already exists: ${branch}`);
  await must(root, ["check-ref-format", "--branch", branch]);
  if (base !== "HEAD" && !status.branches.includes(base)) {
    throw new CallError(GIT_FAILURE.invalid, `unknown base branch: ${base}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  await must(root, ["worktree", "add", "-b", branch, target, base]);
  return { path: target, branch, status: await statusAt(target) };
}

function selfCheck(): string[] {
  const problems: string[] = [];
  if (positive(1, 2) !== 1 || positive(-1, 2) !== 2) problems.push("timeout validation is wrong");
  if (stringOf(" git ", "x") !== "git" || stringOf("", "x") !== "x") problems.push("git executable validation is wrong");
  return problems;
}

export const definition: Definition = {
  provides: ["git"],
  injects: [],
  registrations: [],
  hostCalls: [],
  configKeys: ["git", "timeout_ms"],

  setup(wiring) {
    settings = {
      git: stringOf(wiring.config.git, "git"),
      timeout_ms: positive(wiring.config.timeout_ms, 10_000),
    };
  },

  methods: {
    status(params) {
      return statusAt(params?.cwd);
    },

    switch_branch(params) {
      return switchBranch(params?.cwd, params?.branch);
    },

    create_worktree(params) {
      return createWorktree(params?.cwd, params?.branch, params?.path, params?.base);
    },
  },

  selfCheck,
};

if (isPluginEntry(import.meta.url)) runPlugin(definition);
