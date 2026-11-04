import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ICON, MaoButton, MaoIcon as Icon, MaoSelect, MaoTextField } from "maotaui";

import { describe } from "../lib/errors.ts";
import { useT } from "../lib/i18n.ts";
import { call, type GitStatusView, type GitWorktreeView } from "../lib/rpc.ts";
import { Popover } from "./Popover.tsx";

function shortHash(branch: string | null): string {
  return branch === null ? "HEAD" : branch;
}

function stamp(): string {
  const date = new Date();
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}`;
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return path;
  return index === 0 ? path.slice(0, 1) : path.slice(0, index);
}

function leafOf(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? "repository";
}

function separatorOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function WorktreeDialog({
  status,
  onClose,
  onCreated,
}: {
  status: GitStatusView;
  onClose: () => void;
  onCreated: (path: string) => Promise<void>;
}) {
  const t = useT();
  const root = status.root ?? "";
  const previous = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLFormElement | null>(null);
  const [base, setBase] = useState(status.detached ? "HEAD" : status.branch ?? "HEAD");
  const [branch, setBranch] = useState(`maota/${stamp()}`);
  const [path, setPath] = useState(
    `${parentOf(root)}${separatorOf(root)}${leafOf(root)}-maota-${crypto.randomUUID().slice(0, 4)}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("keydown", close);
      window.requestAnimationFrame(() => {
        if (previous.current !== null && previous.current.isConnected) previous.current.focus();
      });
    };
  }, [onClose]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call<GitWorktreeView>("git.create_worktree", {
        cwd: root,
        branch,
        path,
        base,
      });
      await onCreated(result.path);
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="worktree-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={dialog}
        className="worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-title"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const items = [...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ) ?? [])];
          if (items.length === 0) return;
          const first = items[0]!;
          const last = items[items.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="worktree-head">
          <div className="worktree-title" id="worktree-title">{t("newWorktreeTitle")}</div>
          <button type="button" className="side-icon" title={t("close")} aria-label={t("close")} onClick={onClose}>
            <Icon name={ICON.close} />
          </button>
        </div>
        <div className="worktree-note">{t("newWorktreeNote")}</div>
        <MaoSelect
          label={t("baseBranch")}
          value={base}
          options={[
            ...(status.detached ? [{ value: "HEAD", label: t("detachedHead") }] : []),
            ...status.branches.map((item) => ({ value: item, label: item })),
          ]}
          onChange={(event) => setBase(event.target.value)}
        />
        <MaoTextField
          autoFocus
          label={t("branchName")}
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
        />
        <MaoTextField
          label={t("worktreePath")}
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        {error === null ? null : <div className="worktree-error">{error}</div>}
        <div className="worktree-actions">
          <MaoButton size="sm" variant="flat" onClick={onClose}>{t("cancel")}</MaoButton>
          <MaoButton
            type="submit"
            size="sm"
            color="primary"
            loading={busy}
            disabled={branch.trim() === "" || path.trim() === "" || base === ""}
          >
            {t("createWorktree")}
          </MaoButton>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function GitControls({
  cwd,
  enabled,
  onOpenWorktree,
}: {
  cwd: string;
  enabled: boolean;
  onOpenWorktree: (path: string) => Promise<void>;
}) {
  const t = useT();
  const [status, setStatus] = useState<GitStatusView | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = async (): Promise<GitStatusView | null> => {
    if (!enabled || cwd === "") {
      setStatus(null);
      return null;
    }
    try {
      const next = await call<GitStatusView>("git.status", { cwd });
      setStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    }
  };

  useEffect(() => {
    setModeOpen(false);
    setBranchesOpen(false);
    setWorktreeOpen(false);
    setError(null);
    void refresh();
  }, [cwd, enabled]);

  if (status === null || !status.is_repo) return null;

  const branchName = status.branch ?? t("detachedHead");
  const refreshAndOpenBranches = async (): Promise<void> => {
    setModeOpen(false);
    setError(null);
    await refresh();
    setBranchesOpen(true);
  };

  const switchTo = async (branch: string): Promise<void> => {
    if (branch === status.branch || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await call<GitStatusView>("git.switch_branch", { cwd, branch });
      setStatus(next);
      setBranchesOpen(false);
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const copyBranch = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(status.branch ?? shortHash(status.branch));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
    }
  };

  return (
    <>
      <div className="composer-git">
        <Popover
          className="git-mode"
          title={t("branch")}
          align="end"
          open={modeOpen}
          onToggle={() => setModeOpen((was) => !was)}
          onClose={() => setModeOpen(false)}
          label={<><Icon name={ICON.gitBranch} className="icon icon-sm" /><span>{t("branch")}</span></>}
        >
          <button
            type="button"
            className="git-mode-row"
            onClick={() => void refreshAndOpenBranches()}
          >
            <Icon name={ICON.folder} className="icon" />
            <span className="git-mode-copy">
              <span className="git-mode-title">{t("branch")}</span>
              <span className="git-mode-note">{t("branchDescription")}</span>
            </span>
          </button>
          <button
            type="button"
            className="git-mode-row"
            onClick={() => {
              setModeOpen(false);
              setError(null);
              setWorktreeOpen(true);
            }}
          >
            <Icon name={ICON.gitWorktree} className="icon" />
            <span className="git-mode-copy">
              <span className="git-mode-title">{t("newWorktree")}</span>
              <span className="git-mode-note">{t("worktreeDescription")}</span>
            </span>
          </button>
        </Popover>
        <span className="composer-status-separator" aria-hidden="true" />
        <Popover
          className="git-current"
          title={t("currentBranch")}
          align="end"
          open={branchesOpen}
          onToggle={() => {
            if (branchesOpen) setBranchesOpen(false);
            else void refreshAndOpenBranches();
          }}
          onClose={() => setBranchesOpen(false)}
          label={<><Icon name={ICON.gitBranch} className="icon icon-sm" /><span>{branchName}</span></>}
        >
          <div className="git-branch-list">
            {status.branches.map((branch) => (
              <div key={branch} className={`git-branch-row${branch === status.branch ? " is-on" : ""}`}>
                <button type="button" className="git-branch-pick" disabled={busy} onClick={() => void switchTo(branch)}>
                  <Icon name={ICON.gitBranch} className="icon icon-sm" />
                  <span>{branch}</span>
                  {branch === status.branch ? <Icon name={ICON.check} className="icon icon-sm option-check" /> : null}
                </button>
                {branch === status.branch ? (
                  <button
                    type="button"
                    className="git-branch-copy"
                    title={t("copyBranch")}
                    aria-label={t("copyBranch")}
                    onClick={() => void copyBranch()}
                  >
                    <Icon name={copied ? ICON.check : ICON.copy} className="icon icon-sm" />
                  </button>
                ) : null}
              </div>
            ))}
            {status.branches.length === 0 ? <div className="git-empty">{t("noBranches")}</div> : null}
          </div>
          {error === null ? null : <div className="git-error">{error}</div>}
        </Popover>
      </div>
      {worktreeOpen ? (
        <WorktreeDialog status={status} onClose={() => setWorktreeOpen(false)} onCreated={onOpenWorktree} />
      ) : null}
    </>
  );
}
