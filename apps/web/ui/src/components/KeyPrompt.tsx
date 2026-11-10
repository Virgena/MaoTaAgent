import { useRef, useState } from "react";

import { describe } from "../lib/errors.ts";
import { useT } from "../lib/i18n.ts";
import { maoValue, useMaoEvents } from "../lib/maoEvents.ts";
import { call } from "../lib/rpc.ts";

export function KeyPrompt({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fieldRef = useRef<HTMLElement>(null);
  useMaoEvents(fieldRef, { "mt-input": (event) => setValue(maoValue(event)) });

  const save = async (): Promise<void> => {
    if (busy || value.trim() === "") return;
    setBusy(true);
    setFailure(null);
    try {
      await call("settings.set_key", { api_key: value.trim() });
      setValue("");
      onSaved();
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="key-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <mao-text-field
        ref={fieldRef}
        type="password"
        value={value}
        placeholder="sk-…"
        autocomplete="off"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
        }}
      />
      <mao-button size="sm" disabled={busy || value.trim() === ""} onClick={() => void save()}>
        {busy ? t("saving") : t("save")}
      </mao-button>
      {failure === null ? null : <span className="key-failure">{failure}</span>}
    </form>
  );
}
