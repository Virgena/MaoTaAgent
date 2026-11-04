import type { PointerEventHandler } from "react";

import { useT } from "../lib/i18n.ts";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../useSidebarWidth.ts";

export function SidebarResizer({
  width,
  resizing,
  onStart,
  onNudge,
}: {
  width: number;
  resizing: boolean;
  onStart: PointerEventHandler<HTMLButtonElement>;
  onNudge: (delta: number) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      role="separator"
      className={`side-resizer${resizing ? " is-resizing" : ""}`}
      aria-label={t("resizeSidebar")}
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      onPointerDown={onStart}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onNudge(-8);
        else if (event.key === "ArrowRight") onNudge(8);
        else if (event.key === "Home") onNudge(-Infinity);
        else if (event.key === "End") onNudge(Infinity);
        else return;
        event.preventDefault();
      }}
    />
  );
}
