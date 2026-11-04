import { useEffect, useState } from "react";

import type { LiveSubagent, SubagentStatus } from "../execution.ts";
import { useT, type MessageKey } from "../lib/i18n.ts";
import { call, type SessionFile, type SessionSummary } from "../lib/rpc.ts";
import { MessageItem } from "./MessageItem.tsx";

const STATUS: Record<SubagentStatus, MessageKey> = {
  running: "subagentRunning",
  done: "subagentDone",
  partial: "subagentPartial",
  failed: "subagentFailed",
};

/// A trace line shows the first thing the call named, which for every tool in
/// the pool is the file, the pattern or the command that says what it did.
function argPreview(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === "string" && value !== "") return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  }
  return "";
}

/// The subagent's own conversation, read on demand and read-only: its messages
/// belong to the subagent's session, so they are shown here rather than mixed
/// into the parent's, and the file is fetched only when someone asks for it.
function ChildSession({ id, cwd }: { id: string; cwd: string }) {
  const t = useT();
  const [file, setFile] = useState<SessionFile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFile(null);
    setFailure(null);
    void call<SessionFile>("sessions.load", { id, cwd })
      .then((reply) => {
        if (live) setFile(reply);
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [id, cwd]);

  if (failure !== null) return <div className="subagent-note">{failure}</div>;
  if (file === null) return <div className="subagent-note">{t("subagentLoading")}</div>;
  if (file.messages.length === 0) return <div className="subagent-note">{t("subagentEmpty")}</div>;
  return (
    <div className="subagent-transcript">
      {file.messages.map((message, index) => (
        <MessageItem key={index} message={message} />
      ))}
    </div>
  );
}

function Head({
  type,
  label,
  status,
  steps,
  open,
  onToggle,
}: {
  type: string;
  label: string;
  status?: MessageKey;
  steps?: number;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className="subagent-head">
      <span className={`subagent-badge is-${type}`}>{type}</span>
      <span className="subagent-name">{label}</span>
      {status === undefined ? null : <span className="subagent-status">{t(status)}</span>}
      {steps === undefined ? null : <span className="subagent-meta">{t("subagentSteps", { n: steps })}</span>}
      <button className="subagent-open" onClick={onToggle}>
        {open ? t("subagentHide") : t("subagentView")}
      </button>
    </div>
  );
}

export function SubagentCard({ subagent, cwd }: { subagent: LiveSubagent; cwd: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`subagent is-${subagent.status}`}>
      <Head
        type={subagent.type}
        label={subagent.description}
        status={STATUS[subagent.status]}
        steps={subagent.steps}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      {subagent.tools.length === 0 ? null : (
        <div className="subagent-trace">
          {subagent.tools.map((tool, index) => (
            <div key={index} className={`subagent-line${tool.ok === false ? " is-bad" : ""}`}>
              <span className="subagent-arrow">{tool.ok === false ? "×" : "→"}</span>
              <code>{tool.tool}</code>
              {argPreview(tool.args) === "" ? null : <span className="subagent-args">{argPreview(tool.args)}</span>}
            </div>
          ))}
        </div>
      )}
      {open ? <ChildSession id={subagent.id} cwd={cwd} /> : null}
    </div>
  );
}

/// What a reopened session can still show: the sub-sessions it spawned, hung
/// under the call each of them came from, with nothing of them loaded until the
/// reader asks.
export function SubagentLink({ child }: { child: SessionSummary }) {
  const [open, setOpen] = useState(false);
  const parent = child.parent;
  return (
    <div className="subagent is-restored">
      <Head
        type={parent?.type === undefined || parent.type === "" ? "general" : parent.type}
        label={parent?.description === undefined || parent.description === "" ? child.title : parent.description}
        open={open}
        onToggle={() => setOpen(!open)}
      />
      {open ? <ChildSession id={child.id} cwd={child.cwd} /> : null}
    </div>
  );
}
