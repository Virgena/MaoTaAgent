import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IconName } from "maotaui";

import { useT } from "../lib/i18n.ts";
import { maoValue, useMaoEvents } from "../lib/maoEvents.ts";
import type { SessionSummary } from "../lib/rpc.ts";
import { useSidebarSections } from "../useSidebarSections.ts";
import { Popover } from "./Popover.tsx";

export const DEFAULT_PROJECT = "";

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
  const pinLabel = pinned ? t("unpin") : t("pin");
  const archiveLabel = archived ? t("restore") : t("archive");

  return (
    <div className={`side-item side-sub${active ? " is-on" : ""}`}>
      <button type="button" className="side-open" onClick={onOpen}>
        <span className="side-name">{session.title === "" ? t("newChat") : session.title}</span>
      </button>
      {running ? <mao-badge tone="accent">{t("running")}</mao-badge> : null}
      <span className="side-acts">
        <button
          type="button"
          className={`side-icon${pinned ? " is-on" : ""}`}
          title={pinLabel}
          aria-label={pinLabel}
          aria-pressed={pinned}
          onClick={onPin}
        >
          <mao-icon name="pin" />
        </button>
        <button type="button" className="side-icon" title={archiveLabel} aria-label={archiveLabel} onClick={onArchive}>
          <mao-icon name={archived ? "rotate-ccw" : "archive"} />
        </button>
      </span>
    </div>
  );
}

export function Sidebar({
  groups,
  chats,
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
  onTasks,
  onSearch,
}: {
  groups: ProjectGroup[];
  chats: SessionSummary[];
  pinned: SessionSummary[];
  archived: SessionSummary[];
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
  onTasks: () => void;
  onSearch: () => void;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  const commit = (cwd: string): void => {
    onRename(cwd, draft.trim());
    setRenaming(null);
    setDraft("");
  };

  const toggleProject = (cwd: string): void => {
    onProject(cwd);
    toggleProjectState(cwd);
  };

  const row = (session: SessionSummary, isPinned: boolean, isArchived: boolean) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeId}
      running={running.includes(session.id)}
      pinned={isPinned}
      archived={isArchived}
      onOpen={() => onOpen(session)}
      onPin={() => onPin(session.id)}
      onArchive={() => onArchive(session.id)}
    />
  );

  const folder = (
    key: string,
    label: string,
    icon: IconName,
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
          <mao-icon name={icon} className="icon side-folder-icon" />
          <span className="side-name">{label}</span>
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
          <mao-icon name="search" />
        </button>
      </div>

      <nav className="side-nav">
        <button type="button" className="side-row" onClick={() => onNew(DEFAULT_PROJECT)}>
          <mao-icon name="message-square" />
          {t("newChat")}
        </button>
        <button type="button" className="side-row" onClick={onTasks}>
          <mao-icon name="clock" />
          {t("tasks")}
        </button>
        <button type="button" className="side-row" onClick={onPlugins}>
          <mao-icon name="plug" />
          {t("plugins")}
        </button>
      </nav>

      <div className="side-body">
        {pinned.length === 0
          ? null
          : folder(
              "pinned",
              t("pinned"),
              "pin",
              sections.pinned,
              () => toggleSection("pinned"),
              pinned.map((session) => row(session, true, false)),
            )}

        {folder(
          "chats",
          t("chats"),
          "message-square",
          sections.chats,
          () => toggleSection("chats"),
          chats.length === 0
            ? <div className="side-empty">{t("noRecent")}</div>
            : chats.map((session) => row(session, false, false)),
          <button
            type="button"
            className="side-icon"
            title={t("newChat")}
            aria-label={t("newChat")}
            onClick={() => onNew(DEFAULT_PROJECT)}
          >
            <mao-icon name="plus" />
          </button>,
        )}

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
                <mao-icon name="plus" />
              </button>
              {group.registered ? (
                <Popover
                  className="side-more"
                  title={t("more")}
                  align="end"
                  open={menu === group.cwd}
                  onToggle={() => setMenu(menu === group.cwd ? null : group.cwd)}
                  onClose={() => setMenu(null)}
                  label={<mao-icon name="ellipsis" />}
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
            open ? "folder-open" : "folder",
            open,
            () => toggleProject(group.cwd),
            group.sessions.length === 0
              ? (
                  <button type="button" className="side-item side-sub side-new" onClick={() => onNew(group.cwd)}>
                    <mao-icon name="plus" className="icon icon-sm" />
                    <span className="side-name">{t("newChat")}</span>
                  </button>
                )
              : group.sessions.map((session) => row(session, false, false)),
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

        {folder(
          "archived",
          t("archived"),
          "archive",
          sections.archived,
          () => toggleSection("archived"),
          archived.length === 0
            ? <div className="side-empty">{t("noArchived")}</div>
            : archived.map((session) => row(session, false, true)),
        )}
      </div>

      <div className="side-foot">
        <button type="button" className="side-row" onClick={onSettings}>
          <mao-icon name="sliders-vertical" />
          {t("settings")}
        </button>
      </div>
    </aside>
  );
}
