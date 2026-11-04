/// The agent loop itself: what one `agent.loop.run` call does from the moment it
/// reads its parameters to the moment it names how the run ended. The turn is
/// assembled from the pieces its sibling modules own — the levels table, the
/// prompt, the hook seam, the history, the model stream and the fork — and this
/// file is the only place those pieces are wired together, so the run's own
/// state (its narrowing, its model, the hooks a tool brought, its depth) lives
/// here and nowhere else.

import { CallError, type Call, type Channel } from "@maota/plugin-kit";
import {
  asText,
  runLoop,
  sourcedMessages,
  type LoopEvent,
  type LoopOutcome,
  type LoopState,
  type Message,
  type PreToolDecision,
  type ToolCall,
  type ToolSpec,
} from "@maota/agent-loop";
import type { HookEvent } from "@maota/hook-protocol";
import { readRoute, type ModelRoute, type ResolvedModel } from "@maota/model-protocol";
import { touchedPaths } from "./catalog.ts";
import { continueNote, overflowNote } from "./compact.ts";
import { narrow, readRunControl, withoutControl, type RunControl } from "./control.ts";
import { chatStream } from "./chat.ts";
import { mergeContextNotes, type ContextNote } from "./context.ts";
import { compactMessages, fitToolResult, loadHistory, persist, titleOf } from "./history.ts";
import { asPostTool, asPreTool, asStop, hooksOn, preToolUse, seam, triggerHook } from "./hooks.ts";
import { active, depths, readLevel, resolveLevel, settings, type LevelSetting } from "./levels.ts";
import { approvalMode, assemblePrompt, catalogNote, classifyTool, listTools } from "./prompt.ts";
import { readDepth, readNames, readOrigin, readSteps, readSystem, runFork, type SubagentRef } from "./subagent.ts";
import { injectHostArgs, stripHostArgs, type HostValues } from "./tools.ts";
import { createRunTrace, relaySubagentEvent } from "./trace.ts";

/// A bus event is a broadcast a subscriber may not be there to hear, and a lost
/// one costs nothing: the run itself is the record.
function announce(channel: Channel, topic: string, payload: unknown): void {
  void channel.publish(topic, payload).catch(() => undefined);
}

/// What a run can honestly claim to have done when it never returned an
/// outcome: the assistant messages it already has are the calls it started.
function startedCalls(messages: readonly Message[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

function readMessageSource(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "job" && raw.kind !== "schedule") return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  const source: Record<string, unknown> = { kind: raw.kind, id: raw.id };
  if (typeof raw.occurrence === "string") source.occurrence = raw.occurrence;
  if (typeof raw.mode === "string") source.mode = raw.mode;
  if (typeof raw.title === "string") source.title = raw.title;
  return source;
}
export async function runAgent(params: any, ctx: Call): Promise<void> {
  const stream = ctx.stream;
  if (!stream) throw new CallError(-32602, "agent.loop.run is streaming: pass meta.stream");

  const sessionId = String(params?.session_id ?? "default");
  const cwd = typeof params?.cwd === "string" && params.cwd !== "" ? params.cwd : null;
  const input = typeof params?.input === "string" ? params.input : "";
  const source = readMessageSource(params?.source);
  const origin = readOrigin(params?.origin);
  const sub = origin !== null;
  const system = readSystem(params?.system);
  const allow = readNames(params?.tools_allow, "tools_allow");
  const deny = readNames(params?.tools_deny, "tools_deny") ?? [];
  const maxSteps = readSteps(params?.max_steps, settings.max_steps);
  const level = readLevel(params?.thinking);
  const identity = origin?.parent_session_id ?? sessionId;
  const base: LevelSetting = sub
    ? { ...(active.get(identity) ?? { tools: true }) }
    : resolveLevel(settings.thinking, level);
  const chosen = params?.route === undefined ? undefined : readRoute(params.route);
  const resolved = await ctx.channel.call(
    "model",
    "resolve",
    sub && base.route !== undefined
      ? { route: base.route }
      : chosen === undefined
        ? { level, ...(base.model === undefined ? {} : { model: base.model }) }
        : { route: chosen, level },
    { signal: ctx.signal },
  ) as ResolvedModel;
  const setting: LevelSetting = {
    ...base,
    route: resolved.route,
    tools: base.tools && resolved.model.capabilities.tools,
  };

  // Depth is a property of the run, not of the tool that started it: a child is
  // one deeper than the run that owns its parent session, and a deployment may
  // say so explicitly instead.
  /// The session this run belongs to, named the way every hook payload names
  /// it: a subagent reports its parent's session and says so.
  const self = { session_id: identity, cwd, subagent: sub };
  /// Text an event the loop has no seam for contributes, written into the turn
  /// as a message of its own. Before that array exists it waits here, so
  /// `SessionStart` and a fold are heard by the same first model call.
  const pending: ContextNote[] = [];
  const record = async (event: HookEvent, payload: unknown): Promise<void> => {
    const outcome = await triggerHook(ctx, event, payload);
    pending.push(...(outcome.context ?? []).map((note) => ({ ...note, replace: event === "PreModel" })));
  };
  const flush = (): void => {
    if (pending.length === 0) return;
    mergeContextNotes(messages, pending);
    pending.length = 0;
  };
  const depth = readDepth(params?.depth) ?? (sub ? (depths.get(identity) ?? 0) + 1 : 0);
  if (depth > settings.max_depth) {
    stream.push({
      type: "done",
      steps: 0,
      text: `this run is ${depth} delegations deep, and max_depth is ${settings.max_depth}`,
      reason: "refused",
    });
    await record("Notification", {
      ...self,
      text: `this run was refused: it is ${depth} delegations deep, and max_depth is ${settings.max_depth}`,
    });
    return;
  }
  depths.set(sessionId, depth);

  let prompt: PreToolDecision | null = null;
  if (!sub) {
    // Before the tools, the skills, the gate and the model: a refused prompt
    // costs a hook call and nothing else, and it is never written down.
    prompt = await seam(ctx, "UserPromptSubmit", { session_id: sessionId, cwd, input }, asPreTool);
    if (prompt?.decision === "deny") {
      stream.push({ type: "done", steps: 0, text: prompt.reason ?? "", reason: "refused" });
      return;
    }
  }

  await record("SessionStart", { ...self });

  const [available, mode] = await Promise.all([listTools(ctx), approvalMode(ctx, identity, cwd ?? "")]);
  const allowed = (name: string): boolean => (allow === null || allow.includes(name)) && !deny.includes(name);
  const pool = setting.tools ? [...available] : [];
  const declared = pool.filter((tool) => allowed(tool.name));

  /// The tool surface is a live thing: a tool result may narrow it for the rest
  /// of the run, and the model's view, the refusal gate and the loop all read
  /// the same current list rather than three snapshots.
  let narrowed: string[] | null = null;
  let runRoute: ModelRoute = resolved.route;
  let runModel = `${runRoute.provider}/${runRoute.model}`;
  let visible = declared;
  let modelTools = visible.map(stripHostArgs);
  let visibleNames = new Set(visible.map((tool) => tool.name));
  const loopTools: ToolSpec[] = [...declared];
  const narrowTo = (keep: readonly string[]): void => {
    narrowed = narrow(narrowed, keep);
    const wanted = new Set(narrowed);
    visible = declared.filter((tool) => wanted.has(tool.name));
    modelTools = visible.map(stripHostArgs);
    visibleNames = new Set(visible.map((tool) => tool.name));
    loopTools.length = 0;
    loopTools.push(...visible);
  };
  const child: SubagentRef | null =
    origin === null
      ? null
      : {
          subagent_id: sessionId,
          parent_session_id: origin.parent_session_id,
          parent_call_id: origin.parent_call_id,
          type: origin.type,
          description: origin.description,
        };

  // A subagent's calls are the parent's calls as far as the rest of the
  // deployment is concerned: the same session, the same `task` call, and a
  // label saying which subagent is asking.
  let touched: string[] = [];
  const host = (callId: string | null): HostValues => ({
    session_cwd: cwd,
    session_id: identity,
    call_id: origin === null ? callId : origin.parent_call_id,
    subagent: child === null ? null : { id: child.subagent_id, type: child.type, description: child.description },
    session_touched: touched,
  });
  const specOf = (name: string): ToolSpec | undefined => declared.find((tool) => tool.name === name);
  const argsOf = (call: ToolCall): unknown => injectHostArgs(specOf(call.name), call.args, host(call.id));
  const hooksFor = (invoked: ToolCall, step: number): Record<string, unknown> => ({
    session_id: identity,
    cwd,
    step,
    tool: invoked.name,
    args: argsOf(invoked),
    call_id: origin === null ? invoked.id : origin.parent_call_id,
    ...(child === null
      ? {}
      : { subagent: { id: child.subagent_id, type: child.type, description: child.description } }),
  });
  // The tool surface is closed at the seam as well as in the listing, so a name
  // the model invented is refused instead of hoped against.
  const refused = (name: string): PreToolDecision => ({
    decision: "deny",
    reason: sub
      ? `the ${name} tool is not available to this subagent`
      : `the ${name} tool is not available in this run`,
  });
  const announceSub = (topic: string, fields: Record<string, unknown>): void => {
    if (child === null) return;
    announce(ctx.channel, topic, { ...child, ...fields });
  };
  /// A delegation announces itself under the same fields at both ends, so the
  /// two events read one payload and only the event name tells them apart.
  const subagentPayload = (): Record<string, unknown> | null =>
    child === null
      ? null
      : {
          session_id: identity,
          cwd,
          subagent_id: child.subagent_id,
          type: child.type,
          description: child.description,
        };
  /// What a tool result asks the run to become, applied in one place for every
  /// tool: nothing here knows what a skill is, so a plan or a policy plugin can
  /// borrow the same channel later.
  const hooksRegistered: string[] = [];
  const applyControl = async (control: RunControl, invoked: ToolCall, output: unknown): Promise<unknown> => {
    const content = withoutControl(output);
    if (control.tools_allow !== undefined) narrowTo(control.tools_allow);
    if (control.model !== undefined) {
      const selected = await ctx.channel.call("model", "resolve", { model: control.model }, { signal: ctx.signal }) as ResolvedModel;
      runRoute = selected.route;
      runModel = `${selected.route.provider}/${selected.route.model}`;
      active.set(sessionId, { ...setting, route: selected.route });
    }
    if (control.hooks !== undefined && hooksOn()) {
      const scope = `${identity}:${invoked.id}`;
      try {
        await ctx.channel.call("hooks", "register", { scope, hooks: control.hooks }, { signal: ctx.signal });
        hooksRegistered.push(scope);
      } catch (error) {
        ctx.channel.log("warn", "agent: the hooks a tool brought could not be registered", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (control.fork === true) {
      const label =
        typeof invoked.args === "object" && invoked.args !== null
          ? String((invoked.args as { name?: unknown }).name ?? invoked.name)
          : invoked.name;
      return await runFork(ctx, identity, cwd, invoked, asText(content), label);
    }
    return content;
  };

  const history: Message[] = sub ? [] : await loadHistory(ctx, sessionId, cwd);
  if (input !== "") history.push({ role: "user", content: input, ...(source === null ? {} : { source }) });
  const first = history.find((message) => message.role === "user" && typeof message.content === "string");
  history.push(...sourcedMessages(prompt?.context ?? []));
  touched = touchedPaths(history, new Map(declared.map((tool) => [tool.name, tool])), cwd);

  // The note is read before the fold and written after it, so a catalog that a
  // fold swallowed is still compared against, and the note the model is about
  // to read is never what the fold eats.
  const note = sub ? null : await catalogNote(ctx, history, cwd, touched);
  if (note !== null) history.push(note);

  const title = origin !== null && origin.description !== "" ? origin.description : titleOf(first?.content);
  await persist(ctx, sessionId, cwd, history, title, origin, runRoute, level);

  const messages: Message[] = [
    { role: "system", content: await assemblePrompt(ctx, identity, cwd, mode, system) },
    ...history,
  ];
  const trace = createRunTrace(history.length - 1);
  flush();

  const starting = subagentPayload();
  if (starting !== null) {
    await record("SubagentStart", starting);
    flush();
  }
  announceSub("agent.subagent.started", {});
  if (!sub) active.set(sessionId, setting);
  const heartbeat = setInterval(() => stream.push({ type: "tick" }), 10_000);
  /// What this turn has already spent folding the conversation back into the
  /// window, which is the one recovery a run keeps for itself.
  let compactions = 0;
  let overflowRetries = 0;
  let closed = false;
  /// What the run will say it ended with, so `SessionEnd` can be raised from
  /// the one place every ending passes through.
  let ending: { steps: number; reason: string } = { steps: 0, reason: "failed" };
  try {
    let outcome: LoopOutcome | null = null;
    try {
      outcome = await runLoop(
        {
          tools: loopTools,
          max_steps: maxSteps,
          max_parallel: settings.max_parallel_tools,
          chat: async (step) => {
            try {
              if (!sub && settings.context_compact && compactions < settings.max_compactions) {
                const compacted = await compactMessages(ctx, {
                  sessionId,
                  cwd,
                  messages: step.state.messages,
                  tools: modelTools,
                  model: runModel,
                  route: runRoute,
                  trigger: "pressure",
                  beforeCompact: (folded) =>
                    record("PreCompact", { ...self, step: step.step, messages: folded }),
                  flush,
                });
                if (compacted.status === "summarized") compactions += 1;
              }
            } catch (error) {
              ctx.channel.log("warn", "agent: pressure compaction failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            await record("PreModel", { ...self, step: step.step });
            flush();
            try {
              const message = await chatStream(
                ctx,
                step.state.messages,
                modelTools,
                runRoute,
                step.signal,
                step.delta,
                { id: sessionId, cwd: cwd ?? "", step: step.step },
              );
              await record("PostModel", { ...self, step: step.step, ok: true });
              flush();
              return message;
            } catch (error) {
              await record("PostModel", { ...self, step: step.step, ok: false });
              flush();
              throw error;
            }
          },
          callTool: (invoked, step) =>
            ctx.channel.call("tools", "call", { name: invoked.name, args: argsOf(invoked) }, { signal: step.signal }),
          classify: (invoked, step) => classifyTool(ctx, specOf(invoked.name), invoked, host(invoked.id), step.signal),
          preTool: async (invoked, step) =>
            allowed(invoked.name) && visibleNames.has(invoked.name)
              ? await preToolUse(ctx, hooksFor(invoked, step.step), invoked.name, self)
              : refused(invoked.name),
          postTool: async (invoked, outcome, step) => {
            const decision = await seam(
              ctx,
              "PostToolUse",
              { ...hooksFor(invoked, step.step), ok: outcome.ok, output: outcome.output },
              asPostTool,
            );
            const control = readRunControl(outcome.output);
            const applied = control === null
              ? (decision?.output ?? outcome.output)
              : await applyControl(control, invoked, outcome.output);
            const fitted = await fitToolResult(
              ctx,
              sessionId,
              cwd,
              step.state.messages,
              modelTools,
              runModel,
              applied,
            );
            return { ...(decision ?? {}), output: fitted };
          },
          onModelError: async (failure, step) => {
            if (failure.kind !== "context_window") return { action: "give_up" };
            if (!settings.context_compact || overflowRetries >= 1) return { action: "give_up" };
            overflowRetries += 1;
            const compacted = await compactMessages(ctx, {
              sessionId,
              cwd,
              messages,
              tools: modelTools,
              model: runModel,
              route: runRoute,
              trigger: "overflow",
              force: true,
              beforeCompact: (folded) =>
                record("PreCompact", { ...self, step: step.step, messages: folded }),
              flush,
            });
            return compacted.status === "none" || compacted.status === "failed"
              ? { action: "give_up" }
              : { action: "retry", delay_ms: 0, steer: overflowNote() };
          },
          ...(sub
            ? {}
            : {
                atStop: (state: LoopState) =>
                  seam(
                    ctx,
                    "Stop",
                    { session_id: sessionId, cwd, steps: state.step, stop_active: state.stopSteered },
                    asStop,
                  ),
              }),
        },
        messages,
        ctx.signal,
        (event: LoopEvent) => {
          stream.push(event);
          trace.record(event);
          relaySubagentEvent(event, announceSub);
        },
      );
    } catch (error) {
      // Only an accident reaches this: a model call that failed reports itself
      // as an outcome, so what is left is a turn cancelled from outside or a
      // seam that broke. Either way what the turn holds is saved and the front
      // end is told why.
      const cancelled = ctx.signal.aborted;
      const reason = cancelled ? "aborted" : "model_error";
      ending = { steps: startedCalls(messages), reason };
      const detail = error instanceof Error ? error.message : String(error);
      await record("Notification", {
        ...self,
        text: cancelled ? "this turn was cancelled" : `this turn ended against an unexpected failure: ${detail}`,
      });
      flush();
      await persist(ctx, sessionId, cwd, messages.slice(1), title, origin, runRoute, level, trace.value(ending.steps));
      stream.push({ type: "done", steps: ending.steps, text: cancelled ? "" : detail, reason });
    }
    if (outcome !== null) {
      // The ceiling is not a dead end: the turn says where it stopped, and that
      // note is stored with the rest, so the next turn continues.
      if (outcome.reason === "max_steps") messages.push(continueNote(outcome.steps));
      ending = { steps: outcome.steps, reason: outcome.reason };
      // A model call that ended the turn is reported as the facts it carried,
      // so a reader learns the kind rather than reading a sentence about it.
      if (outcome.failure !== undefined) {
        await record("Notification", {
          ...self,
          text: `the model call failed and was given up on: ${outcome.failure.kind}`,
        });
        flush();
      }
      const stopping = subagentPayload();
      if (stopping !== null) await record("SubagentStop", stopping);
      flush();
      await persist(ctx, sessionId, cwd, messages.slice(1), title, origin, runRoute, level, trace.value());
      announceSub("agent.subagent.finished", {
        steps: outcome.steps,
        reason: outcome.reason,
        ok: outcome.reason === "completed",
      });
      closed = true;
      stream.push({
        type: "done",
        steps: outcome.steps,
        text: outcome.text,
        reason: outcome.reason,
        ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      });
    }
  } finally {
    clearInterval(heartbeat);
    const before = messages.length;
    await record("SessionEnd", { ...self, ...ending });
    const stopping = subagentPayload();
    if (stopping !== null && !closed) await record("SubagentStop", stopping);
    flush();
    // What the last two points said belongs to the turn like everything else,
    // or a hook that only speaks at the end is never heard at all.
    if (messages.length > before) {
      await persist(ctx, sessionId, cwd, messages.slice(1), title, origin, runRoute, level, trace.value());
    }
    if (!sub) active.delete(sessionId);
    depths.delete(sessionId);
    // A hook a tool brought belongs to the run that tool ran in, so it is
    // withdrawn here rather than left to fire on whatever comes next.
    for (const scope of hooksRegistered) {
      try {
        await ctx.channel.call("hooks", "unregister", { scope }, { signal: ctx.signal });
      } catch {
        // The hooks engine will outlive this run by nothing at all if it is
        // gone already, so a failed withdrawal needs no ceremony.
      }
    }
    if (child !== null && !closed) announceSub("agent.subagent.finished", { ok: false, reason: "failed" });
  }
}
