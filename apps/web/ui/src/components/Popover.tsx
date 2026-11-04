import { useEffect, useRef, useState, type ReactNode } from "react";

export function Popover({
  label,
  title,
  className,
  align = "start",
  placement = "auto",
  open,
  disabled,
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
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const [opening, setOpening] = useState<"up" | "down">("up");

  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) onClose();
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
    if (!open || placement !== "auto") return;
    const frame = window.requestAnimationFrame(() => {
      const anchor = box.current?.getBoundingClientRect();
      const height = panel.current?.getBoundingClientRect().height ?? 0;
      if (anchor === undefined) return;
      setOpening(window.innerHeight - anchor.bottom >= height + 8 ? "down" : "up");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, placement]);

  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        trigger.current?.focus();
      }
    }
    wasOpen.current = open;
  }, [open]);

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
      {open ? (
        <div
          ref={panel}
          className={`popover-panel${align === "end" ? " is-end" : ""}${placement === "down" || opening === "down" ? " is-down" : ""}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
