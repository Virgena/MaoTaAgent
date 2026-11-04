import { ICON, MaoButton, MaoIcon as Icon } from "maotaui";

import type { AppInfo, Approval, ContextView, ModelRoute, SessionMessage, SessionSummary } from "../lib/rpc.ts";
import { useT } from "../lib/i18n.ts";
import { Composer } from "./Composer.tsx";
import { RunStatus } from "./ExecutionTrace.tsx";
import { MessageList, type LiveTurn } from "./MessageList.tsx";

export function ChatView({
  info,
  kernelError,
  session,
  title,
  messages,
  pending,
  live,
  failure,
  projects,
  names,
  thinking,
  modelRoute,
  permission,
  approvals,
  context,
  onCompact,
  spawned,
  onRetry,
  onNew,
  onPickProject,
  onOpenModels,
  onOpenWorktree,
  onThinking,
  onModelRoute,
  onPermission,
  onAnswer,
  onSend,
  onCancel,
}: {
  info: AppInfo | null;
  kernelError: string | null;
  session: { id: string; cwd: string } | null;
  title: string;
  messages: SessionMessage[];
  pending: string | null;
  live: LiveTurn | null;
  failure: string | null;
  hasKey: boolean | null;
  projects: string[];
  names: Record<string, string>;
  thinking: string;
  modelRoute: ModelRoute | null;
  permission: string;
  approvals: Approval[];
  context: ContextView | null;
  onCompact: () => void;
  spawned: Record<string, SessionSummary[]>;
  onRetry: () => void;
  onNew: (cwd: string) => void;
  onPickProject: () => void;
  onOpenModels: () => void;
  onOpenWorktree: (path: string) => Promise<void>;
  onThinking: (level: string) => void;
  onModelRoute: (route: ModelRoute | null) => void;
  onPermission: (mode: string) => void;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const idle = messages.length === 0 && pending === null && live === null;
  const permissionDisabled = session === null || live?.running === true;

  const composer = (
    <Composer
      info={info}
      cwd={session?.cwd ?? ""}
      thinking={thinking}
      modelRoute={modelRoute}
      permission={permission}
      permissionDisabled={permissionDisabled}
      running={live?.running === true}
      blocked={kernelError !== null}
      context={context}
      inConversation={!idle}
      projects={projects}
      names={names}
      onNew={onNew}
      onPickProject={onPickProject}
      onOpenModels={onOpenModels}
      onOpenWorktree={onOpenWorktree}
      onThinking={onThinking}
      onModelRoute={onModelRoute}
      onPermission={onPermission}
      onCompact={onCompact}
      onSend={onSend}
      onCancel={onCancel}
    />
  );

  return (
    <main className="chat">
      {session === null ? null : (
        <header className="chat-head">
          <span className="chat-title">{title}</span>
          <RunStatus live={live} className="chat-run-status" />
        </header>
      )}

      {kernelError === null ? null : (
        <div className="banner banner-error">
          <Icon name={ICON.alert} className="icon icon-sm" />
          <span>{kernelError}</span>
          <MaoButton variant="ghost" size="sm" onClick={onRetry}>
            {t("retry")}
          </MaoButton>
        </div>
      )}

      {idle ? (
        <div className="chat-hello">
          <div className="hello-box">{composer}</div>
        </div>
      ) : (
        <>
          <MessageList
            messages={messages}
            pending={pending}
            live={live}
            approvals={approvals}
            spawned={spawned}
            cwd={session?.cwd ?? ""}
            onAnswer={onAnswer}
          />
          {failure === null ? null : (
            <div className="banner banner-error">
              <Icon name={ICON.alert} className="icon icon-sm" />
              <span>{failure}</span>
            </div>
          )}
          <RunStatus live={live} className="composer-run-status" />
          {composer}
        </>
      )}
    </main>
  );
}
