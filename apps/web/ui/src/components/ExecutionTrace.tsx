import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ICON, MaoIcon as Icon } from "maotaui";

import {
  groupTraceTools,
  reasoningElapsed,
  toolElapsed,
  toolKind,
  toolStatus,
  toolTarget,
  type LiveSubagent,
  type LiveTool,
  type LiveTurn,
  type ToolKind,
} from "../execution.ts";
import { useT, type MessageKey } from "../lib/i18n.ts";
import type { Approval, SessionSummary } from "../lib/rpc.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { SubagentCard, SubagentLink } from "./SubagentCard.tsx";

const ACTION_KEY: Record<ToolKind, MessageKey> = {
  read: "actionRead",
  edit: "actionEdit",
  write: "actionWrite",
  search: "actionSearch",
  skill: "actionSkill",
  command: "actionCommand",
  delegate: "actionDelegate",
  other: "actionTool",
};

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusMark({ tool }: { tool: LiveTool }) {
  const status = toolStatus(tool);
  if (status === "running") return <span className="trace-spinner" aria-hidden="true" />;
  if (status === "failed") return <Icon name={ICON.alert} className="icon icon-sm trace-error-icon" />;
  return <Icon name={ICON.check} className="icon icon-sm trace-check-icon" />;
}

function ContentField({
  label,
  value,
  empty,
  onOpen,
}: {
  label: string;
  value: unknown;
  empty: string;
  onOpen: () => void;
}) {
  const t = useT();
  const text = contentText(value);
  const shown = text === "" ? empty : text;
  return (
    <div className="trace-field">
      <div className="trace-field-head">
        <span>{label}</span>
        <button type="button" className="trace-field-open" onClick={onOpen}>
          {t("viewFullText")}
        </button>
      </div>
      <div
        className="trace-field-preview"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <pre>{shown}</pre>
      </div>
    </div>
  );
}

function ToolTrace({
  tool,
  open,
  onToggle,
  onOpenText,
  approvals,
  subagents,
  spawned,
  cwd,
  onAnswer,
}: {
  tool: LiveTool;
  open: boolean;
  onToggle: () => void;
  onOpenText: (title: string, text: string) => void;
  approvals: Approval[];
  subagents: LiveSubagent[];
  spawned: SessionSummary[];
  cwd: string;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  const t = useT();
  const kind = toolKind(tool.tool);
  const target = toolTarget(tool.tool, tool.args);
  const elapsed = duration(toolElapsed(tool));
  return (
    <div className={`trace-tool is-${toolStatus(tool)}`}>
      <button
        type="button"
        className="trace-tool-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <StatusMark tool={tool} />
        <span className="trace-action">{t(ACTION_KEY[kind])}</span>
        {target === "" ? null : <code className="trace-target">{target}</code>}
        {elapsed === "" ? null : <span className="trace-duration">{elapsed}</span>}
        <Icon name={open ? ICON.chevronDown : ICON.chevronRight} className="icon icon-sm trace-caret" />
      </button>
      {open ? (
        <div className="trace-tool-body">
          <div className="trace-fields">
            <ContentField
              label={t("traceInput")}
              value={tool.args}
              empty={t("traceNoInput")}
              onOpen={() => onOpenText(`${t(ACTION_KEY[kind])} · ${t("traceInput")}`, contentText(tool.args))}
            />
            <ContentField
              label={t("traceOutput")}
              value={tool.output}
              empty={toolStatus(tool) === "running" ? t("traceWaitingOutput") : t("traceNoOutput")}
              onOpen={() => onOpenText(`${t(ACTION_KEY[kind])} · ${t("traceOutput")}`, contentText(tool.output))}
            />
          </div>
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} onAnswer={onAnswer} />
          ))}
          {subagents.map((subagent) => (
            <SubagentCard key={subagent.id} subagent={subagent} cwd={cwd} />
          ))}
          {spawned.map((child) => (
            <SubagentLink key={child.id} child={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RunStatus({ live, className = "" }: { live: LiveTurn | null; className?: string }) {
  const t = useT();
  if (live === null || !live.running) return null;
  const current = [...live.tools].reverse().find((tool) => tool.ok === undefined);
  const kind = current === undefined ? null : toolKind(current.tool);
  const target = current === undefined ? "" : toolTarget(current.tool, current.args);
  const label = kind === null ? (live.text === "" ? t("thinkingNow") : t("generatingNow")) : t(ACTION_KEY[kind]);
  return (
    <div className={`run-status ${className}`.trim()} aria-live="polite">
      <span className="trace-spinner" aria-hidden="true" />
      <span>{label}</span>
      {target === "" ? null : <code>{target}</code>}
    </div>
  );
}

export function ExecutionTrace({
  tools,
  running,
  step,
  startedAt,
  endedAt,
  reasoning,
  reasoningMs,
  reasoningStartedAt,
  approvals,
  subagents,
  spawned,
  cwd,
  onAnswer,
}: {
  tools: LiveTool[];
  running: boolean;
  step?: number;
  startedAt?: number;
  endedAt?: number;
  reasoning?: string;
  reasoningMs?: number;
  reasoningStartedAt?: number;
  approvals: Approval[];
  subagents?: LiveSubagent[];
  spawned?: Record<string, SessionSummary[]>;
  cwd: string;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  const t = useT();
  const failed = tools.some((tool) => tool.ok === false) || approvals.length > 0;
  const [open, setOpen] = useState(running || failed);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [toolOpen, setToolOpen] = useState<Record<string, boolean>>({});
  const [fullText, setFullText] = useState<{ title: string; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    setOpen(running || failed);
  }, [failed, running]);
  useEffect(() => {
    if (fullText === null) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setFullText(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [fullText]);

  const approvalsByCall = new Map<string, Approval[]>();
  for (const approval of approvals) {
    if (approval.call_id === undefined || approval.call_id === "") continue;
    approvalsByCall.set(approval.call_id, [...(approvalsByCall.get(approval.call_id) ?? []), approval]);
  }
  const entries = groupTraceTools(tools);
  const elapsed = startedAt === undefined ? undefined : Math.max(0, (endedAt ?? now) - startedAt);
  const thought = reasoningElapsed({ reasoningMs: reasoningMs ?? 0, reasoningStartedAt }, now);
  const toolExpanded = (tool: LiveTool): boolean =>
    toolOpen[tool.id] ?? (tool.ok === undefined || tool.ok === false || (approvalsByCall.get(tool.id)?.length ?? 0) > 0);

  const renderTool = (tool: LiveTool): ReactNode => (
    <ToolTrace
      key={tool.id}
      tool={tool}
      open={toolExpanded(tool)}
      onToggle={() => setToolOpen((current) => ({ ...current, [tool.id]: !toolExpanded(tool) }))}
      onOpenText={(title, text) => setFullText({ title, text })}
      approvals={approvalsByCall.get(tool.id) ?? []}
      subagents={(subagents ?? []).filter((subagent) => subagent.call_id !== "" && subagent.call_id === tool.id)}
      spawned={spawned?.[tool.id] ?? []}
      cwd={cwd}
      onAnswer={onAnswer}
    />
  );

  return (
    <>
      <section className="execution-record" aria-label={t("executionRecord")}>
        <div className="execution-head">
          <button
            type="button"
            className="execution-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span className={`execution-state is-${running ? "running" : failed ? "failed" : "done"}`}>
              {running ? t("traceRunning") : failed ? t("traceFailed") : t("executionComplete")}
            </span>
            {step === undefined || step === 0 ? null : <span>{t("traceSteps", { n: step })}</span>}
            <span>{t("traceTools", { n: tools.length })}</span>
            {elapsed === undefined ? null : <span className="trace-duration">{duration(elapsed)}</span>}
            <Icon name={open ? ICON.chevronDown : ICON.chevronRight} className="icon icon-sm trace-caret" />
          </button>
        </div>

        {open ? (
          <div className="execution-body">
            {running || reasoning !== undefined ? (
              <div className={`trace-thinking${thinkingOpen ? " is-open" : ""}`}>
                <button
                  type="button"
                  className="trace-thinking-head"
                  aria-expanded={thinkingOpen}
                  disabled={reasoning === undefined || reasoning.trim() === ""}
                  onClick={() => setThinkingOpen((current) => !current)}
                >
                  <Icon name={ICON.bulb} className="icon icon-sm" />
                  <span>
                    {running
                      ? t("thinkingNow")
                      : t("thoughtFor", { n: Math.max(1, Math.round(thought / 1000)) })}
                  </span>
                  {reasoning === undefined || reasoning.trim() === "" ? null : (
                    <Icon
                      name={thinkingOpen ? ICON.chevronDown : ICON.chevronRight}
                      className="icon icon-sm trace-caret"
                    />
                  )}
                </button>
                {thinkingOpen && reasoning !== undefined && reasoning.trim() !== "" ? (
                  <pre className="trace-thinking-content">{reasoning}</pre>
                ) : null}
              </div>
            ) : null}

            {entries.map((entry) => {
              if (entry.kind === "tool") return renderTool(entry.tool);
              const expanded = groupOpen[entry.id] ?? false;
              return (
                <div key={entry.id} className="trace-group">
                  <button
                    type="button"
                    className="trace-group-head"
                    aria-expanded={expanded}
                    onClick={() => setGroupOpen((current) => ({ ...current, [entry.id]: !expanded }))}
                  >
                    <Icon name={expanded ? ICON.chevronDown : ICON.chevronRight} className="icon icon-sm" />
                    <span>{t("explored", { n: entry.tools.length })}</span>
                  </button>
                  {expanded ? <div className="trace-group-body">{entry.tools.map(renderTool)}</div> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      {fullText === null ? null : createPortal(
        <div
          className="trace-full-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFullText(null);
          }}
        >
          <section
            className="trace-full"
            role="dialog"
            aria-modal="true"
            aria-label={fullText.title}
          >
            <header className="trace-full-head">
              <span>{fullText.title}</span>
              <button
                type="button"
                className="side-icon"
                aria-label={t("close")}
                title={t("close")}
                onClick={() => setFullText(null)}
              >
                <Icon name={ICON.close} />
              </button>
            </header>
            <pre className="trace-full-body">{fullText.text}</pre>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
