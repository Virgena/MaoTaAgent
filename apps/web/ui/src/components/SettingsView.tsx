import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ICON, MaoIcon as Icon, MaoSegmented, MaoSelect } from "maotaui";

import { LANGS, useT } from "../lib/i18n.ts";
import type { AppInfo, ThemePreference } from "../lib/rpc.ts";
import { ModelsSettings } from "./ModelsSettings.tsx";

interface NavItem {
  id: string;
  label: string;
  note?: string;
}

interface Row extends NavItem {
  name: string;
  control?: ReactNode;
}

interface Section {
  id: string;
  group: string;
  label: string;
  rows: Row[];
  nav: NavItem[];
}

interface Jump {
  section: string;
  target: string;
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function SettingsView({
  open,
  requestedSection,
  info,
  theme,
  locale,
  onTheme,
  onLanguage,
  onModels,
  onSectionHandled,
  onClose,
}: {
  open: boolean;
  requestedSection?: string | null;
  info: AppInfo | null;
  theme: string;
  locale: string;
  onTheme: (theme: ThemePreference) => void;
  onLanguage: (locale: string) => void;
  onModels: (models: NonNullable<AppInfo["models"]>) => void;
  onSectionHandled?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDivElement | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const [section, setSection] = useState("general");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>("language");
  const [jump, setJump] = useState<Jump | null>(null);
  const [modelEditing, setModelEditing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ general: true });

  const pluginRows = [...new Set(Object.values(info?.capabilities ?? {}).map((route) => route.plugin))]
    .sort()
    .map((plugin) => {
      const note = Object.entries(info?.capabilities ?? {})
        .filter(([, route]) => route.plugin === plugin)
        .map(([capability]) => capability)
        .join(" · ");
      return { id: plugin, name: plugin, label: plugin, note };
    });

  const sections: Section[] = [
    {
      id: "general",
      group: t("personal"),
      label: t("general"),
      rows: [
        {
          id: "language",
          name: t("language"),
          label: t("language"),
          note: t("languageNote"),
          control: (
            <MaoSelect
              className="settings-lang"
              aria-label={t("language")}
              options={[{ value: "system", label: t("followSystem") }, ...LANGS]}
              value={locale}
              onChange={(event) => onLanguage(event.target.value)}
            />
          ),
        },
      ],
      nav: [{ id: "language", label: t("language"), note: t("languageNote") }],
    },
    {
      id: "appearance",
      group: t("personal"),
      label: t("personalization"),
      rows: [
        {
          id: "appearance",
          name: t("appearance"),
          label: t("appearance"),
          control: (
            <MaoSegmented
              label={t("appearance")}
              options={[
                { value: "system", label: t("followSystem") },
                { value: "dark", label: t("dark") },
                { value: "light", label: t("light") },
              ]}
              value={theme}
              onChange={(value) => onTheme(value as ThemePreference)}
            />
          ),
        },
      ],
      nav: [{ id: "appearance", label: t("appearance") }],
    },
    {
      id: "models",
      group: t("personal"),
      label: t("models"),
      rows: [],
      nav: [{ id: "models", label: t("modelSettings") }],
    },
    {
      id: "about",
      group: t("system"),
      label: t("about"),
      rows: pluginRows,
      nav: pluginRows,
    },
  ];

  const needle = query.trim().toLowerCase();
  const hunting = needle !== "";
  const hits = sections
    .map((item) => {
      const matching = item.nav.filter((entry) =>
        `${entry.label} ${entry.note ?? ""}`.toLowerCase().includes(needle));
      const sectionMatches = `${item.label} ${item.group}`.toLowerCase().includes(needle);
      return {
        section: item,
        rows: matching.length > 0 ? matching : sectionMatches ? item.nav : [],
      };
    })
    .filter((hit) => hit.rows.length > 0);
  const shown = sections.find((item) => item.id === section) ?? sections[0]!;
  const groups = [...new Set(sections.map((item) => item.group))];

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => {
        if (previous !== null && previous.isConnected) previous.focus();
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open || jump === null || jump.section !== section) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`settings-${jump.section}-${jump.target}`)?.scrollIntoView({ block: "nearest" });
      setJump(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [jump, open, section]);

  const go = (id: string, nextTarget?: string): void => {
    setSection(id);
    setTarget(nextTarget ?? null);
    setExpanded((current) => ({ ...current, [id]: true }));
    setQuery("");
    if (nextTarget === undefined) {
      setJump(null);
      window.requestAnimationFrame(() => pane.current?.scrollTo({ top: 0 }));
    } else {
      setJump({ section: id, target: nextTarget });
    }
  };

  const toggleSection = (id: string): void => {
    const active = id === section;
    setSection(id);
    setTarget(null);
    setJump(null);
    setExpanded((current) => ({ ...current, [id]: active ? !current[id] : true }));
    if (!active) {
      setQuery("");
      window.requestAnimationFrame(() => pane.current?.scrollTo({ top: 0 }));
    }
  };

  useEffect(() => {
    if (!open || requestedSection === null || requestedSection === undefined) return;
    setSection(requestedSection);
    setTarget(null);
    setQuery("");
    setExpanded((current) => ({ ...current, [requestedSection]: true }));
    onSectionHandled?.();
  }, [onSectionHandled, open, requestedSection]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      if (modelEditing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const active = document.activeElement;
    const nested = active instanceof Element ? active.closest(".model-editor-dialog") : null;
    const scope = nested instanceof HTMLElement ? nested : dialog.current;
    if (scope === null) return;
    const items = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      event.preventDefault();
      scope.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && (active === first || !scope.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !scope.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="settings-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settings-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="settings-dialog-head">
          <span id="settings-dialog-title">{t("settings")}</span>
          <button
            type="button"
            className="settings-close"
            title={t("close")}
            aria-label={t("close")}
            onClick={onClose}
          >
            <Icon name={ICON.close} />
          </button>
        </header>

        <div className="settings-body">
          <aside className="settings-rail">
          <div className="settings-search">
            <input
              value={query}
              placeholder={t("searchSettings")}
              aria-label={t("searchSettings")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || query === "") return;
                event.stopPropagation();
                setQuery("");
              }}
            />
            {query === "" ? null : (
              <button
                type="button"
                className="settings-search-clear"
                title={t("clear")}
                aria-label={t("clear")}
                onClick={() => setQuery("")}
              >
                <Icon name={ICON.close} className="icon icon-sm" />
              </button>
            )}
          </div>

          {hunting ? (
            <div className="settings-hits">
              {hits.length === 0 ? <div className="settings-empty">{t("noMatch")}</div> : null}
              {hits.map((hit) => (
                <div key={hit.section.id}>
                  <button type="button" className="settings-hit-head" onClick={() => go(hit.section.id)}>
                    {hit.section.label}
                  </button>
                  {hit.rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="settings-hit"
                      onClick={() => go(hit.section.id, row.id)}
                    >
                      {row.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <nav className="settings-nav" aria-label={t("settings")}>
              {groups.map((group) => (
                <div key={group}>
                  <div className="settings-group">{group}</div>
                  {sections.filter((item) => item.group === group).map((item) => {
                    const isOpen = expanded[item.id] ?? false;
                    const isActive = item.id === section;
                    return (
                      <div key={item.id}>
                        <button
                          type="button"
                          className={`settings-nav-item${isActive ? " is-on" : ""}`}
                          aria-current={isActive ? "page" : undefined}
                          aria-expanded={isOpen}
                          onClick={() => toggleSection(item.id)}
                        >
                          <Icon
                            name={isOpen ? ICON.chevronDown : ICON.chevronRight}
                            className="icon icon-sm settings-chevron"
                          />
                          <span>{item.label}</span>
                        </button>
                        {isOpen ? (
                          <div className="settings-children">
                            {item.nav.map((row) => (
                              <button
                                key={row.id}
                                type="button"
                                className={`settings-nav-child${isActive && row.id === target ? " is-on" : ""}`}
                                onClick={() => go(item.id, row.id)}
                              >
                                {row.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </nav>
          )}
          </aside>

          <div className="settings-pane" ref={pane}>
            <div className="settings-content">
              <section key={shown.id} className="settings-section" id={`settings-section-${shown.id}`}>
                {shown.id === "models" ? (
                  <div id="settings-models-models">
                    <ModelsSettings
                      catalog={info?.models ?? null}
                      onChanged={onModels}
                      onEditingChange={setModelEditing}
                    />
                  </div>
                ) : (
                  <div className="settings-card">
                    {shown.rows.map((row) => (
                      <div
                        key={row.id}
                        className="settings-item"
                        id={`settings-${shown.id}-${row.id}`}
                      >
                        <div className="settings-item-text">
                          <div className="settings-item-name">{row.name}</div>
                          {row.note === undefined ? null : <div className="settings-item-note">{row.note}</div>}
                        </div>
                        {row.control === undefined ? null : <div className="settings-item-control">{row.control}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
