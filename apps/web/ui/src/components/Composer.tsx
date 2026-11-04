import { useState } from "react";
import { ICON, MaoButton, MaoIcon as Icon, MaoTextArea } from "maotaui";

import { useT } from "../lib/i18n.ts";
import type { AppInfo, ContextView, ModelRoute } from "../lib/rpc.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { GitControls } from "./GitControls.tsx";
import { PERMISSION_OPTIONS, PermissionPicker } from "./PermissionPicker.tsx";
import { Popover } from "./Popover.tsx";
import { SkillPicker } from "./SkillPicker.tsx";
import { ThinkingPicker } from "./ThinkingPicker.tsx";

export function Composer({
  info,
  cwd,
  thinking,
  modelRoute,
  permission,
  permissionDisabled,
  running,
  blocked,
  context,
  inConversation,
  projects,
  names,
  onNew,
  onPickProject,
  onOpenModels,
  onOpenWorktree,
  onThinking,
  onModelRoute,
  onPermission,
  onCompact,
  onSend,
  onCancel,
}: {
  info: AppInfo | null;
  cwd: string;
  thinking: string;
  modelRoute: ModelRoute | null;
  permission: string;
  permissionDisabled: boolean;
  running: boolean;
  blocked: boolean;
  context: ContextView | null;
  inConversation: boolean;
  projects: string[];
  names: Record<string, string>;
  onNew: (cwd: string) => void;
  onPickProject: () => void;
  onOpenModels: () => void;
  onOpenWorktree: (path: string) => Promise<void>;
  onThinking: (level: string) => void;
  onModelRoute: (route: ModelRoute | null) => void;
  onPermission: (mode: string) => void;
  onCompact: () => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const hasModel = (info?.models?.models ?? []).some((model) =>
    model.enabled && (info?.models?.providers.find((item) => item.id === model.provider)?.enabled ?? true));
  const [text, setText] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const permissionOption = PERMISSION_OPTIONS.find((option) => option.value === permission) ?? PERMISSION_OPTIONS[0]!;
  const project = cwd === ""
    ? t("chatWorkspace")
    : cwd.split(/[\\/]+/).filter((part) => part !== "").at(-1) ?? t("defaultProject");
  const projectNeedle = projectQuery.trim().toLowerCase();
  const visibleProjects = projects
    .filter((path) => `${names[path] ?? ""} ${path}`.toLowerCase().includes(projectNeedle))
    .sort((left, right) => (names[left] ?? left).localeCompare(names[right] ?? right));

  const submit = (): void => {
    if (running || blocked || !hasModel || text.trim() === "") return;
    onSend(text);
    setText("");
  };

  /// A reference rather than the instructions, so the sentence stays readable
  /// and the model still does the loading.
  const reference = (name: string): void => {
    setText((was) => {
      const line = `Use the "${name}" skill.`;
      return was.trim() === "" ? line : `${was.replace(/\s+$/, "")}\n${line}`;
    });
  };

  return (
    <div className="composer">
      <div className="composer-context">
        <Popover
          className="composer-project"
          title={t("workspaces")}
          open={projectOpen}
          onToggle={() => {
            setProjectOpen((was) => !was);
            setProjectQuery("");
          }}
          onClose={() => setProjectOpen(false)}
          label={
            <>
              <Icon name={ICON.folder} className="icon icon-sm" />
              <span>{project}</span>
              <Icon name={ICON.chevronDown} className="icon icon-sm" />
            </>
          }
        >
          <input
            autoFocus
            className="palette-input composer-project-search"
            placeholder={t("searchWorkspaces")}
            aria-label={t("workspaces")}
            value={projectQuery}
            onChange={(event) => setProjectQuery(event.target.value)}
          />
          <div className="composer-project-list">
            <button
              type="button"
              className={`option${cwd === "" ? " is-on" : ""}`}
              onClick={() => {
                onNew("");
                setProjectOpen(false);
              }}
            >
              <Icon name={ICON.chat} className="icon option-icon" />
              <span className="option-text">
                <span className="option-name">{t("chatWorkspace")}</span>
              </span>
              {cwd === "" ? <Icon name={ICON.check} className="icon icon-sm option-check" /> : null}
            </button>
            {visibleProjects.map((path) => (
              <button
                key={path}
                type="button"
                className={`option${cwd === path ? " is-on" : ""}`}
                onClick={() => {
                  onNew(path);
                  setProjectOpen(false);
                }}
              >
                <Icon name={ICON.folder} className="icon option-icon" />
                <span className="option-text">
                  <span className="option-name">{names[path] ?? path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path}</span>
                  <span className="option-path">{path}</span>
                </span>
                {cwd === path ? <Icon name={ICON.check} className="icon icon-sm option-check" /> : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="composer-project-add"
            onClick={() => {
              setProjectOpen(false);
              onPickProject();
            }}
          >
            <Icon name={ICON.plus} className="icon icon-sm" />
            {t("addProject")}
          </button>
        </Popover>
      </div>

      <div className="composer-card">
        <MaoTextArea
          className="composer-text"
          rows={3}
          aria-label={t("inputPlaceholder")}
          placeholder={t(inConversation ? "composerChatPlaceholder" : "composerIdeaPlaceholder")}
          value={text}
          disabled={running || blocked}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <SkillPicker cwd={cwd} disabled={blocked || info?.capabilities?.skill === undefined} onPick={reference} />
            <PermissionPicker
              value={permission}
              disabled={blocked || permissionDisabled}
              note={info?.capabilities?.permission === undefined ? t("permissionOff") : undefined}
              onChange={onPermission}
              label={
                <>
                  <Icon name={ICON.cpu} className="icon icon-sm" />
                  <span>Agent</span>
                  <Icon name={ICON.chevronDown} className="icon icon-sm" />
                </>
              }
            />
            <ThinkingPicker
              info={info}
              thinking={thinking}
              modelRoute={modelRoute}
              disabled={blocked}
              onOpenModels={onOpenModels}
              onThinking={onThinking}
              onModelRoute={onModelRoute}
            />
          </div>
          <div className="composer-actions">
            {context === null ? null : <ContextMeter context={context} running={running} onCompact={onCompact} />}
            {running ? (
              <MaoButton className="composer-send" aria-label={t("stop")} onClick={onCancel}>
                <Icon name={ICON.square} size={12} />
              </MaoButton>
            ) : (
              <MaoButton
                className="composer-send"
                color="primary"
                aria-label={t("send")}
                disabled={blocked || !hasModel || text.trim() === ""}
                onClick={submit}
              >
                <Icon name={ICON.arrowUp} size={16} />
              </MaoButton>
            )}
          </div>
        </div>
      </div>

      <div className="composer-meta">
        <span className="composer-mode">
          <Icon name={ICON.cpu} className="icon icon-sm" />
          <span>Agent</span>
        </span>
        <span className="composer-status-separator" aria-hidden="true" />
        <span className="composer-permission"><Icon name={permissionOption.icon} className="icon icon-sm" />{t(permissionOption.name)}</span>
        {!hasModel ? <span className="composer-warning">{t("modelsEmptyTitle")}</span> : null}
        <GitControls cwd={cwd} enabled={info?.capabilities?.git !== undefined} onOpenWorktree={onOpenWorktree} />
      </div>
    </div>
  );
}
