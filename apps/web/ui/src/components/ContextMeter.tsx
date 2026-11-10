import { useState } from "react";

import { useT } from "../lib/i18n.ts";
import type { CompactionRecord, ContextView } from "../lib/rpc.ts";

function percent(context: ContextView | null): number {
  return Math.max(0, Math.min(100, Math.round((context?.ratio ?? 0) * 100)));
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function RecordRow({ record }: { record: CompactionRecord }) {
  const t = useT();
  const before = record.chars_before.toLocaleString();
  const after = record.chars_after.toLocaleString();
  return (
    <div className="context-record">
      <div className="context-record-head">
        <span>{t(record.trigger === "manual" ? "compactManual" : record.trigger === "overflow" ? "compactOverflow" : "compactPressure")}</span>
        <span className={`context-status context-status-${record.status}`}>
          {record.status === "committed" ? t("compactCommitted") : t("compactFailed")}
        </span>
      </div>
      <div className="context-record-meta">
        {t("compactRecord", { n: record.folded, before, after })}
      </div>
      {record.error === undefined ? null : <div className="context-record-error">{record.error}</div>}
    </div>
  );
}

export function ContextMeter({
  context,
  running,
  onCompact,
}: {
  context: ContextView | null;
  running: boolean;
  onCompact: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const value = percent(context);
  const last = context?.compactions.at(-1);
  const compactDisabled = context === null || running || context?.active === true;
  return (
    <div className="context-wrap">
      <button
        type="button"
        className="context-meter"
        aria-label={t("contextTitle")}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle className="context-ring-track" cx="18" cy="18" r="15" />
          <circle
            className="context-ring-value"
            cx="18"
            cy="18"
            r="15"
            pathLength="100"
            strokeDasharray={`${value} 100`}
          />
        </svg>
      </button>
      {open ? (
        <div className="context-panel">
          <div className="context-panel-head">
            <strong>{t("contextTitle")}</strong>
            <span>{t("contextEstimated")}</span>
          </div>
          <div className="context-numbers">
            <span>{(context?.estimated_chars ?? 0).toLocaleString()}</span>
            <span>/ {(context?.threshold_chars ?? 0).toLocaleString()}</span>
          </div>
          {last === undefined ? null : (
            <div className="context-last">
              <div className="context-panel-label">{t("compactLatest")}</div>
              <RecordRow record={last} />
              <div className="context-time">{when(last.at)}</div>
            </div>
          )}
          {(context?.compactions.length ?? 0) > 1 ? (
            <details className="context-history">
              <summary>{t("compactHistory")}</summary>
              {context?.compactions.slice(0, -1).reverse().map((record) => (
                <RecordRow key={record.id} record={record} />
              ))}
            </details>
          ) : null}
          <mao-button variant="solid" size="sm" disabled={compactDisabled} onClick={onCompact}>
            {context?.active === true ? t("compactRunning") : t("compactNow")}
          </mao-button>
        </div>
      ) : null}
    </div>
  );
}
