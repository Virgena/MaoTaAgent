#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { CallError, runPlugin, type Definition, type Wiring } from "@maota/plugin-kit";
import {
  parseFrontmatter,
  rootStamp,
  scanSkillRoot,
  type SkillCandidate,
  type SkillRoot,
  type ScannedRoot,
} from "@maota/skill";

/// Project first, then what the profile configured, then the person's own
/// directory: a nearer root wins a duplicate name, and the bundled provider
/// sits last of all.
const PROJECT_RANK = 100;
const CUSTOM_RANK = 300;
const USER_RANK = 400;

/// How deep below a root a `SKILL.md` may sit. A depth of one is the plain
/// `<name>/SKILL.md` layout; three leaves room for a grouping folder without
/// turning a skill's own `references/` tree into skills.
const DEFAULT_MAX_DEPTH = 3;

let dirs: string[] = [];
let maxDepth = DEFAULT_MAX_DEPTH;

interface CacheRow {
  stamp: string;
  scanned: ScannedRoot;
}

/// A scan is cached against a cheap signature, and a watcher on the root drops
/// the row the moment the tree changes. The signature is the fallback for the
/// platforms and networks where `fs.watch` never fires, so a cache can be
/// stale for one call but never for long.
const cache = new Map<string, CacheRow>();
const watchers = new Map<string, FSWatcher>();

function watchRoot(dir: string): void {
  if (watchers.has(dir) || !existsSync(dir)) return;
  try {
    const watcher = watch(dir, { recursive: true, persistent: false }, () => cache.delete(dir));
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(dir);
    });
    watchers.set(dir, watcher);
  } catch {
    // A root that cannot be watched is still scanned; the signature catches up.
  }
}

function scanCached(root: SkillRoot, ctx: { channel: { log(level: string, message: string): void } }): SkillCandidate[] {
  watchRoot(root.dir);
  const key = rootStamp(root.dir, root.maxDepth ?? maxDepth);
  const hit = cache.get(root.dir);
  if (hit !== undefined && hit.stamp === key) return hit.scanned.candidates;
  const scanned = scanSkillRoot(root);
  for (const note of scanned.notes) ctx.channel.log("warn", `skill-filesystem: ${note}`);
  cache.set(root.dir, { stamp: key, scanned });
  return scanned.candidates;
}

function home(): string {
  const configured = process.env.MAOTA_HOME;
  return configured !== undefined && configured.trim() !== "" ? configured : join(homedir(), ".maota");
}

function startDir(cwd: string): string {
  return cwd.trim() === "" ? process.cwd() : resolve(cwd);
}

/// The project is the nearest ancestor that carries `.git`, so a session
/// opened in a subdirectory still finds the skills its repository publishes.
function projectRoot(cwd: string): string {
  const start = startDir(cwd);
  let at = start;
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return start;
    at = up;
  }
}

function rootsFor(cwd: string): SkillRoot[] {
  const roots: SkillRoot[] = [
    { dir: join(projectRoot(cwd), ".agents", "skills"), rank: PROJECT_RANK, source: "project", maxDepth },
  ];
  for (const dir of dirs) {
    roots.push({
      dir: isAbsolute(dir) ? dir : resolve(startDir(cwd), dir),
      rank: CUSTOM_RANK,
      source: "custom",
      maxDepth,
    });
  }
  roots.push({ dir: join(home(), "skills"), rank: USER_RANK, source: "user", maxDepth });
  return roots;
}

function readDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

export const definition: Definition = {
  provides: ["skill.filesystem"],
  hostCalls: [],
  registrations: [{ service: "skill", capability: "skill.filesystem" }],
  injects: [],
  configKeys: ["dirs", "max_depth"],

  setup(wiring: Wiring) {
    dirs = readDirs(wiring.config.dirs);
    const depth = wiring.config.max_depth;
    maxDepth = typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : DEFAULT_MAX_DEPTH;
    cache.clear();
  },

  methods: {
    list(params, ctx) {
      const cwd = typeof params?.cwd === "string" ? params.cwd : "";
      const candidates: SkillCandidate[] = [];
      for (const root of rootsFor(cwd)) {
        candidates.push(...scanCached(root, ctx));
      }
      return { candidates };
    },

    load(params) {
      const locator = params?.locator as { path?: unknown } | null | undefined;
      const path = locator?.path;
      if (typeof path !== "string" || path === "") {
        throw new CallError(-32602, "load needs the locator the list handed out");
      }
      return { content: parseFrontmatter(readFileSync(path, "utf8")).body };
    },
  },

  async selfCheck() {
    const problems: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "skill-filesystem-check-"));
    const project = join(root, "proj");
    const custom = join(root, "custom");
    const homeDir = join(root, "home");
    const started = join(root, "empty-project");
    const before = process.env.MAOTA_HOME;
    const ctx = { channel: { log: (): void => {} } } as never;
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { encoding: "utf8" });
    };
    try {
      mkdirSync(join(started, ".git"), { recursive: true });
      mkdirSync(join(project, ".git"), { recursive: true });
      process.env.MAOTA_HOME = homeDir;
      await definition.setup?.({ config: { dirs: [custom] } } as unknown as Wiring);

      write(
        join(project, ".agents", "skills", "alpha", "SKILL.md"),
        [
          "---",
          "name: alpha",
          "description: the alpha skill",
          "when-to-use: while checking alpha",
          "allowed-tools: [read]",
          "model: small-model",
          "context: fork",
          "hooks:",
          "  - event: PreToolUse",
          "    command: check.ps1",
          "    matcher: pwsh",
          "paths:",
          "  - src/ui/**",
          "target: keep me",
          "---",
          "",
          "# alpha",
          "",
          "Do the alpha thing.",
        ].join("\n"),
      );
      write(join(project, ".agents", "skills", "beta.md"), "---\ndescription: flat beta\n---\nFlat body.\n");
      write(join(project, ".agents", "skills", "notes", "readme.txt"), "not a skill\n");
      write(join(project, ".agents", "skills", "gamma", "SKILL.md"), "---\nname: delta\ndescription: renamed\n---\nbody\n");
      write(join(project, ".agents", "skills", "Bad Name", "SKILL.md"), "---\ndescription: shouty\n---\nbody\n");
      write(join(project, ".agents", "skills", "delta", "SKILL.md"), "---\nuser-invocable: sometimes\ndescription: unsure\n---\nbody\n");
      write(join(custom, "eps", "SKILL.md"), "---\ndescription: custom eps\n---\nbody\n");
      write(join(homeDir, "skills", "zeta", "SKILL.md"), "---\ndescription: user zeta\n---\nbody\n");
      write(
        join(project, ".agents", "skills", "group", "nested", "SKILL.md"),
        "---\ndescription: nested eta\n---\nNested body.\n",
      );
      write(
        join(project, ".agents", "skills", "group", "nested", "deep", "deeper", "SKILL.md"),
        "---\ndescription: too deep\n---\nbody\n",
      );

      const cwd = join(project, "packages", "inner");
      mkdirSync(cwd, { recursive: true });
      const listed = definition.methods["list"]?.({ cwd }, ctx) as {
        candidates: SkillCandidate[];
      };
      const names = listed.candidates.map((candidate) => candidate.name).sort();
      if (names.join(",") !== "alpha,beta,eps,nested,zeta") problems.push(`scanned ${names.join(",") || "(nothing)"}`);

      const byName = new Map(listed.candidates.map((candidate) => [candidate.name, candidate]));
      const alpha = byName.get("alpha");
      if (alpha?.rank !== PROJECT_RANK || alpha.source !== "project") {
        problems.push(`alpha came from ${String(alpha?.rank)}/${String(alpha?.source)}`);
      }
      if (alpha?.whenToUse !== "while checking alpha") problems.push("when-to-use was lost");
      if ((alpha?.paths ?? []).join(",") !== "src/ui/**") problems.push(`paths came back as ${String(alpha?.paths)}`);
      if ((alpha?.allowedTools ?? []).join(",") !== "read") {
        problems.push(`allowed-tools came back as ${String(alpha?.allowedTools)}`);
      }
      if (alpha?.model !== "small-model") problems.push(`model came back as ${String(alpha?.model)}`);
      if (alpha?.context !== "fork") problems.push(`context came back as ${String(alpha?.context)}`);
      if (alpha?.hooks?.[0]?.command !== "check.ps1" || alpha.hooks[0].event !== "PreToolUse") {
        problems.push(`hooks came back as ${JSON.stringify(alpha?.hooks)}`);
      }
      if (alpha?.hooks?.[0]?.matcher !== "pwsh") problems.push("a hook matcher was lost");
      if (Object.hasOwn(alpha ?? {}, "metadata")) problems.push("an unknown key was kept as metadata");
      if (byName.get("nested")?.resourceBase?.path !== join(project, ".agents", "skills", "group", "nested")) {
        problems.push("a nested skill pointed its resources at the wrong directory");
      }
      if (alpha?.resourceBase?.path !== join(project, ".agents", "skills", "alpha")) {
        problems.push(`resourceBase came back as ${String(alpha?.resourceBase?.path)}`);
      }
      if (byName.get("eps")?.rank !== CUSTOM_RANK || byName.get("eps")?.source !== "custom") {
        problems.push("a configured directory did not land at the custom rank");
      }
      if (byName.get("zeta")?.rank !== USER_RANK || byName.get("zeta")?.source !== "user") {
        problems.push("the user directory did not land at the user rank");
      }
      if (byName.get("beta")?.resourceBase?.path !== join(project, ".agents", "skills")) {
        problems.push("a flat entry pointed its resources at the wrong directory");
      }
      if (byName.get("beta")?.description !== "flat beta") problems.push("a flat entry lost its description");

      const loaded = definition.methods["load"]?.(
        { locator: { path: join(project, ".agents", "skills", "alpha", "SKILL.md") } },
        ctx,
      );
      if ((loaded as { content?: string }).content !== "# alpha\n\nDo the alpha thing.") {
        problems.push(`load returned ${JSON.stringify((loaded as { content?: string }).content)}`);
      }
      try {
        definition.methods["load"]?.({ locator: {} }, ctx);
        problems.push("load accepted a locator without a path");
      } catch (error) {
        if ((error as CallError).code !== -32602) problems.push("load refused a bad locator with the wrong code");
      }

      /// The bare read asks what a session with nothing configured sees, so the
      /// custom root the first half declared is dropped rather than left behind.
      await definition.setup?.({ config: {} } as unknown as Wiring);
      process.env.MAOTA_HOME = join(root, "absent");
      const bare = definition.methods["list"]?.({ cwd: started }, ctx) as {
        candidates: SkillCandidate[];
      };
      if (bare.candidates.length !== 0) problems.push(`a directory without skills produced ${bare.candidates.length}`);
      return problems;
    } finally {
      if (before === undefined) delete process.env.MAOTA_HOME;
      else process.env.MAOTA_HOME = before;
      rmSync(root, { recursive: true, force: true });
    }
  },
};

runPlugin(definition);
