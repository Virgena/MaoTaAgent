import DOMPurify from "dompurify";
import { marked } from "marked";
import { ICON, MaoIcon as Icon } from "maotaui";
import { Fragment, useMemo } from "react";

import type { SessionMessage, SessionSummary } from "../lib/rpc.ts";
import { useT } from "../lib/i18n.ts";
import { SubagentLink } from "./SubagentCard.tsx";

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(String(text ?? ""), { async: false })), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function ToolRow({ tool, args, ok, output }: { tool: string; args?: unknown; ok?: boolean; output?: unknown }) {
  return (
    <div className={`tool${ok === false ? " is-bad" : ""}`}>
      {args === undefined ? null : (
        <div className="tool-line">
          <span className="tool-arrow">→</span> {tool} <code>{preview(args)}</code>
        </div>
      )}
      {ok === undefined ? null : (
        <div className="tool-line">
          <span className="tool-arrow">↳</span> <code>{preview(output)}</code>
        </div>
      )}
    </div>
  );
}

export function MessageItem({
  message,
  spawned,
}: {
  message: SessionMessage;
  spawned?: Record<string, SessionSummary[]>;
}) {
  const t = useT();

  if (message.source?.kind === "compact") {
    return (
      <div className="msg-note">
        <details className="note msg-compact">
          <summary className="note-summary">
            <Icon name={ICON.plug} className="icon icon-sm" />
            {t("compactCheckpoint", { n: message.source.folded ?? 0 })}
          </summary>
          <pre className="note-body">{String(message.content ?? "")}</pre>
        </details>
      </div>
    );
  }
  /// The catalog is written by the harness, not by a person, so it is a folded
  /// grey line rather than a message bubble: it is worth being able to read, and
  /// not worth reading on every turn.
  if (message.source?.kind === "skill-catalog") {
    return null;
  }

  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <Markdown text={String(message.content ?? "")} />
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="msg msg-assistant">
        <ToolRow tool={message.name ?? "tool"} ok output={message.content ?? ""} />
      </div>
    );
  }

  const calls = message.tool_calls ?? [];
  return (
    <div className="msg msg-assistant">
      {message.content ? <Markdown text={message.content} /> : null}
      {calls.map((call, index) => (
        <Fragment key={index}>
          <ToolRow tool={call.function?.name ?? "tool"} args={parseArgs(call.function?.arguments)} />
          {(call.id === undefined ? [] : (spawned?.[call.id] ?? [])).map((child) => (
            <SubagentLink key={child.id} child={child} />
          ))}
        </Fragment>
      ))}
    </div>
  );
}
