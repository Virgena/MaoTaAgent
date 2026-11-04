import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

const STORAGE_KEY = "maota.sidebar.width";
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 340;
const SIDEBAR_WIDTH_DEFAULT = 224;

function clamp(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

function storedWidth(): number {
  try {
    return clamp(Number(window.localStorage.getItem(STORAGE_KEY)) || SIDEBAR_WIDTH_DEFAULT);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function useSidebarWidth() {
  const [width, setWidth] = useState(storedWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
    }
  }, [width]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    const move = (next: PointerEvent): void => setWidth(clamp(startWidth + next.clientX - startX));
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setResizing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, [width]);

  const nudge = useCallback((delta: number): void => {
    setWidth((current) => clamp(current + delta));
  }, []);

  return { width, resizing, startResize, nudge };
}
