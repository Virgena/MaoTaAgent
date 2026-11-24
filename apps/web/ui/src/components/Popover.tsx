import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Popover({
  label,
  title,
  className,
  align = "start",
  placement = "auto",
  open,
  disabled,
  outside,
  onToggle,
  onClose,
  children,
}: {
  label: ReactNode;
  title: string;
  className?: string;
  align?: "start" | "end";
  placement?: "auto" | "up" | "down";
  open: boolean;
  disabled?: boolean;
  outside?: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const [opening, setOpening] = useState<"up" | "down">("up");
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent): void => {
      if (
        box.current !== null &&
        !box.current.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || outside || placement !== "auto") return;
    const frame = window.requestAnimationFrame(() => {
      const anchor = box.current?.getBoundingClientRect();
      const height = panel.current?.getBoundingClientRect().height ?? 0;
      if (anchor === undefined) return;
      setOpening(window.innerHeight - anchor.bottom >= height + 8 ? "down" : "up");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, outside, placement]);

  useEffect(() => {
    if (!open || outside !== true) {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect();
      const panelBox = panel.current?.getBoundingClientRect();
      if (anchor === undefined || panelBox === undefined) return;
      const gap = 8;
      const left = anchor.right + gap + panelBox.width <= window.innerWidth - gap
        ? anchor.right + gap
        : anchor.left - panelBox.width - gap;
      setPosition({
        top: Math.max(gap, Math.min(anchor.top, window.innerHeight - panelBox.height - gap)),
        left: Math.max(gap, left),
      });
    };
    const frame = window.requestAnimationFrame(place);
    const observer = panel.current === null ? null : new ResizeObserver(place);
    if (panel.current !== null) observer?.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, outside]);

  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        trigger.current?.focus();
      }
    }
    wasOpen.current = open;
  }, [open]);

  const panelNode = open ? (
    <div
      ref={panel}
      className={`popover-panel${align === "end" ? " is-end" : ""}${!outside && (placement === "down" || opening === "down") ? " is-down" : ""}${outside ? " is-portal" : ""}`}
      style={outside ? {
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position === null ? "hidden" : "visible",
      } : undefined}
    >
      {children}
    </div>
  ) : null;

  return (
    <div className={`popover-anchor ${className ?? ""}`.trim()} ref={box}>
      <button
        ref={trigger}
        type="button"
        className="popover-trigger"
        title={title}
        aria-label={title}
        aria-expanded={open}
        disabled={disabled === true}
        onClick={onToggle}
      >
        {label}
      </button>
      {outside === true && panelNode !== null ? createPortal(panelNode, document.body) : panelNode}
    </div>
  );
}
