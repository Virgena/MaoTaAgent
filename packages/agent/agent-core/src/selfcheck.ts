/// The self check a deployment runs against this plugin, driven in three groups
/// over the shared rig in `selfcheck-rig.ts`: the primitives this plugin reads
/// and writes, the agent runs that exercise delegation and the catalog, and the
/// loop runs that exercise the hook seam, control, forking and the limits. Each
/// group appends to one problem list, in the order the checks ran.

import type { Definition } from "@maota/plugin-kit";
import { runLoop, type ToolSpec } from "@maota/agent-loop";
import { readLevel, readThinking, resolveLevel } from "./levels.ts";
import { segmenter, titleOf } from "./history.ts";
import { readOrigin } from "./subagent.ts";
import { hostValue, injectHostArgs, stripHostArgs, type HostValues } from "./tools.ts";
import { createRig } from "./selfcheck-rig.ts";
import { checkAgentRuns } from "./selfcheck-agent.ts";
import { checkLoopRuns } from "./selfcheck-loop.ts";
import { createRunTrace } from "./trace.ts";

export async function runSelfCheck(definition: Definition): Promise<string[]> {
  const problems: string[] = [];
  const rig = createRig(definition);
  await checkPrimitives(problems);
  await checkAgentRuns(definition, rig, problems);
  await checkLoopRuns(definition, rig, problems);
  return problems;
}

async function checkPrimitives(problems: string[]): Promise<void> {
  let budget = 0;
  const stalled = await runLoop(
    {
      tools: [],
      max_steps: 2,
      chat: async () => {
        budget += 1;
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: `c${budget}`, function: { name: "echo", arguments: "{}" } }],
        };
      },
      callTool: async () => "ok",
    },
    [{ role: "user", content: "hi" }],
    new AbortController().signal,
    () => {},
  );
  if (stalled.reason !== "max_steps") problems.push(`a stalled loop ended as ${stalled.reason}, expected max_steps`);
  if (stalled.steps !== 2) problems.push(`a stalled loop took ${stalled.steps} steps, expected 2`);
  if (budget !== 2) problems.push(`a stalled loop called the model ${budget} times, expected 2`);

  const thinking = readThinking({
    low: "deepseek-chat",
    medium: { model: "deepseek-reasoner", tools: false },
    nonsense: "ignored",
  });
  if (Object.keys(thinking).length !== 2) problems.push("unknown level names were kept");
  if (resolveLevel(thinking, "low").model !== "deepseek-chat") problems.push("a bare model name was not read");
  if (!resolveLevel(thinking, "low").tools) problems.push("a bare model name should keep tools on");
  if (resolveLevel(thinking, "medium").tools) problems.push("tools = false was ignored");
  if (resolveLevel(thinking, "high").model !== undefined) problems.push("an unset level invented a model");
  if (!resolveLevel(thinking, "high").tools) problems.push("an unset level should keep tools on");
  if (readLevel(undefined) !== "off") problems.push("the default level is not off");
  try {
    readLevel("deep");
    problems.push("readLevel accepted an unknown level");
  } catch {
  }

  if (titleOf("  a\n\nb  ") !== "a b") problems.push(`titleOf flattened to ${JSON.stringify(titleOf("  a\n\nb  "))}`);
  if (titleOf("x".repeat(40)) !== `${"x".repeat(30)}…`) problems.push("titleOf did not cut at 30 graphemes");
  if (titleOf(undefined) !== "") problems.push("titleOf invented a title");
  const family = titleOf("👨‍👩‍👧‍👦".repeat(40));
  if ([...segmenter.segment(family)].length > 31) problems.push("titleOf split a grapheme cluster");
  if (!family.endsWith("…")) problems.push("titleOf did not cut the long family line");

  const trace = createRunTrace();
  trace.record({ type: "step", step: 1 });
  trace.record({ type: "reasoning", text: "discarded" });
  trace.record({ type: "retract", reason: "retry" });
  trace.record({ type: "reasoning", text: "kept" });
  trace.record({ type: "tool_call", id: "c1", tool: "read", args: {} });
  trace.record({ type: "done", steps: 2, text: "ok", reason: "completed" });
  const captured = trace.value();
  if (captured.reasoning !== "kept") problems.push(`the trace kept ${JSON.stringify(captured.reasoning)}`);
  if (captured.steps !== 2) problems.push(`the trace reported ${captured.steps} steps`);

  const host: HostValues = {
    session_cwd: "E:\\proj",
    session_id: "s1",
    call_id: "c1",
    subagent: null,
    session_touched: [],
  };
  const pwsh: ToolSpec = {
    name: "pwsh",
    input_schema: { type: "object", properties: { command: { type: "string" } } },
    host_args: [{ name: "workdir", source: "session_cwd" }],
  };
  if ((injectHostArgs(pwsh, { command: "ls" }, host) as { workdir?: string }).workdir !== "E:\\proj") {
    problems.push("the session workdir was not injected");
  }
  if ((injectHostArgs(pwsh, { command: "ls", workdir: "D:\\x" }, host) as { workdir?: string }).workdir !== "D:\\x") {
    problems.push("host injection overwrote the model's own workdir");
  }
  const other: ToolSpec = {
    name: "other",
    input_schema: { type: "object", properties: { a: { type: "string" } } },
  };
  if ((injectHostArgs(other, { a: 1 }, host) as { workdir?: unknown }).workdir !== undefined) {
    problems.push("host args were injected into a tool that declares none");
  }
  if (
    (injectHostArgs(pwsh, { command: "ls" }, {
      session_cwd: null,
      session_id: null,
      call_id: null,
      subagent: null,
      session_touched: [],
    }) as {
      workdir?: unknown;
    }).workdir !== undefined
  ) {
    problems.push("host args were injected without a session workdir");
  }
  const gate: ToolSpec = {
    name: "pwsh",
    input_schema: { type: "object", properties: { command: { type: "string" } } },
    host_args: [
      { name: "workdir", source: "session_cwd" },
      { name: "session_id", source: "session_id" },
      { name: "call_id", source: "call_id" },
    ],
  };
  const injected = injectHostArgs(gate, { command: "ls" }, host) as {
    workdir?: string;
    session_id?: string;
    call_id?: string;
  };
  if (injected.session_id !== "s1" || injected.call_id !== "c1" || injected.workdir !== "E:\\proj") {
    problems.push(`the session and call identity were not injected: ${JSON.stringify(injected)}`);
  }
  if (hostValue("elsewhere", host) !== null) problems.push("an unknown host source invented a value");
  if ((stripHostArgs(pwsh) as { host_args?: unknown }).host_args !== undefined) {
    problems.push("host_args leaked into the model visible spec");
  }
  if (stripHostArgs(pwsh).name !== "pwsh") problems.push("stripHostArgs dropped the tool name");

  const subTool: ToolSpec = {
    name: "pwsh",
    input_schema: { type: "object", properties: { command: { type: "string" } } },
    host_args: [
      { name: "session_id", source: "session_id" },
      { name: "call_id", source: "call_id" },
      { name: "subagent", source: "subagent" },
    ],
  };
  const carried = injectHostArgs(subTool, { command: "ls" }, {
    session_cwd: "E:\\proj",
    session_id: "p1",
    call_id: "c1",
    subagent: { id: "sub-3f2a", type: "explore", description: "look" },
  } as HostValues) as { subagent?: { id?: string; type?: string } };
  if (carried.subagent?.id !== "sub-3f2a" || carried.subagent.type !== "explore") {
    problems.push(`the subagent identity was not injected: ${JSON.stringify(carried)}`);
  }
  if ((injectHostArgs(subTool, { command: "ls" }, host) as { subagent?: unknown }).subagent !== undefined) {
    problems.push("a parent's call invented a subagent identity");
  }

  const defaults = readOrigin({ parent_session_id: "p1" });
  if (defaults?.type !== "general" || defaults.description !== "") problems.push("origin defaults drifted");
  if (readOrigin(undefined) !== null) problems.push("an absent origin invented a subagent");
}
