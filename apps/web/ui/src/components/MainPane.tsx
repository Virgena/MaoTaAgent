/// The main pane: the chat, tasks and plugins views, with the search overlay
/// that drops over them. It turns the session list into the chat header's title
/// and the rows the palette searches, then hands everything to the views.

import { useT } from "../lib/i18n.ts";
import type { AppInfo, Approval, ContextView, ModelRoute, SessionMessage, SessionSummary } from "../lib/rpc.ts";
import type { HostStatus } from "../lib/rpc.ts";
import { ChatView } from "./ChatView.tsx";
import { HostStatusStrip } from "./HostStatusStrip.tsx";
import type { LiveTurn } from "./MessageList.tsx";
import { PluginsView } from "./PluginsView.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { TasksView } from "./TasksView.tsx";

export function MainPane({
  page,
  info,
  kernelError,
  hostStatus,
  project,
  projects,
  sessions,
  archived,
  names,
  active,
  lives,
  messages,
  pending,
  failure,
  thinking,
  modelRoute,
  permission,
  approvals,
  context,
  onCompact,
  spawned,
  palette,
  onPalette,
  onNew,
  onPickProject,
  onOpen,
  onRetry,
  onOpenModels,
  onOpenWorktree,
  onThinking,
  onModelRoute,
  onPermission,
  onAnswer,
  onSend,
  onCancel,
}: {
  page: "chat" | "plugins" | "tasks";
  info: AppInfo | null;
  kernelError: string | null;
  hostStatus: HostStatus | null;
  project: string;
  projects: string[];
  sessions: SessionSummary[];
  archived: string[];
  names: Record<string, string>;
  active: { id: string; cwd: string } | null;
  lives: Record<string, LiveTurn>;
  messages: SessionMessage[];
  pending: string | null;
  failure: { session: string; text: string } | null;
  thinking: string;
  modelRoute: ModelRoute | null;
  permission: string;
  approvals: Approval[];
  context: ContextView | null;
  onCompact: () => void;
  spawned: Record<string, SessionSummary[]>;
  palette: boolean;
  onPalette: (open: boolean) => void;
  onNew: (cwd: string) => void;
  onPickProject: () => void;
  onOpen: (session: SessionSummary) => void;
  onRetry: () => void;
  onOpenModels: () => void;
  onOpenWorktree: (path: string) => Promise<void>;
  onThinking: (value: string) => void;
  onModelRoute: (route: ModelRoute | null) => void;
  onPermission: (mode: string) => void;
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
          projects={projects}
          names={names}
          thinking={thinking}
          modelRoute={modelRoute}
          permission={permission}
          approvals={approvals}
          context={context}
          onCompact={onCompact}
          spawned={spawned}
          onRetry={onRetry}
          onNew={onNew}
          onPickProject={onPickProject}
          onOpenModels={onOpenModels}
          onOpenWorktree={onOpenWorktree}
          onThinking={onThinking}
          onModelRoute={onModelRoute}
          onPermission={onPermission}
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
