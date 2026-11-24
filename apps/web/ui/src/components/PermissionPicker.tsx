import { useState, type ReactNode } from "react";

import { useT, type MessageKey } from "../lib/i18n.ts";
import { Popover } from "./Popover.tsx";

export const PERMISSION_OPTIONS: readonly {
  value: string;
  name: MessageKey;
  note: MessageKey;
  tone: string;
}[] = [
  { value: "ask", name: "askApproval", note: "askNote", tone: "" },
  { value: "auto", name: "autoApprove", note: "autoNote", tone: "" },
  { value: "full", name: "fullAccess", note: "fullNote", tone: " is-danger" },
];

export function PermissionPicker({
  value,
  onChange,
  disabled,
  note,
  label,
}: {
  value: string;
  onChange: (mode: string) => void;
  disabled?: boolean;
  note?: string;
  label?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const current = PERMISSION_OPTIONS.find((option) => option.value === value) ?? PERMISSION_OPTIONS[0]!;

  return (
    <Popover
      className="permission"
      title={t("permission")}
      open={open}
      disabled={disabled}
      onToggle={() => setOpen((was) => !was)}
      onClose={() => setOpen(false)}
      label={label ?? (
        <>
          {t(current.name)}
          <mao-icon name="chevron-down" size={14} />
        </>
      )}
    >
      <div className="permission-group-head">
        <span className="permission-group-title">{t("agentMode")}</span>
        <span>{t(current.name)}</span>
      </div>
      <div className="permission-group-head is-permissions">
        <span className="permission-group-title">{t("permissions")}</span>
        <span>{t(current.name)}</span>
      </div>
      {note === undefined ? null : <div className="popover-note">{note}</div>}
      {PERMISSION_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`option${option.value === value ? " is-on" : ""}${option.tone}`}
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
            setOpen(false);
          }}
        >
          <span className="option-text">
            <span className="option-name">{t(option.name)}</span>
            <span className="option-note">{t(option.note)}</span>
          </span>
          {option.value === value ? <mao-icon name="check" size={14} className="option-check" /> : null}
        </button>
      ))}
    </Popover>
  );
}
