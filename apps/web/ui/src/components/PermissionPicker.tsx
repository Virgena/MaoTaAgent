import { useState, type ReactNode } from "react";
import { ICON, MaoIcon as Icon, type IconName } from "maotaui";

import { useT, type MessageKey } from "../lib/i18n.ts";
import { Popover } from "./Popover.tsx";

export const PERMISSION_OPTIONS: readonly {
  value: string;
  icon: IconName;
  name: MessageKey;
  note: MessageKey;
  tone: string;
}[] = [
  { value: "ask", icon: ICON.hand, name: "askApproval", note: "askNote", tone: "" },
  { value: "auto", icon: ICON.shield, name: "autoApprove", note: "autoNote", tone: "" },
  { value: "full", icon: ICON.alert, name: "fullAccess", note: "fullNote", tone: " is-danger" },
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
          <Icon name={current.icon} className="icon icon-sm" />
          {t(current.name)}
          <Icon name={ICON.chevronDown} className="icon icon-sm" />
        </>
      )}
    >
      <div className="permission-group-head">
        <span className="permission-group-title">
          <Icon name={ICON.chevronDown} className="icon icon-sm" />
          {t("agentMode")}
        </span>
        <span>{t(current.name)}</span>
      </div>
      <div className="permission-group-head is-permissions">
        <span className="permission-group-title">
          <Icon name={ICON.chevronDown} className="icon icon-sm" />
          {t("permissions")}
        </span>
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
          <Icon name={option.icon} className="icon option-icon" />
          <span className="option-text">
            <span className="option-name">{t(option.name)}</span>
            <span className="option-note">{t(option.note)}</span>
          </span>
          {option.value === value ? <Icon name={ICON.check} className="icon icon-sm option-check" /> : null}
        </button>
      ))}
    </Popover>
  );
}
