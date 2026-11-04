import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  base,
  call,
  check,
  events,
  finish,
  home,
  info,
  isCatalog,
  kernel,
  LONG,
  passedCount,
  root,
  SHORT,
  sleep,
  startStream,
  textOf,
  turn,
  waitFor,
  type Frame,
} from "./harness.ts";
import { groupTraceTools, toolTarget, transcriptBlocks } from "../ui/src/execution.ts";
import { reasoningFallback } from "../ui/src/thinking.ts";

console.log(`web smoke: ${base}\n`);

await check("app.info", async () => {
  const appInfo = await call("app.info");
  assert.equal(appInfo.url, base, "app.info and web/info should report the same URL");
  assert.equal(appInfo.listening, true, "the plugin should be listening on that URL");
  assert.equal(appInfo.version, info.version, "both should report the same version");
  assert.equal(appInfo.dev, false, "config.dev should win over NODE_ENV");
  assert.equal(appInfo.thinking?.medium?.tools, false, "the level's tools flag should come through");
  assert.equal(appInfo.models?.default_route?.provider, "smoke", "the default model route should come from the model router");
  assert.equal(appInfo.models?.default_route?.model, "smoke-chat", "the default model should be listed");
  assert.ok(appInfo.levels.includes("medium"), `levels should contain medium, got ${JSON.stringify(appInfo.levels)}`);
  assert.ok(
    appInfo.sessions_dir?.startsWith(home) === true,
    `sessions dir should live under MAOTA_HOME, got ${appInfo.sessions_dir}`,
  );
  assert.deepEqual((await call("sessions.list")).sessions, [], "a fresh home should list no sessions");
});

await check("reasoning fallback", async () => {
  const catalog = {
    levels: ["off", "low", "medium", "high"],
    models: {
      models: [{ provider: "p", model: "m", reasoning_efforts: ["low", "max"] }],
    },
  };
  const route = { provider: "p", model: "m" };
  assert.equal(reasoningFallback(catalog, route, "high"), "low", "an unsupported level should use a valid model level");
  assert.equal(reasoningFallback(catalog, route, "low"), null, "a supported level should stay put");
  assert.equal(reasoningFallback(catalog, route, "off"), null, "off should remain available without model metadata");
});

await check("execution trace grouping", async () => {
  const tools = [
    { id: "a", tool: "read", args: { file_path: "src/a.ts" }, ok: true },
    { id: "b", tool: "grep", args: { pattern: "needle" }, ok: true },
    { id: "c", tool: "pwsh", args: { command: "echo hi" }, ok: true },
    { id: "d", tool: "read", args: { file_path: "bad.ts" }, ok: false },
  ];
  const entries = groupTraceTools(tools);
  assert.equal(entries[0]?.kind, "group", "two successful exploration calls should form one group");
  assert.equal(entries[0]?.kind === "group" ? entries[0].tools.length : 0, 2);
  assert.equal(entries[1]?.kind, "tool", "commands should stay outside the exploration group");
  assert.equal(entries[2]?.kind, "tool", "a failed read should stay outside the exploration group");
  assert.equal(toolTarget("read", tools[0]!.args), "src/a.ts");

  const blocks = transcriptBlocks([
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "read-1", function: { name: "read", arguments: '{"file_path":"src/a.ts"}' } }],
    },
    { role: "tool", tool_call_id: "read-1", name: "read", content: "1| hello" },
    { role: "assistant", content: "done" },
  ]);
  assert.equal(blocks[0]?.kind, "execution", "history tool traffic should become an execution record");
  assert.equal(blocks[0]?.kind === "execution" ? blocks[0].tools[0]?.output : null, "1| hello");
  assert.equal(blocks[0]?.kind === "execution" ? blocks[0].text : "", "done");
  const traced = transcriptBlocks([
    { role: "assistant", content: "answer", reasoning: "checked the path", reasoning_ms: 1200, steps: 1 },
  ]);
  assert.equal(traced[0]?.kind, "execution", "a direct answer with trace metadata should keep its record");
  assert.equal(traced[0]?.kind === "execution" ? traced[0].reasoning : "", "checked the path");
  assert.equal(traced[0]?.kind === "execution" ? traced[0].reasoningMs : 0, 1200);
  const hiddenCatalog = transcriptBlocks([
    { role: "user", name: "skill-catalog", content: "<available>", source: { kind: "skill-catalog", entries: [] } },
    { role: "assistant", content: "answer" },
  ]);
  assert.equal(
    hiddenCatalog.some((entry) => entry.kind === "message" && entry.message.source?.kind === "skill-catalog"),
    false,
    "the available skill catalog should not appear as conversation content",
  );
});

await check("settings", async () => {
  const initial = await call("settings.get");
  assert.deepEqual(initial, { revision: 0, locale: null, theme: null }, "settings should start empty");
  const saved = await call("settings.update", {
    patch: { locale: "en", theme: "dark" },
    expected_revision: initial.revision,
  });
  assert.deepEqual(saved, { revision: 1, locale: "en", theme: "dark" }, "settings should return the accepted view");
  await assert.rejects(
    call("settings.update", { patch: { theme: "light" }, expected_revision: initial.revision }),
    (error: { code?: number }) => error.code === -32060,
    "a stale settings revision should be refused",
  );
});

await check("workspace", async () => {
  const initial = await call("workspace.get");
  assert.deepEqual(initial, { revision: 0, projects: [], pinned_sessions: [], archived_sessions: [] });
  const registered = await call("workspace.register", { path: home, name: "Smoke", expected_revision: 0 });
  assert.equal(registered.projects[0]?.path, home, "workspace registration should be durable in the returned view");
  const pinned = await call("workspace.set_pin", { session_id: "smoke-one", pinned: true, expected_revision: registered.revision });
  assert.deepEqual(pinned.pinned_sessions, ["smoke-one"]);
  const archived = await call("workspace.set_archive", { session_id: "smoke-one", archived: true, expected_revision: pinned.revision });
  assert.deepEqual(archived.pinned_sessions, [], "archiving should clear the pin");
  assert.deepEqual(archived.archived_sessions, ["smoke-one"]);
  const removed = await call("workspace.remove", { path: home, expected_revision: archived.revision });
  assert.deepEqual(removed.projects, [], "removing a workspace should remove only its registration");
  const readded = await call("workspace.register", { path: home, expected_revision: removed.revision });
  assert.equal(readded.projects[0]?.path, home, "re-registering the same path should restore the group");
});

await check("session thinking", async () => {
  await call("sessions.set_thinking", { id: "smoke-one", cwd: "", thinking: "low" });
  const loaded = await call("sessions.load", { id: "smoke-one", cwd: "" });
  assert.equal(loaded.thinking, "low", "an explicit low level should be stored, not fall back to off");
});

await check("git", async () => {
  const repo = join(home, "git-repo");
  const worktree = join(home, "git-worktree");
  mkdirSync(repo);
  const run = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run("init", "-b", "main");
  run("config", "user.email", "maota@example.invalid");
  run("config", "user.name", "MaoTa");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "initial\n");
  run("add", "README.md");
  run("commit", "-m", "initial");
  run("branch", "topic");

  const status = await call("git.status", { cwd: repo });
  assert.equal(status.is_repo, true);
  assert.equal(status.branch, "main");
  assert.deepEqual(status.branches, ["main", "topic"]);
  const switched = await call("git.switch_branch", { cwd: repo, branch: "topic" });
  assert.equal(switched.branch, "topic");
  await call("git.switch_branch", { cwd: repo, branch: "main" });
  const created = await call("git.create_worktree", {
    cwd: repo,
    branch: "maota/web-smoke",
    path: worktree,
    base: "main",
  });
  assert.equal(created.path, worktree);
  assert.equal(created.status.branch, "maota/web-smoke");
});

await check("ui", async () => {
  const page = await fetch(`${base}/`);
  if (existsSync(join(root, "apps", "web", "dist", "index.html"))) {
    assert.equal(page.status, 200, "/ should serve dist/index.html");
    assert.ok((await page.text()).includes('id="root"'), "what dist serves should be the UI");
  } else {
    assert.equal(page.status, 404, "with no build, / should say so instead of 404-ing to a blank page");
  }
});

await check("skills.list", async () => {
  const listed = (await call("skills.list")) as {
    complete: boolean;
    skills: Array<{
      name: string;
      description: string;
      source: string;
      provider: string;
      active: boolean;
      paths?: string[];
      rank?: unknown;
      invocation: { modelInvocable: boolean; userInvocable: boolean };
    }>;
  };
  assert.equal(listed.complete, true, "every provider should have answered");
  const names = listed.skills.map((skill) => skill.name);
  assert.ok(names.includes("code-review"), `the bundled skills should be listed, got ${JSON.stringify(names)}`);
  const review = listed.skills.find((skill) => skill.name === "code-review");
  assert.equal(review?.source, "bundled", "a built-in skill should say where it came from");
  assert.equal(review?.provider, "skill.bundled", "the registry should name the provider that served it");
  assert.equal(review?.invocation.modelInvocable, true, "a bundled skill should be open to the model");
  assert.equal(review?.invocation.userInvocable, true, "a bundled skill should be open to a person");
  assert.equal(review?.active, true, "a skill without paths is always active");
  const conditional = listed.skills.find((skill) => skill.name === "plugin-authoring");
  assert.deepEqual(conditional?.paths, ["packages/**"], "a conditional skill should report its patterns");
  assert.equal(conditional?.active, false, "a conditional skill stays hidden until a matching path is touched");
  assert.equal(
    listed.skills.every((skill) => skill.rank === undefined),
    true,
    "a summary should not leak the provider's own rank",
  );
});

startStream();
await sleep(200);

await check("streaming turn", async () => {
  const id = await turn("smoke-one", "short");
  const started = await waitFor((event) => event.event === "turn.start" && event.turn_id === id);
  assert.equal(started.session_id, "smoke-one", "turn.start should carry the session id");
  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  assert.equal(textOf(id), SHORT, "the streamed text should add up");

  const one = join(home, "sessions", "default", "smoke-one.json");
  assert.ok(existsSync(one), `the session should be written to ${one}`);
  if (process.platform !== "win32") {
    assert.equal(statSync(one).mode & 0o777, 0o600, "the session file should not be 0644");
  }
  const loaded = await call("sessions.load", { id: "smoke-one", cwd: "" });
  assert.deepEqual(
    loaded.messages.filter((message: { source?: unknown }) => !isCatalog(message)).map((message: { role: string }) => message.role),
    ["user", "assistant"],
  );
  assert.equal(
    loaded.messages.filter((message: { source?: unknown }) => isCatalog(message)).length,
    1,
    "the session should record the one skill catalog it was sent",
  );
  const answered = loaded.messages.find((message: { role?: string; content?: string }) =>
    message.role === "assistant" && message.content === SHORT
  );
  assert.equal(answered?.reasoning, "check the request", "the completed turn should keep its reasoning trace");
  assert.equal(answered?.steps, 1, "the completed turn should keep its step count");
  assert.equal(loaded.dangling, false, "a finished turn is not dangling");
});

await check("long turn flushes mid-stream", async () => {
  const id = await turn("smoke-long", "long");
  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  const chunks = events.filter((event) => event.event === "text" && event.turn_id === id);
  assert.ok(chunks.length >= 3, `a long answer should arrive in several chunks, got ${chunks.length}`);
  assert.equal(textOf(id), LONG, "the long answer should add up");
});

await check("half turn stays dangling on disk", async () => {
  const id = await turn("smoke-half", "half");
  const failed = (await waitFor((event) => event.event === "turn.done" && event.turn_id === id)) as {
    reason?: string;
    text?: string;
    failure?: { message?: string; kind?: string };
  };
  assert.equal(
    failed.reason,
    "model_error",
    `a backend that broke for good should end the turn as model_error, got ${JSON.stringify(failed)}`,
  );
  assert.ok(
    String(failed.text) === "",
    `a turn that broke says nothing of its own: the failure is reported as facts, got ${JSON.stringify(failed.text)}`,
  );
  assert.equal(
    failed.failure?.kind,
    "request",
    `a script that ran out of steps is a request failure, not an accident to retry: ${JSON.stringify(failed.failure)}`,
  );
  assert.ok(
    String(failed.failure?.message).length > 0,
    `the failure should carry the reason it was given: ${JSON.stringify(failed.failure)}`,
  );
  const half = await call("sessions.load", { id: "smoke-half", cwd: "" });
  assert.equal(half.dangling, true, "a turn cut in half should be marked dangling");
  assert.equal(
    half.messages.filter((message: { source?: unknown }) => !isCatalog(message)).length,
    1,
    "only the user message should survive",
  );
});

await check("cwd: encoded dir and identity", async () => {
  const workdir = "E:\\proj\\x-y";
  const id = await turn("smoke-cwd", "workdir", workdir);
  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  const encoded = workdir.replace(/[^A-Za-z0-9]/g, "-");
  assert.ok(existsSync(join(home, "sessions", encoded, "smoke-cwd.json")), `${workdir} should land in ${encoded}/`);
  const listed = (await call("sessions.list")).sessions as Array<{ id: string; cwd: string }>;
  assert.equal(
    listed.find((item) => item.id === "smoke-cwd")?.cwd,
    workdir,
    "the listed cwd should be the real one from the file",
  );
  assert.equal(listed.find((item) => item.id === "smoke-one")?.cwd, "", "an empty cwd should be listed too");

  const clash = await turn("smoke-cwd", "clash", "E:/proj/x/y");
  const clashError = await waitFor((event) => event.event === "turn.error" && event.turn_id === clash);
  assert.equal(clashError.code, -32602, `the same id in a clashing dir should be rejected, got ${clashError.code}`);
});

await check("rejects bad input", async () => {
  await assert.rejects(
    call("chat.cancel", { turn_id: "no-such-turn" }),
    (error: { code?: number }) => error.code === -32602,
    "cancelling an unknown turn should be -32602",
  );
  await assert.rejects(
    call("chat.send", { session_id: "smoke-one", cwd: "", input: "   ", thinking: "off" }),
    (error: { code?: number }) => error.code === -32602,
    "blank input should be rejected",
  );
  const bogus = await turn("smoke-one", "x", "", "no-such-level");
  const bogusError = await waitFor((event) => event.event === "turn.error" && event.turn_id === bogus);
  assert.equal(bogusError.code, -32602, `an unknown level should report -32602 in the stream, got ${bogusError.code}`);
});

function resultOf(turnId: string): Frame | undefined {
  return events.find((event) => event.event === "tool_result" && event.turn_id === turnId);
}

/// A command needs a session directory to run in, so the approval turns reuse
/// the home the smoke already created.
const project = home;
const auditDir = join(home, "permissions", home.replace(/[^A-Za-z0-9]/g, "-"));

await check("approval: a risky command waits, and allowing it runs it", async () => {
  const id = await turn("smoke-approval", "clean the build directory", project);
  const asked = await waitFor(
    (event) => event.event === "permission.request" && event.session_id === "smoke-approval",
  );
  assert.equal(asked.tool, "pwsh", "the card should name the tool that asked");
  assert.equal(asked.call_id, "call_4", "the card should point at the tool call it belongs to");
  assert.ok(typeof asked.reason === "string" && asked.reason !== "", "the card should carry a reason");
  const parked = await call("permission.pending", { session_id: "smoke-approval" });
  assert.equal(parked.requests.length, 1, "the parked question should be listed");
  assert.equal(parked.requests[0].id, asked.request_id, "the listed question should be the one that was asked");
  assert.equal(parked.requests[0].call_id, "call_4", "the rebuild should keep the tool call id");
  assert.equal(
    (await call("permission.get", { session_id: "smoke-approval", cwd: project })).mode,
    "ask",
    "a session with no stored mode falls back to ask",
  );
  assert.equal((await call("permission.answer", { id: asked.request_id, decision: "allow" })).settled, true);
  const settled = await waitFor(
    (event) => event.event === "permission.settled" && event.request_id === asked.request_id,
  );
  assert.equal(settled.outcome, "allowed-once", "an allow should settle as a one-time grant");
  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  const result = resultOf(id);
  assert.equal(result?.ok, true, `the allowed command should have run, got ${JSON.stringify(result)}`);
  assert.equal(result?.id, "call_4", "a streamed tool result should keep its call id");
  assert.ok(JSON.stringify(result?.output).includes("rm file"), "the command's own output should come back");

  const audit = join(auditDir, "smoke-approval.json");
  assert.ok(existsSync(audit), `the audit should be written to ${audit}`);
  const records = (JSON.parse(readFileSync(audit, "utf8")) as { records: Array<{ kind: string; decided_by?: string }> })
    .records;
  assert.deepEqual(
    records.map((record) => record.kind),
    ["asked", "decided"],
    `the audit should pair the question with its answer, got ${JSON.stringify(records)}`,
  );
  assert.equal(records[1]?.decided_by, "web", "the answer should name the plugin that gave it");
});

await check("approval: denying writes the reason back as the tool result", async () => {
  const id = await turn("smoke-deny", "clean the build directory", project);
  const asked = await waitFor((event) => event.event === "permission.request" && event.session_id === "smoke-deny");
  assert.equal((await call("permission.answer", { id: asked.request_id, decision: "deny" })).settled, true);
  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  const result = resultOf(id);
  assert.equal(result?.ok, true, "a refusal is a tool result, not a broken call");
  assert.equal(
    result?.output?.status,
    "approval denied",
    `the refusal should say so, got ${JSON.stringify(result?.output)}`,
  );
  assert.ok(String(result?.output?.reason).includes("rejected"), "the refusal should carry the reason");
  assert.equal(result?.output?.stdout, undefined, "a denied command must not have run");
  assert.equal(
    (await call("permission.pending", { session_id: "smoke-deny" })).requests.length,
    0,
    "a settled question should leave the list",
  );
  await assert.rejects(
    call("permission.answer", { id: asked.request_id, decision: "allow" }),
    (error: { code?: number }) => error.code === -32602,
    "a late answer should be refused",
  );
});

await check("approval: full mode runs without asking, per session", async () => {
  assert.equal(
    (await call("permission.set", { session_id: "smoke-full", cwd: project, mode: "full" })).mode,
    "full",
  );
  assert.equal(
    (await call("permission.get", { session_id: "smoke-full", cwd: project })).mode,
    "full",
    "the chosen mode should stick to its session",
  );
  const before = events.filter((event) => event.event === "permission.request").length;
  const id = await turn("smoke-full", "clean the build directory", project);
  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  assert.equal(
    events.filter((event) => event.event === "permission.request").length,
    before,
    "full mode should not ask",
  );
  assert.equal(resultOf(id)?.ok, true, "full mode should run the command");
  assert.equal(
    (await call("permission.get", { session_id: "smoke-approval", cwd: project })).mode,
    "ask",
    "another session should keep its own mode",
  );
  await assert.rejects(
    call("permission.set", { session_id: "smoke-full", cwd: project, mode: "yolo" }),
    (error: { code?: number }) => error.code === -32602,
    "a mode outside the three should be refused",
  );
});

await check("subagent: the child runs, and the page hears it under the parent's turn", async () => {
  writeFileSync(join(project, "note.txt"), "hi\n");
  const id = await turn("smoke-sub", "delegate the reading", project);
  const started = await waitFor((event) => event.event === "subagent.started" && event.turn_id === id);
  assert.equal(started.parent_call_id, "call_10", "the child should hang under the parent's task call");
  assert.equal(started.type, "explore", "the event should carry the type the call asked for");
  assert.equal(started.description, "look at the note", "the event should carry the call's label");
  assert.match(String(started.subagent_id), /^sub-[0-9a-f]{12}$/, "the child should name itself");

  const called = await waitFor(
    (event) => event.event === "subagent.tool_call" && event.subagent_id === started.subagent_id,
  );
  assert.equal(called.tool, "read", "the page should hear what the child called");
  assert.equal(called.turn_id, id, "a subagent event belongs to the parent's turn");
  assert.equal(called.parent_call_id, started.parent_call_id, "the child's calls stay under the task row");
  const finished = await waitFor(
    (event) => event.event === "subagent.finished" && event.subagent_id === started.subagent_id,
  );
  assert.equal(finished.turn_id, id, "the end of the child belongs to the parent's turn too");

  await waitFor((event) => event.event === "turn.done" && event.turn_id === id);
  const handoff = resultOf(id);
  assert.equal(handoff?.ok, true, `the task call failed: ${JSON.stringify(handoff?.output)}`);
  assert.equal(handoff?.output, "the note says hi", "only the child's last message should come back");
  assert.equal(textOf(id), "the subagent read the note", "the parent's own answer should stand alone");

  const kids = (await call("sessions.children", { id: "smoke-sub", cwd: project })) as {
    children: Array<{ id: string; parent?: { call_id?: string } | null }>;
  };
  assert.deepEqual(kids.children.map((entry) => entry.id), [started.subagent_id]);
  assert.equal(kids.children[0]?.parent?.call_id, "call_10", "a reopened page can find the child again");
  const listed = (await call("sessions.list")).sessions as Array<{ id: string }>;
  assert.equal(
    listed.some((entry) => entry.id === started.subagent_id),
    false,
    "the sidebar should not list a subagent's session",
  );
  const child = await call("sessions.load", { id: started.subagent_id, cwd: project });
  assert.deepEqual(
    child.messages.map((message: { role: string }) => message.role),
    ["user", "assistant", "tool", "assistant"],
    "the child's own session should hold what it did",
  );
  assert.equal(
    child.messages.filter((message: { source?: unknown }) => isCatalog(message)).length,
    0,
    "a subagent is never sent the skill catalog",
  );
});

await check("models: provider and model persist", async () => {
  const before = await call("models.list");
  const providerReply = await call("models.save_provider", {
    name: "Smoke provider",
    adapter: "openai",
    base_url: "http://127.0.0.1:9/v1",
    api_key: "sk-smoke",
    verified: true,
    expected_revision: before.revision,
  });
  const provider = providerReply.providers.find((item: { name?: string }) => item.name === "Smoke provider");
  assert.ok(provider?.id, "saving a provider should return its id");
  const modelReply = await call("models.save_model", {
    provider: provider.id,
    model: "smoke-model",
    name: "Smoke model",
    capabilities: { tools: true, vision: false },
    expected_revision: providerReply.revision,
  });
  assert.ok(
    modelReply.models.some((item: { provider?: string; model?: string }) => item.provider === provider.id && item.model === "smoke-model"),
    "saving a model should return it",
  );
  const listed = await call("models.list");
  assert.ok(
    listed.models.some((item: { provider?: string; model?: string }) => item.provider === provider.id && item.model === "smoke-model"),
    "the saved model should still be listed",
  );
});

finish();
const code = await kernel.shutdown("ui_quit");
if (process.platform !== "win32") assert.equal(code, 0, `the kernel should exit cleanly, got ${code}`);

await assert.rejects(
  fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "app.info", params: {} }),
  }),
  "the web plugin should stop answering once the kernel is gone",
);

console.log(`\nweb smoke: ${passedCount()} checks passed`);
