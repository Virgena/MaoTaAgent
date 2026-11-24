import { useEffect, useMemo, useState } from "react";

import { getLang, useT } from "../lib/i18n.ts";
import type { SessionSummary } from "../lib/rpc.ts";
import { DEFAULT_TASK_FILTERS, filterTasks, type TaskFilters as TaskFilterValue } from "../taskList.ts";
import { Popover } from "./Popover.tsx";
import { projectLabel } from "./Sidebar.tsx";
import { TaskFilters } from "./TaskFilters.tsx";

export function TaskBrowser({
  sessions,
  names,
  running,
  pinned,
  archived,
  activeId,
  onOpen,
  onNew,
  onPin,
  onArchive,
  onPinMany,
  onArchiveMany,
}: {
  sessions: SessionSummary[];
  names: Record<string, string>;
  running: string[];
  pinned: string[];
  archived: string[];
  activeId: string | null;
  onOpen: (session: SessionSummary) => void;
  onNew: () => void;
  onPin: (id: string) => void;
  onArchive: (id: string) => void;
  onPinMany: (ids: string[], pinned: boolean) => void;
  onArchiveMany: (ids: string[], archived: boolean) => void;
}) {
  const t = useT();
  const [filters, setFilters] = useState<TaskFilterValue>({ ...DEFAULT_TASK_FILTERS, status: "all" });
  const [now, setNow] = useState(Date.now());
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const filtered = useMemo(() => filterTasks(sessions, archived, filters), [archived, filters, sessions]);
  const tasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return filtered;
    return filtered.filter((task) => `${task.title} ${task.cwd}`.toLowerCase().includes(needle));
  }, [filtered, query]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const formatTime = (value: string): string => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return "";
    const elapsed = Math.max(0, now - timestamp);
    if (elapsed < 60_000) return t("justNow");
    const relative = new Intl.RelativeTimeFormat(getLang(), { numeric: "auto" });
    if (elapsed < 3_600_000) return relative.format(-Math.floor(elapsed / 60_000), "minute");
    if (elapsed < 86_400_000) return relative.format(-Math.floor(elapsed / 3_600_000), "hour");
    if (elapsed < 7 * 86_400_000) return relative.format(-Math.floor(elapsed / 86_400_000), "day");
    return new Intl.DateTimeFormat(getLang(), { month: "short", day: "numeric" }).format(timestamp);
  };
  const taskGroups = useMemo(() => {
    if (filters.group === "none") return [{ key: "", label: "", tasks }];
    const grouped = new Map<string, SessionSummary[]>();
    for (const task of tasks) {
      const rows = grouped.get(task.cwd) ?? [];
      rows.push(task);
      grouped.set(task.cwd, rows);
    }
    return [...grouped].map(([cwd, rows]) => ({
      key: cwd,
      label: cwd === "" ? "" : projectLabel(cwd, "", names[cwd] ?? ""),
      tasks: rows,
    }));
  }, [filters.group, names, t, tasks]);
  const selectedIds = [...selected];
  const toggleSelected = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const stopSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set());
  };
  const allPinned = selectedIds.length > 0 && selectedIds.every((id) => pinned.includes(id));
  const allArchived = selectedIds.length > 0 && selectedIds.every((id) => archived.includes(id));

  return (
    <div className="tasks-view">
      <header className="tasks-head">
        <div>
          <h1>{t("taskListTitle")}</h1>
          <p>{t("tasksDescription")}</p>
        </div>
        <div className="tasks-actions">
          <button
            type="button"
            className="tasks-icon-button"
            title={t("searchTasks")}
            aria-label={t("searchTasks")}
            aria-pressed={searchOpen}
            onClick={() => {
              setSearchOpen((was) => !was);
              if (searchOpen) setQuery("");
            }}
          >
            <mao-icon name="search" size={17} />
          </button>
          <TaskFilters value={filters} onChange={setFilters} />
          <button
            type="button"
            className={`tasks-top-action${selecting ? " is-on" : ""}`}
            onClick={() => {
              if (selecting) stopSelecting();
              else setSelecting(true);
            }}
          >
            {selecting ? t("cancel") : t("selectTasks")}
          </button>
          <button type="button" className="tasks-top-action is-primary" onClick={onNew}>
            {t("newTask")}
          </button>
        </div>
      </header>

      {searchOpen ? (
        <label className="tasks-search">
          <mao-icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder={t("searchTasks")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}

      {selecting ? (
        <div className="task-selection-bar">
          <span>{t("selectedCount", { n: selectedIds.length })}</span>
          <button type="button" disabled={selectedIds.length === 0} onClick={() => {
            onPinMany(selectedIds, !allPinned);
            stopSelecting();
          }}>
            {t(allPinned ? "unpinSelected" : "pinSelected")}
          </button>
          <button type="button" disabled={selectedIds.length === 0} onClick={() => {
            onArchiveMany(selectedIds, !allArchived);
            stopSelecting();
          }}>
            {t(allArchived ? "restoreSelected" : "archiveSelected")}
          </button>
        </div>
      ) : null}

      <div className="tasks-list">
        {tasks.length === 0 ? <div className="tasks-empty">{t("noTasks")}</div> : null}
        {taskGroups.map((group) => (
          <section key={group.key} className="tasks-group">
            {group.label === "" ? null : <h2>{group.label}</h2>}
            {group.tasks.map((task) => {
              const project = task.cwd === "" ? "" : projectLabel(task.cwd, "", names[task.cwd] ?? "");
              const isPinned = pinned.includes(task.id);
              return (
                <div
                  key={task.id}
                  className={`task-row${task.id === activeId ? " is-on" : ""}${selected.has(task.id) ? " is-selected" : ""}`}
                >
                  {selecting ? (
                    <input
                      type="checkbox"
                      className="task-select"
                      aria-label={task.title === "" ? t("newChat") : task.title}
                      checked={selected.has(task.id)}
                      onChange={() => toggleSelected(task.id)}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="task-row-open"
                    onClick={() => selecting ? toggleSelected(task.id) : onOpen(task)}
                  >
                    <span className="task-row-main">
                      <span className="task-row-title">
                        {task.title === "" ? t("newChat") : task.title}
                        {isPinned ? <mao-icon name="pin" size={12} className="task-pin" /> : null}
                      </span>
                      {project === "" ? null : <span className="task-row-project">{project}</span>}
                    </span>
                    {running.includes(task.id) ? <mao-badge tone="accent">{t("running")}</mao-badge> : null}
                    {archived.includes(task.id) ? <mao-badge>{t("taskStatusArchived")}</mao-badge> : null}
                    <time className="task-row-time" dateTime={task.updated_at}>
                      {formatTime(task.updated_at)}
                    </time>
                  </button>
                  {selecting ? null : (
                    <Popover
                      className="task-row-more"
                      title={t("more")}
                      align="end"
                      open={menu === task.id}
                      onToggle={() => setMenu(menu === task.id ? null : task.id)}
                      onClose={() => setMenu(null)}
                      label={<mao-icon name="ellipsis" size={16} />}
                    >
                      <button type="button" className="option" onClick={() => { setMenu(null); onPin(task.id); }}>
                        <span className="option-text"><span className="option-name">{t(isPinned ? "unpin" : "pin")}</span></span>
                      </button>
                      <button type="button" className="option" onClick={() => { setMenu(null); onArchive(task.id); }}>
                        <span className="option-text">
                          <span className="option-name">{t(archived.includes(task.id) ? "restore" : "archive")}</span>
                        </span>
                      </button>
                    </Popover>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
