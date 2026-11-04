import type { LoopEvent } from "@maota/agent-loop";

import type { PersistTrace } from "./history.ts";

export interface RunTrace {
  record(event: LoopEvent): void;
  value(steps?: number): PersistTrace;
}

export function relaySubagentEvent(
  event: LoopEvent,
  announce: (topic: string, fields: Record<string, unknown>) => void,
): void {
  if (event.type === "step") announce("agent.subagent.step", { step: event.step });
  else if (event.type === "tool_call") {
    announce("agent.subagent.tool_call", { id: event.id, tool: event.tool, args: event.args });
  } else if (event.type === "tool_result") {
    announce("agent.subagent.tool_result", {
      id: event.id,
      tool: event.tool,
      ok: event.ok,
      output: event.output,
    });
  }
}

export function createRunTrace(after = -1): RunTrace {
  let reasoning = "";
  let mark = 0;
  let startedAt: number | undefined;
  let reasoningMs = 0;
  let steps = 0;
  const settle = (): void => {
    if (startedAt === undefined) return;
    reasoningMs += Math.max(0, Date.now() - startedAt);
    startedAt = undefined;
  };
  return {
    record(event) {
      if (event.type === "step") {
        settle();
        mark = reasoning.length;
        steps = event.step;
      } else if (event.type === "reasoning") {
        startedAt ??= Date.now();
        reasoning += event.text;
      } else if (event.type === "retract") {
        reasoning = reasoning.slice(0, mark);
      } else if (event.type === "tool_call") {
        settle();
      } else if (event.type === "done") {
        steps = event.steps;
        settle();
      }
    },
    value(finalSteps = steps) {
      settle();
      return { reasoning, reasoning_ms: reasoningMs, steps: finalSteps, after };
    },
  };
}
