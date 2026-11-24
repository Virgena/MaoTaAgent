import { useRef, useState } from "react";

import { useT } from "../lib/i18n.ts";
import { maoValue, useMaoEvents } from "../lib/maoEvents.ts";
import type { AppInfo, ContextView } from "../lib/rpc.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { GitControls } from "./GitControls.tsx";
import { SkillPicker } from "./SkillPicker.tsx";

export function Composer({
  info,
  cwd,
  running,
  blocked,
  context,
  inConversation,
  onOpenWorktree,
  onCompact,
  onSend,
  onCancel,
}: {
  info: AppInfo | null;
  cwd: string;
  running: boolean;
  blocked: boolean;
  context: ContextView | null;
  inConversation: boolean;
  onOpenWorktree: (path: string) => Promise<void>;
  onCompact: () => void;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const hasModel = (info?.models?.models ?? []).some((model) =>
    model.enabled && (info?.models?.providers.find((item) => item.id === model.provider)?.enabled ?? true));
  const [text, setText] = useState("");
  const textRef = useRef<HTMLElement>(null);
  useMaoEvents(textRef, { "mt-input": (event) => setText(maoValue(event)) });

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
      <div className="composer-card">
        <mao-text-area
          ref={textRef}
          className="composer-text"
          rows={1}
          aria-label={t("inputPlaceholder")}
          placeholder={t(inConversation ? "composerChatPlaceholder" : "composerIdeaPlaceholder")}
          value={text}
          disabled={running || blocked}
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
          </div>
          <div className="composer-actions">
            <GitControls cwd={cwd} enabled={info?.capabilities?.git !== undefined} onOpenWorktree={onOpenWorktree} />
            {context === null ? null : <ContextMeter context={context} running={running} onCompact={onCompact} />}
            {running ? (
              <mao-button className="composer-send" aria-label={t("stop")} onClick={onCancel}>
                <mao-icon name="square" size={12} />
              </mao-button>
            ) : (
              <mao-button
                className="composer-send"
                color="primary"
                aria-label={t("send")}
                disabled={blocked || !hasModel || text.trim() === ""}
                onClick={submit}
              >
                <mao-icon name="arrow-up" size={16} />
              </mao-button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
