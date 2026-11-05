/// The extension host's one status row. A host crash degrades every hosted
/// plugin at once, and every one of those degradations belongs to the same
/// event: the page shows one sentence and the user has one action, restarting.

import { useT } from "../lib/i18n.ts";
import type { HostStatus } from "../lib/rpc.ts";

export function HostStatusStrip({ status }: { status: HostStatus | null }) {
  const t = useT();
  if (status === null) return null;
  const text =
    status.state === "quarantined"
      ? t("hostQuarantined", { plugin: status.plugin ?? "?" })
      : status.state === "failed"
        ? t("hostFailed")
        : status.state === "recovering"
          ? t("hostRecovering")
          : t("hostRestored", { n: status.ready });
  return (
    <div className={status.state === "ready" ? "banner banner-key" : "banner banner-warn"} role="status">
      <span>{text}</span>
    </div>
  );
}
