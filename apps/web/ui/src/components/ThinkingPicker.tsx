import { useEffect, useState } from "react";
import {
  ICON,
  MaoButton,
  MaoIcon as Icon,
  MaoSegmented,
  MaoSelect,
} from "maotaui";

import { useT, type MessageKey } from "../lib/i18n.ts";
import type { AppInfo, ModelRoute } from "../lib/rpc.ts";
import { Popover } from "./Popover.tsx";

const LEVEL_KEY: Record<string, MessageKey> = {
  off: "thinkingOff",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
};

function tokenText(value: number | undefined): string {
  if (value === undefined) return "";
  return value < 1000 ? `${value}` : `${Math.round(value / 1000)}K`;
}

export function ThinkingPicker({
  info,
  thinking,
  modelRoute,
  disabled,
  onOpenModels,
  onThinking,
  onModelRoute,
}: {
  info: AppInfo | null;
  thinking: string;
  modelRoute: ModelRoute | null;
  disabled?: boolean;
  onOpenModels: () => void;
  onThinking: (level: string) => void;
  onModelRoute: (route: ModelRoute | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"models" | "detail">("models");
  const [providerId, setProviderId] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const levels = info?.levels?.length ? info.levels : ["off", "low", "medium", "high"];
  const providers = (info?.models?.providers ?? []).filter((provider) => provider.enabled);
  const models = (info?.models?.models ?? []).filter((model) =>
    model.enabled && (providers.find((item) => item.id === model.provider)?.enabled ?? true));
  const route = modelRoute ?? info?.models?.default_route ?? null;
  const selected = route === null
    ? null
    : models.find((model) => model.provider === route.provider && model.model === route.model) ?? null;
  const provider = route === null ? null : providers.find((item) => item.id === route.provider) ?? providers[0] ?? null;
  const modelName = selected?.name ?? provider?.name ?? t("model");
  const capacity = tokenText(selected?.context_tokens);
  const reasoningLevels = selected === null
    ? levels
    : ["off", ...levels.filter((level) => level !== "off" && selected.reasoning_efforts.includes(level))];
  const showReasoning = reasoningLevels.length > 1;
  const levelName = (level: string): string => {
    const key = LEVEL_KEY[level];
    return key === undefined ? level : t(key);
  };
  const needle = query.trim().toLowerCase();
  const shownModels = models.filter((model) =>
    (providerId === "" || model.provider === providerId) &&
    `${model.name} ${model.model}`.toLowerCase().includes(needle));
  const close = (): void => {
    setView("models");
    setSearchOpen(false);
    setQuery("");
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    setProviderId(route?.provider ?? providers[0]?.id ?? "");
  }, [open]);

  return (
    <Popover
      align="end"
      className="thinking model-reason-picker"
      title={t("model")}
      open={open}
      disabled={disabled}
      onToggle={() => {
        if (open) close();
        else {
          setView("models");
          setProviderId(route?.provider ?? providers[0]?.id ?? "");
          setOpen(true);
        }
      }}
      onClose={close}
      label={
        <>
          <Icon name={ICON.cpu} className="icon icon-sm" />
          <span className="model-reason-trigger-name">{modelName}</span>
          {showReasoning ? (
            <>
              <span className="model-reason-separator" aria-hidden="true">·</span>
              <span className="model-reason-trigger-level">{levelName(thinking)}</span>
            </>
          ) : null}
          {capacity === "" ? null : (
            <>
              <span className="model-reason-separator" aria-hidden="true">·</span>
              <span className="model-reason-trigger-capacity">{capacity}</span>
            </>
          )}
          <Icon name={ICON.chevronDown} className="icon icon-sm" />
        </>
      }
    >
      {view === "models" ? (
        <>
          <div className="model-menu-head">
            <MaoSelect
              aria-label={t("modelProvider")}
              className="model-provider-select"
              value={providerId}
              options={providers.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(event) => setProviderId(event.target.value)}
            />
            <MaoButton
              className="mt-btn-icon"
              variant="flat"
              size="sm"
              title={t("models")}
              aria-label={t("models")}
              onClick={() => {
                close();
                onOpenModels();
              }}
            >
              <Icon name={ICON.plus} className="icon icon-sm" />
            </MaoButton>
            <MaoButton
              className="mt-btn-icon"
              variant="flat"
              size="sm"
              title={t("searchModels")}
              aria-label={t("searchModels")}
              onClick={() => setSearchOpen((was) => !was)}
            >
              <Icon name={ICON.search} className="icon icon-sm" />
            </MaoButton>
          </div>
          {searchOpen ? (
            <input
              autoFocus
              className="palette-input model-menu-search"
              placeholder={t("searchModels")}
              aria-label={t("searchModels")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <div className="model-menu-list">
            {shownModels.length === 0 ? <div className="model-reason-empty">{t("noModels")}</div> : null}
            {shownModels.map((model) => {
              const current = route?.provider === model.provider && route.model === model.model;
              const meta = [
                showReasoning ? levelName(thinking) : "",
                tokenText(model.context_tokens),
              ].filter(Boolean).join(" · ");
              return (
                <button
                  key={model.provider + "/" + model.model}
                  type="button"
                  className={`model-menu-row${current ? " is-on" : ""}`}
                  onClick={() => {
                    onModelRoute({ provider: model.provider, model: model.model });
                    close();
                  }}
                >
                  <span className="model-menu-check">
                    {current ? <Icon name={ICON.check} className="icon icon-sm" /> : null}
                  </span>
                  <span className="model-menu-name">{model.name}</span>
                  {meta === "" ? null : <span className="model-menu-meta">{meta}</span>}
                  <Icon name={ICON.chevronRight} className="icon icon-sm" />
                </button>
              );
            })}
          </div>
          <button type="button" className="model-menu-footer" onClick={() => setView("detail")}>
            <span className="model-menu-chip"><Icon name={ICON.cpu} className="icon icon-sm" />{modelName}</span>
            <span className="model-menu-chip">
              {showReasoning ? `${levelName(thinking)} · ` : ""}{capacity === "" ? t("model") : capacity}
            </span>
          </button>
        </>
      ) : (
        <>
          <button type="button" className="model-detail-back" onClick={() => setView("models")}>
            <Icon name={ICON.back} className="icon icon-sm" />
            <span>{modelName}</span>
          </button>
          <div className="model-detail-label">{t("reasoningLevel")}</div>
          <MaoSegmented
            label={t("reasoningLevel")}
            className="model-reasoning-segments"
            options={reasoningLevels.map((level) => ({ value: level, label: levelName(level) }))}
            value={thinking}
            onChange={onThinking}
          />
          <div className="model-context-row">
            <span>{t("maxContext")}</span>
            <span>{capacity === "" ? "—" : capacity}</span>
          </div>
          <button type="button" className="model-menu-footer" onClick={() => setView("models")}>
            <span className="model-menu-chip"><Icon name={ICON.cpu} className="icon icon-sm" />{modelName}</span>
            <span className="model-menu-chip">
              {showReasoning ? levelName(thinking) : ""}{capacity === "" ? "" : ` · ${capacity}`}
            </span>
          </button>
        </>
      )}
    </Popover>
  );
}
