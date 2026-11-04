import { useEffect, useState } from "react";
import { ICON, MaoIcon as Icon } from "maotaui";

import { useT } from "../lib/i18n.ts";
import { call, type SkillSummary } from "../lib/rpc.ts";
import { Popover } from "./Popover.tsx";

/// The menu inserts a reference, not the instructions: the model still loads
/// the skill itself, so what the composer holds stays a sentence a person can
/// read and edit. Only a skill open to both sides is offered, because naming
/// one the model may not load would be a dead end.
export function SkillPicker({
  cwd,
  disabled,
  onPick,
}: {
  cwd: string;
  disabled: boolean;
  onPick: (name: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [query, setQuery] = useState("");

  /// The list is read when the menu opens, so a skill added to the tree shows
  /// up on the next look without anything watching the directory.
  useEffect(() => {
    if (!open) return;
    let live = true;
    call<{ skills?: SkillSummary[] }>("skills.list", { cwd })
      .then((reply) => {
        if (live) setSkills(reply.skills ?? []);
      })
      .catch(() => {
        if (live) setSkills([]);
      });
    return () => {
      live = false;
    };
  }, [open, cwd]);

  const usable = skills.filter((skill) => skill.invocation.userInvocable && skill.invocation.modelInvocable);
  const needle = query.trim().toLowerCase();
  const hits = usable.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle));

  return (
    <Popover
      className="skills"
      title={t("add")}
      open={open}
      disabled={disabled}
      onToggle={() => {
        setOpen((was) => !was);
        setQuery("");
      }}
      onClose={() => setOpen(false)}
      label={<Icon name={ICON.plus} className="icon icon-sm" />}
    >
      <div className="popover-head">
        <span>{t("skillInsert")}</span>
      </div>
      <input
        autoFocus
        className="palette-input skill-search"
        placeholder={t("skillSearch")}
        aria-label={t("skillSearch")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="skill-list">
        {hits.length === 0 ? <div className="palette-empty">{t("noSkills")}</div> : null}
        {hits.map((skill) => (
          <button
            key={skill.name}
            type="button"
            className="option"
            onClick={() => {
              onPick(skill.name);
              setOpen(false);
              setQuery("");
            }}
          >
            <span className="option-text">
              <span className="option-name">{skill.name}</span>
              <span className="option-note">{skill.description}</span>
            </span>
          </button>
        ))}
      </div>
    </Popover>
  );
}
