/// The main pane: the chat, tasks and plugins views, with the search overlay
/// that drops over them. It turns the session list into the chat header's title
/// and the rows the palette searches, then hands everything to the views.

import { useT } from "../lib/i18n.ts";
import type { AppInfo, Approval, ContextView, SessionMessage, SessionSummary } from "../lib/rpc.ts";
import type { HostStatus } from "../lib/rpc.ts";
import { ChatView } from "./ChatView.tsx";
import { HostStatusStrip } from "./HostStatusStrip.tsx";
import type { LiveTurn } from "./MessageList.tsx";
import { PluginsView } from "./PluginsView.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { TaskBrowser } from "./TaskBrowser.tsx";
import { TasksView } from "./TasksView.tsx";

export function MainPane({
  page,
  info,
  kernelError,
  hostStatus,
  project,
  sessions,
  pinned,
  archived,
  names,
  active,
  lives,
  messages,
  pending,
  failure,
  approvals,
  context,
  onCompact,
  spawned,
  palette,
  onPalette,
  onNew,
  onPickProject,
  onOpen,
  onPin,
  onArchive,
  onPinMany,
  onArchiveMany,
  onRetry,
  onOpenWorktree,
  onAnswer,
  onSend,
  onCancel,
}: {
  page: "chat" | "plugins" | "tasks" | "scheduled";
  info: AppInfo | null;
  kernelError: string | null;
  hostStatus: HostStatus | null;
  project: string;
  sessions: SessionSummary[];
  pinned: string[];
  archived: string[];
  names: Record<string, string>;
  active: { id: string; cwd: string } | null;
  lives: Record<string, LiveTurn>;
  messages: SessionMessage[];
  pending: string | null;
  failure: { session: string; text: string } | null;
  approvals: Approval[];
  context: ContextView | null;
  onCompact: () => void;
  spawned: Record<string, SessionSummary[]>;
  palette: boolean;
  onPalette: (open: boolean) => void;
  onNew: (cwd: string) => void;
  onPickProject: () => void;
  onOpen: (session: SessionSummary) => void;
  onPin: (id: string) => void;
  onArchive: (id: string) => void;
  onPinMany: (ids: string[], pinned: boolean) => void;
  onArchiveMany: (ids: string[], archived: boolean) => void;
  onRetry: () => void;
  onOpenWorktree: (path: string) => Promise<void>;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const title = sessions.find((item) => item.id === active?.id)?.title || t("newChat");
  const searchable = sessions.filter((session) => !archived.includes(session.id));

  return (
    <>
      <HostStatusStrip status={hostStatus} />
      {page === "tasks" ? (
        <TaskBrowser
          sessions={sessions}
          names={names}
          running={Object.keys(lives)}
          pinned={pinned}
          archived={archived}
          activeId={active?.id ?? null}
          onOpen={onOpen}
          onNew={() => onNew(project)}
          onPin={onPin}
          onArchive={onArchive}
          onPinMany={onPinMany}
          onArchiveMany={onArchiveMany}
        />
      ) : page === "scheduled" ? (
        <TasksView session={active} />
      ) : page === "plugins" ? (
        <PluginsView info={info} />
      ) : (
        <ChatView
          info={info}
          kernelError={kernelError}
          session={active}
          title={title}
          messages={messages}
          pending={pending}
          live={active === null ? null : (lives[active.id] ?? null)}
          failure={failure !== null && active !== null && failure.session === active.id ? failure.text : null}
          hasKey={info?.has_key ?? null}
          approvals={approvals}
          context={context}
          onCompact={onCompact}
          spawned={spawned}
          onRetry={onRetry}
          onOpenWorktree={onOpenWorktree}
          onAnswer={onAnswer}
          onSend={onSend}
          onCancel={onCancel}
        />
      )}
      {palette ? (
        <SearchPalette
          sessions={searchable}
          names={names}
          onNew={() => {
            onPalette(false);
            onNew(project);
          }}
          onAddProject={() => {
            onPalette(false);
            onPickProject();
          }}
          onPick={(session) => {
            onPalette(false);
            onOpen(session);
          }}
          onClose={() => onPalette(false)}
        />
      ) : null}
    </>
  );
}
