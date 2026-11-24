import type { AppInfo, Approval, ContextView, SessionMessage, SessionSummary } from "../lib/rpc.ts";
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
  approvals,
  context,
  onCompact,
  spawned,
  onRetry,
  onOpenWorktree,
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
  approvals: Approval[];
  context: ContextView | null;
  onCompact: () => void;
  spawned: Record<string, SessionSummary[]>;
  onRetry: () => void;
  onOpenWorktree: (path: string) => Promise<void>;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const idle = messages.length === 0 && pending === null && live === null;

  const composer = (
    <Composer
      info={info}
      cwd={session?.cwd ?? ""}
      running={live?.running === true}
      blocked={kernelError !== null}
      context={context}
      inConversation={!idle}
      onOpenWorktree={onOpenWorktree}
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
          <mao-icon name="triangle-alert" size={14} />
          <span>{kernelError}</span>
          <mao-button variant="bordered" size="sm" onClick={onRetry}>
            {t("retry")}
          </mao-button>
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
              <mao-icon name="triangle-alert" size={14} />
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
