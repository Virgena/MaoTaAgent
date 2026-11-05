import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MainPane } from "./components/MainPane.tsx";
import type { LiveTurn } from "./components/MessageList.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { DEFAULT_PROJECT } from "./components/Sidebar.tsx";
import { SidebarPane } from "./components/SidebarPane.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { useContextCompact } from "./useContextCompact.ts";
import { useHostState } from "./useHostState.ts";
import { useHostEvents } from "./useHostEvents.ts";
import { useHostStream } from "./useHostStream.ts";
import { useSidebarWidth } from "./useSidebarWidth.ts";
import { describe } from "./lib/errors.ts";
import { adoptCatalog, setLang } from "./lib/i18n.ts";
import { reasoningFallback } from "./thinking.ts";
import {
  call,
  type AppInfo,
  type Approval,
  type HostStatus,
  type ModelRoute,
  type SessionFile,
  type SessionMessage,
  type SessionSummary,
} from "./lib/rpc.ts";

export function App() {
  const { width: sidebarWidth, resizing: sidebarResizing, startResize, nudge } = useSidebarWidth();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [kernelError, setKernelError] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const { settings, workspace, adoptSettings, adoptWorkspace, updateSettings, updateWorkspace } = useHostState({
    localeFallback: info?.i18n?.locale,
    onError: setKernelError,
  });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [project, setProject] = useState<string>(DEFAULT_PROJECT);
  const [active, setActive] = useState<{ id: string; cwd: string } | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ session: string; text: string } | null>(null);
  const [page, setPage] = useState<"chat" | "plugins" | "tasks">("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [manualPath, setManualPath] = useState(false);
  const [thinking, setThinking] = useState<string>("off");
  const [modelRoute, setModelRoute] = useState<ModelRoute | null>(null);
  const [permission, setPermission] = useState<string>("ask");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [lives, setLives] = useState<Record<string, LiveTurn>>({});
  const [spawned, setSpawned] = useState<Record<string, SessionSummary[]>>({});
  const activeRef = useRef(active);
  const turns = useRef(new Map<string, string>());
  const loadSeq = useRef(0);
  const drafts = useRef(new Set<string>());
  const thinkingVersion = useRef(0);
  const pendingThinking = useRef(new Map<string, string>());
  const projects = useMemo(() => workspace.projects.map((item) => item.path), [workspace.projects]);
  const names = useMemo(
    () => Object.fromEntries(workspace.projects.filter((item) => item.name !== null).map((item) => [item.path, item.name!])),
    [workspace.projects],
  );
  const pinned = workspace.pinned_sessions;
  const archived = workspace.archived_sessions;
  const theme = settings.theme ?? "system";
  const language = settings.locale ?? info?.i18n?.locale ?? "system";
  const reportFailure = useCallback((session: string, message: string): void => {
    setFailure({ session, text: message });
  }, []);
  const { context, clearContext, compactNow, loadContext, onCompactEvent } = useContextCompact({
    activeRef,
    info,
    thinking,
    modelRoute,
    onMessages: setMessages,
    onFailure: reportFailure,
  });
  const clearSessionView = useCallback((): void => {
    clearContext();
    setMessages([]);
    setApprovals([]);
    setSpawned({});
  }, [clearContext]);
  const newDraft = useCallback((cwd: string): { id: string; cwd: string } => {
    clearSessionView();
    thinkingVersion.current += 1;
    pendingThinking.current.clear();
    setModelRoute(null);
    setThinking("off");
    const fresh = { id: crypto.randomUUID(), cwd };
    drafts.current.add(fresh.id);
    activeRef.current = fresh;
    setActive(fresh);
    return fresh;
  }, [clearSessionView]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: light)");
    const paint = (): void => {
      document.documentElement.dataset.theme =
        theme === "light" || (theme === "system" && system.matches) ? "light" : "dark";
    };
    paint();
    system.addEventListener("change", paint);
    return () => system.removeEventListener("change", paint);
  }, [theme]);
  const openSession = useCallback(async (id: string, cwd: string): Promise<void> => {
    const seq = ++loadSeq.current;
    const thinkingAtLoad = thinkingVersion.current;
    try {
      const file = await call<SessionFile>("sessions.load", { id, cwd });
      if (seq !== loadSeq.current) return;
      const storedRoute = file.model_route;
      setModelRoute(
        storedRoute === null || storedRoute === undefined || storedRoute.provider === "api"
          ? null
          : { provider: storedRoute.provider, model: storedRoute.model },
      );
      const pending = pendingThinking.current.get(id);
      if (pending !== undefined) setThinking(pending);
      else if (thinkingVersion.current === thinkingAtLoad) setThinking(file.thinking ?? "off");
      setMessages(file.messages ?? []);
      void loadContext(id, cwd);
    } catch (error) {
      if (seq !== loadSeq.current) return;
      setMessages([]);
      setFailure({ session: id, text: describe(error) });
    }
  }, [loadContext]);
  const openSessionRef = useRef(openSession);
  useEffect(() => {
    openSessionRef.current = openSession;
  }, [openSession]);
  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const reply = await call<{ sessions?: SessionSummary[] }>("sessions.list");
      setSessions(reply.sessions ?? []);
    } catch (error) {
      setKernelError(describe(error));
    }
  }, []);
  /// The sub-sessions a session spawned, keyed by the call each one came from.
  /// They are fetched rather than listed because a subagent's work is opened on
  /// demand: the sidebar and the search never see them.
  const loadSpawned = useCallback(async (sessionId: string, cwd: string): Promise<void> => {
    try {
      const reply = await call<{ children?: SessionSummary[] }>("sessions.children", { id: sessionId, cwd });
      const keyed: Record<string, SessionSummary[]> = {};
      for (const child of reply.children ?? []) {
        const callId = child.parent?.call_id ?? "";
        if (callId === "") continue;
        keyed[callId] = [...(keyed[callId] ?? []), child];
      }
      setSpawned(keyed);
    } catch {
      setSpawned({});
    }
  }, []);
  const loadInfo = useCallback(async (): Promise<void> => {
    try {
      const [next, prefs, space] = await Promise.all([
        call<AppInfo>("app.info"),
        call<typeof settings>("settings.get"),
        call<typeof workspace>("workspace.get"),
      ]);
      adoptCatalog(next.i18n);
      adoptSettings(prefs);
      adoptWorkspace(space);
      setLang(prefs.locale ?? next.i18n?.locale ?? "system");
      setInfo(next);
      setKernelError(null);
    } catch (error) {
      setKernelError(describe(error));
    }
  }, []);
  /// The approval mode lives with the session in the permission plugin, so the
  /// page asks for it instead of keeping a copy of its own.
  const loadPermission = useCallback(async (sessionId: string, cwd: string): Promise<void> => {
    try {
      const reply = await call<{ mode?: string }>("permission.get", { session_id: sessionId, cwd });
      if (typeof reply.mode === "string") setPermission(reply.mode);
    } catch {
    }
  }, []);
  const rebuildApprovals = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const reply = await call<{ requests?: Approval[] }>("permission.pending", { session_id: sessionId });
      setApprovals(reply.requests ?? []);
    } catch {
      setApprovals([]);
    }
  }, []);
  const changeThinking = useCallback((level: string): void => {
    thinkingVersion.current += 1;
    setThinking(level);
    const current = activeRef.current;
    if (current === null || drafts.current.has(current.id)) return;
    pendingThinking.current.set(current.id, level);
    void call<SessionFile>(
      "sessions.set_thinking",
      { id: current.id, cwd: current.cwd, thinking: level },
    ).then((file) => {
      if (pendingThinking.current.get(current.id) !== level) return;
      pendingThinking.current.delete(current.id);
      if (activeRef.current?.id === current.id) setThinking(file.thinking ?? level);
    }).catch((error: unknown) => {
      if (pendingThinking.current.get(current.id) !== level) return;
      pendingThinking.current.delete(current.id);
      if (activeRef.current?.id !== current.id) return;
      setFailure({ session: current.id, text: describe(error) });
      void openSession(current.id, current.cwd);
    });
  }, [openSession]);
  const changeModelRoute = useCallback((next: ModelRoute | null): void => {
    setModelRoute(next);
    const fallback = reasoningFallback(info, next, thinking);
    if (fallback !== null) changeThinking(fallback);
  }, [changeThinking, info, thinking]);
  const handleEvent = useHostEvents({
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
  });
  const reconnect = useCallback((): void => {
    // The stream came back after a drop: the extension host is what dropped, so
    // the page says so until the replay status arrives with the truth.
    setHostStatus({ state: "recovering", ready: 0, total: 0 });
    const current = activeRef.current;
    if (current !== null && !drafts.current.has(current.id)) {
      void openSession(current.id, current.cwd);
      void loadSpawned(current.id, current.cwd);
      void rebuildApprovals(current.id);
    }
    void refreshSessions();
  }, [loadSpawned, openSession, rebuildApprovals, refreshSessions]);
  useHostStream({ onEvent: handleEvent, onReconnect: reconnect });
  useEffect(() => {
    if (hostStatus?.state !== "ready") return;
    const timer = setTimeout(() => setHostStatus(null), 3_000);
    return () => clearTimeout(timer);
  }, [hostStatus]);
  useEffect(() => {
    void loadInfo();
    void refreshSessions();
  }, [loadInfo, refreshSessions]);
  useEffect(() => {
    const fallback = reasoningFallback(info, modelRoute ?? info?.models?.default_route ?? null, thinking);
    if (fallback !== null) changeThinking(fallback);
  }, [changeThinking, info, modelRoute, thinking]);
  useEffect(() => {
    if (active === null) {
      clearSessionView();
      return;
    }
    if (drafts.current.has(active.id)) {
      clearSessionView();
      return;
    }
    void openSessionRef.current(active.id, active.cwd);
    void loadSpawned(active.id, active.cwd);
    void loadPermission(active.id, active.cwd);
    void rebuildApprovals(active.id);
  }, [active, clearSessionView, loadPermission, loadSpawned, rebuildApprovals]);
  const send = useCallback(
    async (text: string, at: { id: string; cwd: string }): Promise<void> => {
      if (text.trim() === "") return;
      setFailure(null);
      setPending(text);
      try {
        const reply = await call<{ turn_id: string }>("chat.send", {
          session_id: at.id,
          cwd: at.cwd,
          input: text,
          thinking,
          ...(modelRoute === null ? {} : { route: modelRoute }),
        });
        turns.current.set(reply.turn_id, at.id);
        drafts.current.delete(at.id);
      } catch (error) {
        setPending(null);
        setFailure({ session: at.id, text: describe(error) });
      }
    },
    [modelRoute, thinking, turns],
  );

  const submit = useCallback(
    (text: string): void => {
      const current = activeRef.current;
      if (current !== null) {
        void send(text, current);
        return;
      }
      const fresh = newDraft(project);
      setFailure(null);
      void send(text, fresh);
    },
    [newDraft, project, send],
  );

  const cancel = async (): Promise<void> => {
    const current = activeRef.current;
    const turn = current === null ? undefined : lives[current.id];
    if (current === null || turn === undefined) return;
    try {
      await call("chat.cancel", { turn_id: turn.turn_id });
    } catch (error) {
      setFailure({ session: current.id, text: describe(error) });
    }
  };

  const answer = useCallback(
    async (id: string, decision: "allow" | "deny"): Promise<void> => {
      const current = activeRef.current;
      try {
        await call("permission.answer", { id, decision });
        setApprovals((prev) => prev.filter((item) => item.id !== id));
      } catch (error) {
        setFailure({ session: current?.id ?? "", text: describe(error) });
        if (current !== null) void rebuildApprovals(current.id);
      }
    },
    [rebuildApprovals],
  );

  const changePermission = useCallback(
    async (mode: string): Promise<void> => {
      const current = activeRef.current;
      if (current === null) return;
      try {
        const reply = await call<{ mode?: string }>("permission.set", {
          session_id: current.id,
          cwd: current.cwd,
          mode,
        });
        if (typeof reply.mode === "string") setPermission(reply.mode);
        return;
      } catch (error) {
        setFailure({ session: current.id, text: describe(error) });
      }
      void loadPermission(current.id, current.cwd);
    },
    [loadPermission],
  );

  const newChat = (cwd: string): void => {
    loadSeq.current += 1;
    setFailure(null);
    setPending(null);
    setPage("chat");
    newDraft(cwd);
  };

  const openWorktree = async (path: string): Promise<void> => {
    const next = await updateWorkspace("workspace.register", { path });
    if (next === undefined) throw new Error("the worktree was created but could not be added to projects");
    setProject(path);
    newChat(path);
  };

  const open = (session: SessionSummary): void => {
    setFailure(null);
    setPending(null);
    setPage("chat");
    setActive({ id: session.id, cwd: session.cwd === "" ? DEFAULT_PROJECT : session.cwd });
  };

  const addProject = async (cwd: string): Promise<void> => {
    const next = await updateWorkspace("workspace.register", { path: cwd });
    if (next !== undefined) setProject(cwd);
  };

  const pickProject = (): void => {
    setManualPath(true);
  };

  const allSessions = useMemo(() => {
    if (active === null || sessions.some((session) => session.id === active.id)) return sessions;
    return [{ id: active.id, cwd: active.cwd, title: "", updated_at: new Date().toISOString() }, ...sessions];
  }, [active, sessions]);

  const renameProject = (cwd: string, name: string): void => {
    void updateWorkspace("workspace.rename", { path: cwd, name });
  };

  const removeProject = (cwd: string): void => {
    void updateWorkspace("workspace.remove", { path: cwd }).then((next) => {
      if (next !== undefined && project === cwd) setProject(DEFAULT_PROJECT);
    });
  };

  const flipPin = (id: string): void => {
    void updateWorkspace("workspace.set_pin", { session_id: id, pinned: !pinned.includes(id) });
  };
  const flipArchive = (id: string): void => {
    void updateWorkspace("workspace.set_archive", { session_id: id, archived: !archived.includes(id) });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (settingsOpen) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((was) => !was);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  return (
    <div className="app" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <SidebarPane
        sessions={allSessions}
        activeId={active?.id ?? null}
        projects={projects}
        names={names}
        pinned={pinned}
        archived={archived}
        project={project}
        running={Object.keys(lives)}
        onNew={newChat}
        onProject={setProject}
        onAddProject={addProject}
        manual={manualPath}
        onManual={setManualPath}
        onOpen={open}
        onRename={renameProject}
        onRemoveProject={removeProject}
        onPin={flipPin}
        onArchive={flipArchive}
        onSettings={() => {
          setPalette(false);
          setSettingsSection(null);
          setSettingsOpen(true);
        }}
        onPlugins={() => setPage("plugins")}
        onTasks={() => setPage("tasks")}
        onSearch={() => setPalette(true)}
      />
      <SidebarResizer
        width={sidebarWidth}
        resizing={sidebarResizing}
        onStart={startResize}
        onNudge={nudge}
      />
      <MainPane
        page={page}
        info={info}
        kernelError={kernelError}
        hostStatus={hostStatus}
        project={project}
        projects={projects}
        sessions={allSessions}
        archived={archived}
        names={names}
        active={active}
        lives={lives}
        messages={messages}
        pending={pending}
        failure={failure}
        thinking={thinking}
        modelRoute={modelRoute}
        permission={permission}
        approvals={approvals}
        context={context}
        onCompact={() => void compactNow()}
        spawned={spawned}
        palette={palette}
        onPalette={setPalette}
        onNew={newChat}
        onPickProject={pickProject}
        onOpen={open}
        onRetry={() => void loadInfo()}
        onOpenModels={() => {
          setSettingsSection("models");
          setSettingsOpen(true);
        }}
        onOpenWorktree={openWorktree}
        onThinking={changeThinking}
        onModelRoute={changeModelRoute}
        onPermission={(mode) => void changePermission(mode)}
        onAnswer={(id, decision) => void answer(id, decision)}
        onSend={submit}
        onCancel={() => void cancel()}
      />
      <SettingsView
        open={settingsOpen}
        requestedSection={settingsSection}
        info={info}
        theme={theme}
        locale={language}
        onTheme={(next) => void updateSettings({ theme: next })}
        onLanguage={(next) => void updateSettings({ locale: next })}
        onModels={(models) => {
          setInfo((current) => current === null ? current : { ...current, models });
        }}
        onSectionHandled={() => setSettingsSection(null)}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsSection(null);
        }}
      />
    </div>
  );
}
