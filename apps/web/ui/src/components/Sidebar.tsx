import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useT } from "../lib/i18n.ts";
import { maoValue, useMaoEvents } from "../lib/maoEvents.ts";
import type { SessionSummary } from "../lib/rpc.ts";
import { DEFAULT_TASK_FILTERS, filterTasks } from "../taskList.ts";
import { useSidebarSections } from "../useSidebarSections.ts";
import { Popover } from "./Popover.tsx";
import { TaskFilters } from "./TaskFilters.tsx";

export const DEFAULT_PROJECT = "";
const RECENT_TASK_LIMIT = 30;

export function projectLabel(cwd: string, fallback = "", name = ""): string {
  if (name !== "") return name;
  if (cwd === DEFAULT_PROJECT) return fallback;
  const parts = cwd.split(/[\\/]+/).filter((part) => part !== "");
  return parts.at(-1) ?? cwd;
}

export interface ProjectGroup {
  cwd: string;
  registered: boolean;
  sessions: SessionSummary[];
}

function SessionRow({
  session,
  active,
  running,
  pinned,
  archived,
  onOpen,
  onPin,
  onArchive,
}: {
  session: SessionSummary;
  active: boolean;
  running: boolean;
  pinned: boolean;
  archived: boolean;
  onOpen: () => void;
  onPin: () => void;
  onArchive: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const pinLabel = pinned ? t("unpin") : t("pin");
  const archiveLabel = archived ? t("restore") : t("archive");

  return (
    <div className={`side-item side-sub${active ? " is-on" : ""}`}>
      <button type="button" className="side-open" onClick={onOpen}>
        <mao-icon name="message-square" size={14} className="side-session-icon" />
        <span className="side-name">{session.title === "" ? t("newChat") : session.title}</span>
      </button>
      {running ? <mao-badge tone="accent">{t("running")}</mao-badge> : null}
      <span className="side-acts">
        <Popover
          className="side-more"
          title={t("more")}
          align="end"
          open={menuOpen}
          onToggle={() => setMenuOpen((was) => !was)}
          onClose={() => setMenuOpen(false)}
          label={<mao-icon name="ellipsis" size={14} />}
        >
          <button type="button" className="option" onClick={() => { setMenuOpen(false); onPin(); }}>
            <span className="option-text"><span className="option-name">{pinLabel}</span></span>
          </button>
          <button type="button" className="option" onClick={() => { setMenuOpen(false); onArchive(); }}>
            <span className="option-text"><span className="option-name">{archiveLabel}</span></span>
          </button>
        </Popover>
      </span>
    </div>
  );
}

export function Sidebar({
  groups,
  recent,
  pinned,
  archived,
  names,
  activeId,
  running,
  onNew,
  onProject,
  onAddProject,
  manual,
  onManual,
  onOpen,
  onRename,
  onRemoveProject,
  onPin,
  onArchive,
  onSettings,
  onPlugins,
  onScheduled,
  onTasks,
  onSearch,
}: {
  groups: ProjectGroup[];
  recent: SessionSummary[];
  pinned: SessionSummary[];
  archived: string[];
  names: Record<string, string>;
  activeId: string | null;
  running: string[];
  onNew: (cwd: string) => void;
  onProject: (cwd: string) => void;
  onAddProject: (cwd: string) => void;
  manual: boolean;
  onManual: (open: boolean) => void;
  onOpen: (session: SessionSummary) => void;
  onRename: (cwd: string, name: string) => void;
  onRemoveProject: (cwd: string) => void;
  onPin: (id: string) => void;
  onArchive: (id: string) => void;
  onSettings: () => void;
  onPlugins: () => void;
  onScheduled: () => void;
  onTasks: () => void;
  onSearch: () => void;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState(DEFAULT_TASK_FILTERS);
  const draftRef = useRef<HTMLElement>(null);
  const pathRef = useRef<HTMLElement>(null);
  useMaoEvents(draftRef, { "mt-input": (event) => setDraft(maoValue(event)) });
  useMaoEvents(pathRef, { "mt-input": (event) => setPath(maoValue(event)) });
  useEffect(() => {
    if (renaming !== null) draftRef.current?.focus();
  }, [renaming]);
  useEffect(() => {
    if (manual) pathRef.current?.focus();
  }, [manual]);
  const { sections, toggleSection, toggleProject: toggleProjectState } = useSidebarSections();
  const archivedIds = useMemo(() => new Set(archived), [archived]);
  const pinnedIds = useMemo(() => new Set(pinned.map((session) => session.id)), [pinned]);
  const recentRows = useMemo(
    () => filterTasks(
      recent.filter((session) => !pinnedIds.has(session.id)),
      archived,
      filters,
      Date.now(),
      RECENT_TASK_LIMIT,
    ),
    [archived, filters, pinnedIds, recent],
  );
  const recentGroups = useMemo(() => {
    if (filters.group === "none") return [{ key: "", label: "", sessions: recentRows }];
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of recentRows) {
      const cwd = session.cwd === "" ? DEFAULT_PROJECT : session.cwd;
      const rows = grouped.get(cwd) ?? [];
      rows.push(session);
      grouped.set(cwd, rows);
    }
    return [...grouped].map(([cwd, sessions]) => ({
      key: cwd,
      label: cwd === DEFAULT_PROJECT ? "" : projectLabel(cwd, "", names[cwd] ?? ""),
      sessions,
    }));
  }, [filters.group, names, recentRows, t]);

  const commit = (cwd: string): void => {
    onRename(cwd, draft.trim());
    setRenaming(null);
    setDraft("");
  };

  const toggleProject = (cwd: string): void => {
    onProject(cwd);
    toggleProjectState(cwd);
  };

  const row = (session: SessionSummary, isPinned: boolean) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeId}
      running={running.includes(session.id)}
      pinned={isPinned}
      archived={archivedIds.has(session.id)}
      onOpen={() => onOpen(session)}
      onPin={() => onPin(session.id)}
      onArchive={() => onArchive(session.id)}
    />
  );

  const folder = (
    key: string,
    label: string,
    open: boolean,
    toggle: () => void,
    children: ReactNode,
    actions?: ReactNode,
  ) => (
    <div key={key} className="side-folder">
      <div className="side-item side-folder-row">
        <button
          type="button"
          className="side-open side-folder-toggle"
          title={label}
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="side-name">{label}</span>
          <mao-icon name={open ? "chevron-down" : "chevron-right"} size={14} className="side-folder-icon" />
        </button>
        {actions === undefined ? null : <span className="side-acts">{actions}</span>}
      </div>
      {open ? <div className="side-children">{children}</div> : null}
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="side-brand">
        <span>MaoTa</span>
        <button type="button" className="side-icon" title={t("searchChats")} aria-label={t("searchChats")} onClick={onSearch}>
          <mao-icon name="search" size={16} />
        </button>
      </div>

      <nav className="side-nav">
        <button type="button" className="side-row" onClick={() => onNew(DEFAULT_PROJECT)}>
          <mao-icon name="message-square-plus" size={16} />
          {t("newChat")}
        </button>
        <button type="button" className="side-row" onClick={onScheduled}>
          <mao-icon name="calendar-clock" size={16} />
          {t("tasks")}
        </button>
        <button type="button" className="side-row" onClick={onPlugins}>
          <mao-icon name="puzzle" size={16} />
          {t("plugins")}
        </button>
      </nav>

      <div className="side-body">
        {pinned.length === 0
          ? null
          : folder(
              "pinned",
              t("pinned"),
              sections.pinned,
              () => toggleSection("pinned"),
              pinned.map((session) => row(session, true)),
            )}

        <div className="side-recent">
          <div className="side-item side-folder-row side-recent-header">
            <button
              type="button"
              className="side-open side-folder-toggle"
              aria-expanded={sections.recent}
              onClick={() => toggleSection("recent")}
            >
              <span className="side-name">{t("recent")}</span>
              <mao-icon name={sections.recent ? "chevron-down" : "chevron-right"} size={14} className="side-folder-icon" />
            </button>
            <TaskFilters value={filters} onChange={setFilters} align="start" outside />
          </div>
          {sections.recent ? (
            <div className="side-recent-list">
              {recentGroups.map((group) => (
                <div key={group.key} className="side-recent-group">
                  {group.label === "" ? null : <div className="side-recent-label">{group.label}</div>}
                  {group.sessions.map((session) => row(session, false))}
                </div>
              ))}
              <button type="button" className="side-view-all" onClick={onTasks}>
                {t("viewAll")}
              </button>
              {recentRows.length === 0 ? <div className="side-empty">{t("noTasks")}</div> : null}
            </div>
          ) : null}
        </div>

        {groups.map((group) => {
          const open = !sections.projects.includes(group.cwd);
          const label = projectLabel(group.cwd, t("defaultProject"), names[group.cwd] ?? "");
          const actions = (
            <>
              <button
                type="button"
                className="side-icon"
                title={t("newSession")}
                aria-label={t("newSession")}
                onClick={() => onNew(group.cwd)}
              >
                <mao-icon name="plus" size={14} />
              </button>
              {group.registered ? (
                <Popover
                  className="side-more"
                  title={t("more")}
                  align="end"
                  open={menu === group.cwd}
                  onToggle={() => setMenu(menu === group.cwd ? null : group.cwd)}
                  onClose={() => setMenu(null)}
                  label={<mao-icon name="ellipsis" size={14} />}
                >
                  <button
                    type="button"
                    className="option"
                    onClick={() => {
                      setMenu(null);
                      setRenaming(group.cwd);
                      setDraft(names[group.cwd] ?? "");
                    }}
                  >
                    <span className="option-text">
                      <span className="option-name">{t("rename")}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="option is-danger"
                    onClick={() => {
                      setMenu(null);
                      onRemoveProject(group.cwd);
                    }}
                  >
                    <span className="option-text">
                      <span className="option-name">{t("removeProject")}</span>
                    </span>
                  </button>
                </Popover>
              ) : null}
            </>
          );

          if (renaming === group.cwd) {
            return (
              <div key={group.cwd} className="side-folder">
                <div className="side-item side-folder-row is-editing">
                  <mao-text-field
                    ref={draftRef}
                    className="side-path"
                    placeholder={label}
                    value={draft}
                    onBlur={() => commit(group.cwd)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commit(group.cwd);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                </div>
              </div>
            );
          }

          return folder(
            group.cwd,
            label,
            open,
            () => toggleProject(group.cwd),
            group.sessions.length === 0
              ? (
                  <button type="button" className="side-item side-sub side-new" onClick={() => onNew(group.cwd)}>
                    <span className="side-name">{t("newChat")}</span>
                  </button>
                )
              : group.sessions.map((session) => row(session, false)),
            actions,
          );
        })}

        {manual ? (
          <mao-text-field
            ref={pathRef}
            className="side-path side-add-path"
            placeholder={t("pathPlaceholder")}
            value={path}
            onBlur={() => {
              setPath("");
              onManual(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const value = path.trim();
                if (value !== "") onAddProject(value);
                setPath("");
                onManual(false);
              }
              if (event.key === "Escape") {
                setPath("");
                onManual(false);
              }
            }}
          />
        ) : null}
      </div>

      <div className="side-foot">
        <button type="button" className="side-row" onClick={onSettings}>
          <mao-icon name="settings" size={16} />
          {t("settings")}
        </button>
      </div>
    </aside>
  );
}
