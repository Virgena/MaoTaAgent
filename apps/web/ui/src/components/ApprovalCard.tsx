import { ICON, MaoButton, MaoIcon as Icon } from "maotaui";

import { useT } from "../lib/i18n.ts";
import type { Approval } from "../lib/rpc.ts";

export function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: Approval;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  const t = useT();

  return (
    <div className="approval">
      <div className="approval-head">
        <Icon name={ICON.alert} className="icon icon-sm" />
        <span className="approval-title">{t("approvalTitle")}</span>
      </div>
      <div className="approval-tool">{t("approvalTool", { tool: approval.tool })}</div>
      {approval.subagent === undefined ? null : (
        <div className="approval-subagent">
          {t("approvalSubagent", {
            name:
              approval.subagent.description === undefined || approval.subagent.description === ""
                ? approval.subagent.id
                : approval.subagent.description,
            type: approval.subagent.type === undefined || approval.subagent.type === "" ? "general" : approval.subagent.type,
          })}
        </div>
      )}
      {approval.reason === undefined ? null : (
        <div className="approval-reason">
          <span className="approval-label">{t("approvalReason")}</span>
          <span className="approval-text">{approval.reason}</span>
        </div>
      )}
      <div className="approval-actions">
        <span className="approval-hint">{t("approvalHint")}</span>
        <MaoButton variant="danger" size="sm" onClick={() => onAnswer(approval.id, "deny")}>
          {t("approvalDeny")}
        </MaoButton>
        <MaoButton variant="primary" size="sm" onClick={() => onAnswer(approval.id, "allow")}>
          {t("approvalAllow")}
        </MaoButton>
      </div>
    </div>
  );
}
