import { Fragment, useEffect, useMemo, useRef } from "react";

import {
  transcriptBlocks,
  type LiveSubagent,
  type LiveTool,
  type LiveTurn,
  type SubagentStatus,
} from "../execution.ts";
import type { Approval, HostEvent, SessionMessage, SessionSummary } from "../lib/rpc.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ExecutionTrace } from "./ExecutionTrace.tsx";
import { Markdown, MessageItem } from "./MessageItem.tsx";

export type { LiveSubagent, LiveTool, LiveTurn } from "../execution.ts";

function statusOf(event: HostEvent): SubagentStatus {
  if (event.ok === true) return "done";
  if (event.reason === "max_steps") return "partial";
  return "failed";
}

function heard(subagent: LiveSubagent, event: HostEvent): LiveSubagent {
  return subagent.id === (event.subagent_id ?? "") ? { ...subagent, steps: event.step ?? subagent.steps } : subagent;
}

export function applyEvent(turn: LiveTurn, event: HostEvent): LiveTurn {
  switch (event.event) {
    case "text":
      return { ...turn, text: turn.text + (event.text ?? "") };
    case "reasoning": {
      const now = Date.now();
      return {
        ...turn,
        reasoning: turn.reasoning + (event.text ?? ""),
        reasoningStartedAt: turn.reasoningStartedAt ?? now,
      };
    }
    case "step":
      return {
        ...turn,
        step: event.step ?? turn.step,
        mark: { text: turn.text.length, reasoning: turn.reasoning.length },
        reasoningMs: turn.reasoningMs + (
          turn.reasoningStartedAt === undefined ? 0 : Math.max(0, Date.now() - turn.reasoningStartedAt)
        ),
        reasoningStartedAt: undefined,
      };
    case "retract":
      // One question never shows two answers: what the replaced attempt had
      // already streamed is cut off at the point that attempt began.
      return {
        ...turn,
        text: turn.text.slice(0, turn.mark.text),
        reasoning: turn.reasoning.slice(0, turn.mark.reasoning),
      };
    case "tool_call":
      return {
        ...turn,
        tools: [
          ...turn.tools,
          {
            tool: event.tool ?? "",
            id: event.id ?? "",
            args: event.args,
            startedAt: Date.now(),
          },
        ],
        reasoningMs: turn.reasoningMs + (
          turn.reasoningStartedAt === undefined ? 0 : Math.max(0, Date.now() - turn.reasoningStartedAt)
        ),
        reasoningStartedAt: undefined,
      };
    case "tool_result":
      return { ...turn, tools: fillResult(turn.tools, event) };
    case "subagent.started":
      return {
        ...turn,
        subagents: [
          ...turn.subagents,
          {
            id: event.subagent_id ?? "",
            call_id: event.parent_call_id ?? "",
            type: event.type === undefined || event.type === "" ? "general" : event.type,
            description: event.description ?? "",
            status: "running",
            steps: 0,
            tools: [],
          },
        ],
      };
    case "subagent.step":
      return { ...turn, subagents: turn.subagents.map((subagent) => heard(subagent, event)) };
    case "subagent.tool_call":
      return {
        ...turn,
        subagents: turn.subagents.map((subagent) =>
          subagent.id !== (event.subagent_id ?? "")
            ? subagent
            : {
                ...subagent,
                tools: [
                  ...subagent.tools,
                  {
                    tool: event.tool ?? "",
                    id: event.id ?? `subagent-${subagent.id}-${subagent.tools.length}`,
                    args: event.args,
                  },
                ],
              },
        ),
      };
    case "subagent.tool_result":
      return {
        ...turn,
        subagents: turn.subagents.map((subagent) =>
          subagent.id !== (event.subagent_id ?? "")
            ? subagent
            : { ...subagent, tools: fillResult(subagent.tools, event) },
        ),
      };
    case "subagent.finished":
      return {
        ...turn,
        subagents: turn.subagents.map((subagent) =>
          subagent.id !== (event.subagent_id ?? "")
            ? subagent
            : { ...subagent, status: statusOf(event), steps: event.steps ?? subagent.steps },
        ),
      };
    default:
      return turn;
  }
}

function fillResult(tools: LiveTool[], event: HostEvent): LiveTool[] {
  const id = event.id;
  const at = id !== undefined && id !== ""
    ? tools.findIndex((tool) => tool.id === id)
    : tools.findIndex((tool) => tool.tool === (event.tool ?? "") && tool.ok === undefined);
  const index = at < 0 ? tools.length - 1 : at;
  return tools.map((tool, here) => (
    here === index
      ? { ...tool, ok: event.ok, output: event.output, endedAt: Date.now() }
      : tool
  ));
}

export function MessageList({
  messages,
  pending,
  live,
  approvals,
  spawned,
  cwd,
  onAnswer,
}: {
  messages: SessionMessage[];
  pending: string | null;
  live: LiveTurn | null;
  approvals: Approval[];
  spawned: Record<string, SessionSummary[]>;
  cwd: string;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const blocks = useMemo(() => transcriptBlocks(messages), [messages]);

  const loose = approvals.filter((approval) => approval.call_id === undefined || approval.call_id === "");

  useEffect(() => {
    const element = box.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages, pending, live, approvals]);

  return (
    <div
      className="messages"
      ref={box}
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
    >
      <div className="messages-column">
        {blocks.map((block) => {
          if (block.kind === "message") {
            return <MessageItem key={block.key} message={block.message} spawned={spawned} />;
          }
          if (block.kind === "assistant") {
            return (
              <div key={block.key} className="msg msg-assistant">
                <Markdown text={block.text} />
              </div>
            );
          }
          return (
            <Fragment key={block.key}>
              <ExecutionTrace
                tools={block.tools}
                running={false}
                step={block.steps || undefined}
                reasoning={block.reasoning === "" ? undefined : block.reasoning}
                reasoningMs={block.reasoningMs}
                approvals={approvals.filter((approval) => block.tools.some((tool) => tool.id === approval.call_id))}
                spawned={spawned}
                cwd={cwd}
                onAnswer={onAnswer}
              />
              {block.text === "" ? null : (
                <div className="msg msg-assistant">
                  <Markdown text={block.text} />
                </div>
              )}
            </Fragment>
          );
        })}
        {pending === null ? null : <MessageItem message={{ role: "user", content: pending }} />}
        {live === null ? null : (
          <>
            <ExecutionTrace
              tools={live.tools}
              running={live.running}
              step={live.step}
              startedAt={live.startedAt}
              reasoning={live.reasoning === "" ? undefined : live.reasoning}
              reasoningMs={live.reasoningMs}
              reasoningStartedAt={live.reasoningStartedAt}
              approvals={approvals}
              subagents={live.subagents}
              spawned={spawned}
              cwd={cwd}
              onAnswer={onAnswer}
            />
            {live.text === "" ? null : (
              <div className="msg msg-assistant">
                <Markdown text={live.text} />
              </div>
            )}
          </>
        )}
        {loose.length === 0 ? null : (
          <div className="msg msg-assistant">
            {loose.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onAnswer={onAnswer} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
