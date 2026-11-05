import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { applyEvent, type LiveTurn } from "./components/MessageList.tsx";
import { errorText, failureText } from "./lib/errors.ts";
import type { Approval, HostEvent, HostStatus } from "./lib/rpc.ts";
import type { SettingsView, WorkspaceView } from "./lib/rpc.ts";

export function useHostEvents({
  activeRef,
  turns,
  onCompactEvent,
  adoptSettings,
  adoptWorkspace,
  loadSpawned,
  openSession,
  rebuildApprovals,
  refreshSessions,
  setApprovals,
  setLives,
  setPending,
  setFailure,
  setHostStatus,
}: {
  activeRef: MutableRefObject<{ id: string; cwd: string } | null>;
  turns: MutableRefObject<Map<string, string>>;
  onCompactEvent: (event: HostEvent) => boolean;
  adoptSettings: (value: SettingsView) => void;
  adoptWorkspace: (value: WorkspaceView) => void;
  loadSpawned: (sessionId: string, cwd: string) => Promise<void>;
  openSession: (id: string, cwd: string) => Promise<void>;
  rebuildApprovals: (sessionId: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setLives: Dispatch<SetStateAction<Record<string, LiveTurn>>>;
  setPending: Dispatch<SetStateAction<string | null>>;
  setFailure: Dispatch<SetStateAction<{ session: string; text: string } | null>>;
  setHostStatus: Dispatch<SetStateAction<HostStatus | null>>;
}) {
  return useCallback((event: HostEvent): void => {
    if (onCompactEvent(event)) return;
    if (event.event === "host.status") {
      setHostStatus({
        state: event.host_state ?? "ready",
        ready: event.host_ready ?? 0,
        total: event.host_total ?? 0,
        ...(event.host_plugin === undefined ? {} : { plugin: event.host_plugin }),
      });
      return;
    }
    if (event.event === "settings.changed" && event.settings !== undefined) {
      adoptSettings(event.settings);
      return;
    }
    if (event.event === "workspace.changed" && event.workspace !== undefined) {
      adoptWorkspace(event.workspace);
      return;
    }
    if (event.event === "permission.request") {
      const id = event.request_id ?? "";
      if (id === "") return;
      const asked: Approval = {
        id,
        session_id: event.session_id ?? "",
        tool: event.tool ?? "",
        ...(event.call_id === undefined ? {} : { call_id: event.call_id }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.subagent === undefined ? {} : { subagent: event.subagent }),
      };
      setApprovals((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, asked]));
      return;
    }
    if (event.event === "permission.settled") {
      const id = event.request_id ?? "";
      setApprovals((prev) => prev.filter((item) => item.id !== id));
      return;
    }
    const turnId = event.turn_id ?? "";
    if (turnId === "") return;
    if (event.event === "turn.start") {
      const sessionId = event.session_id ?? "";
      if (sessionId === "") return;
      turns.current.set(turnId, sessionId);
      setLives((prev) => ({
        ...prev,
        [sessionId]: {
          turn_id: turnId,
          text: "",
          reasoning: "",
          reasoningMs: 0,
          step: 0,
          mark: { text: 0, reasoning: 0 },
          tools: [],
          subagents: [],
          running: true,
          startedAt: Date.now(),
        },
      }));
      return;
    }
    const sessionId = turns.current.get(turnId);
    if (sessionId === undefined) return;
    if (event.event === "turn.done" || event.event === "turn.cancelled" || event.event === "turn.error") {
      turns.current.delete(turnId);
      setLives((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setPending(null);
      if (event.event === "turn.error") {
        setFailure({ session: sessionId, text: errorText(event.code ?? -32603, event.message ?? "") });
      } else if (event.failure !== undefined) {
        setFailure({ session: sessionId, text: failureText(event.failure) });
      }
      void refreshSessions();
      const current = activeRef.current;
      if (current !== null && current.id === sessionId) {
        void openSession(sessionId, current.cwd);
        void loadSpawned(sessionId, current.cwd);
      }
      return;
    }
    setLives((prev) => {
      const turn = prev[sessionId];
      return turn === undefined ? prev : { ...prev, [sessionId]: applyEvent(turn, event) };
    });
  }, [
    activeRef,
    adoptSettings,
    adoptWorkspace,
    loadSpawned,
    onCompactEvent,
    openSession,
    rebuildApprovals,
    refreshSessions,
    setApprovals,
    setFailure,
    setLives,
    setPending,
    turns,
  ]);
}
