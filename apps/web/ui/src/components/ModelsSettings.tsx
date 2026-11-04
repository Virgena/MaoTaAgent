import { useEffect, useRef, useState } from "react";

import { ICON, MaoButton, MaoIcon as Icon, MaoSelect, MaoTextField } from "maotaui";

import { useT } from "../lib/i18n.ts";
import { call, type AdapterView, type ModelCatalogView, type ModelProviderView, type ModelView } from "../lib/rpc.ts";
import { describe } from "../lib/errors.ts";
import { Popover } from "./Popover.tsx";

interface ProviderDraft {
  id: string;
  name: string;
  adapter: string;
  base_url: string;
  api_key: string;
  auth_kind: "file" | "env";
  env_name: string;
  enabled: boolean;
  verified: boolean;
}

interface ModelDraft {
  provider: string;
  model: string;
  name: string;
  context_tokens: string;
  max_output_tokens: string;
  tools: boolean;
  vision: boolean;
  reasoning_efforts: string;
  enabled: boolean;
  verified: boolean;
}

type Editor = { kind: "provider"; draft: ProviderDraft } | { kind: "model"; draft: ModelDraft } | null;

function providerDraft(provider?: ModelProviderView, adapters: AdapterView[] = []): ProviderDraft {
  return provider === undefined
    ? { id: "", name: "", adapter: adapters[0]?.id ?? "", base_url: "", api_key: "", auth_kind: "file", env_name: "", enabled: true, verified: false }
    : {
        id: provider.id,
        name: provider.name,
        adapter: provider.adapter,
        base_url: provider.base_url,
        api_key: "",
        auth_kind: provider.auth.kind,
        env_name: provider.auth.kind === "env" ? provider.auth.name : "",
        enabled: provider.enabled,
        verified: provider.verified,
      };
}

function modelDraft(provider: string, model?: ModelView): ModelDraft {
  return model === undefined
    ? { provider, model: "", name: "", context_tokens: "", max_output_tokens: "", tools: true, vision: false, reasoning_efforts: "", enabled: true, verified: false }
    : {
        provider: model.provider,
        model: model.model,
        name: model.name,
        context_tokens: model.context_tokens === undefined ? "" : String(model.context_tokens),
        max_output_tokens: model.max_output_tokens === undefined ? "" : String(model.max_output_tokens),
        tools: model.capabilities.tools,
        vision: model.capabilities.vision,
        reasoning_efforts: model.reasoning_efforts.join(", "),
        enabled: model.enabled,
        verified: model.verified,
      };
}

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function tokenText(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 1000 ? `${value} tokens` : `${Math.round(value / 1000)}K tokens`;
}

export function ModelsSettings({
  catalog,
  onChanged,
  onEditingChange,
}: {
  catalog: ModelCatalogView | null;
  onChanged: (catalog: ModelCatalogView) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const t = useT();
  const editorDialog = useRef<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<{ id: string; name?: string }[]>([]);
  const [pickedModel, setPickedModel] = useState<{ id: string; name?: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const adapters = catalog?.adapters ?? [];
  const configurableProviders = catalog?.providers ?? [];
  const editorOpen = editor !== null;

  useEffect(() => {
    if (!editorOpen) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setEditor(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [editorOpen]);

  useEffect(() => {
    onEditingChange?.(editorOpen);
  }, [editorOpen, onEditingChange]);

  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);

  useEffect(() => {
    if (!editorOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      editorDialog.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => {
        if (previous !== null && previous.isConnected) previous.focus();
      });
    };
  }, [editorOpen]);

  const run = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (failure) {
      setError(describe(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const openNewProvider = (): void => setEditor({ kind: "provider", draft: providerDraft(undefined, adapters) });
  const openNewModel = (provider = configurableProviders[0]?.id ?? ""): void => setEditor({ kind: "model", draft: modelDraft(provider) });

  const discover = async (): Promise<void> => {
    if (editor?.kind !== "provider") return;
    const draft = editor.draft;
    const reply = await run(() => call<{ models?: { id: string; name?: string }[] }>("models.discover", {
      adapter: draft.adapter,
      base_url: draft.base_url,
      ...(draft.api_key === "" ? {} : { api_key: draft.api_key }),
    }));
    if (reply === undefined) return;
    setDiscovered(reply.models ?? []);
    setEditor({ kind: "provider", draft: { ...draft, verified: true } });
  };

  const saveProvider = async (): Promise<void> => {
    if (editor?.kind !== "provider") return;
    const draft = editor.draft;
    const next = await run(() => call<ModelCatalogView>("models.save_provider", {
      ...(draft.id === "" ? {} : { id: draft.id }),
      name: draft.name,
      adapter: draft.adapter,
      base_url: draft.base_url,
      auth: draft.auth_kind === "env" ? { kind: "env", name: draft.env_name } : { kind: "file" },
      ...(draft.api_key === "" ? {} : { api_key: draft.api_key }),
      enabled: draft.enabled,
      verified: draft.verified,
      expected_revision: catalog?.revision,
    }));
    if (next === undefined) return;
    onChanged({ ...next, adapters: catalog?.adapters ?? [] });
    const saved = next.providers.find((provider) => provider.name === draft.name && provider.base_url === draft.base_url.replace(/\/+$/, ""));
    setEditor(saved === undefined ? null : {
      kind: "model",
      draft: {
        ...modelDraft(saved.id),
        ...(pickedModel === null ? {} : { model: pickedModel.id, name: pickedModel.name ?? pickedModel.id, verified: true }),
      },
    });
    setPickedModel(null);
  };

  const toggleProvider = async (provider: ModelProviderView): Promise<void> => {
    const enabled = !provider.enabled;
    if (catalog !== null) onChanged({ ...catalog, providers: catalog.providers.map((item) => item.id === provider.id ? { ...item, enabled } : item) });
    const next = await run(() => call<ModelCatalogView>("models.save_provider", {
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      base_url: provider.base_url,
      auth: provider.auth,
      enabled,
      verified: provider.verified,
      expected_revision: catalog?.revision,
    }));
    if (next === undefined) {
      if (catalog !== null) onChanged(catalog);
      return;
    }
    onChanged({
      ...next,
      providers: next.providers.map((item) => item.id === provider.id ? { ...item, enabled } : item),
      adapters: catalog?.adapters ?? [],
    });
  };

  const toggleModel = async (model: ModelView): Promise<void> => {
    const enabled = !model.enabled;
    if (catalog !== null) onChanged({ ...catalog, models: catalog.models.map((item) => item.provider === model.provider && item.model === model.model ? { ...item, enabled } : item) });
    const next = await run(() => call<ModelCatalogView>("models.save_model", {
      provider: model.provider,
      model: model.model,
      name: model.name,
      ...(model.context_tokens === undefined ? {} : { context_tokens: model.context_tokens }),
      ...(model.max_output_tokens === undefined ? {} : { max_output_tokens: model.max_output_tokens }),
      capabilities: model.capabilities,
      reasoning_efforts: model.reasoning_efforts,
      enabled,
      verified: model.verified,
      expected_revision: catalog?.revision,
    }));
    if (next === undefined) {
      if (catalog !== null) onChanged(catalog);
      return;
    }
    onChanged({
      ...next,
      models: next.models.map((item) => item.provider === model.provider && item.model === model.model ? { ...item, enabled } : item),
      adapters: catalog?.adapters ?? [],
    });
  };

  const saveModel = async (): Promise<void> => {
    if (editor?.kind !== "model") return;
    const draft = editor.draft;
    const next = await run(() => call<ModelCatalogView>("models.save_model", {
      provider: draft.provider,
      model: draft.model,
      name: draft.name === "" ? draft.model : draft.name,
      ...(numberOrUndefined(draft.context_tokens) === undefined ? {} : { context_tokens: numberOrUndefined(draft.context_tokens) }),
      ...(numberOrUndefined(draft.max_output_tokens) === undefined ? {} : { max_output_tokens: numberOrUndefined(draft.max_output_tokens) }),
      capabilities: { tools: draft.tools, vision: draft.vision },
      reasoning_efforts: draft.reasoning_efforts.split(",").map((item) => item.trim()).filter(Boolean),
      enabled: draft.enabled,
      verified: draft.verified,
      expected_revision: catalog?.revision,
    }));
    if (next === undefined) return;
    onChanged({ ...next, adapters: catalog?.adapters ?? [] });
    setEditor(null);
  };

  const removeModel = async (model: ModelView): Promise<void> => {
    const next = await run(() => call<ModelCatalogView>("models.delete_model", {
      provider: model.provider,
      model: model.model,
      expected_revision: catalog?.revision,
    }));
    if (next !== undefined) onChanged({ ...next, adapters: catalog?.adapters ?? [] });
  };

  const removeProvider = async (provider: ModelProviderView): Promise<void> => {
    const next = await run(() => call<ModelCatalogView>("models.delete_provider", {
      id: provider.id,
      expected_revision: catalog?.revision,
    }));
    if (next !== undefined) onChanged({ ...next, adapters: catalog?.adapters ?? [] });
  };

  const needle = query.trim().toLowerCase();
  const modelsFor = (provider: ModelProviderView): ModelView[] =>
    (catalog?.models ?? []).filter((model) => model.provider === provider.id);
  const visibleProviders = configurableProviders.filter((provider) => {
    if (needle === "") return true;
    const models = modelsFor(provider);
    return `${provider.name} ${provider.adapter} ${provider.base_url} ${models.map((model) => `${model.name} ${model.model}`).join(" ")}`.toLowerCase().includes(needle);
  });
  return (
    <div className={`models-settings${editor === null ? "" : " is-editing"}`}>
      {editor === null ? null : (
        <div className="model-editor-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }}>
          <div ref={editorDialog} className="model-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="model-editor-title">
            {editor.kind === "provider" ? (
              <form className="model-editor" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
                <div className="model-editor-title" id="model-editor-title">{editor.draft.id === "" ? t("addProvider") : t("editProvider")}</div>
          <div className="model-form-grid">
            <MaoSelect label={t("adapter")} value={editor.draft.adapter} options={adapters.map((adapter) => ({ value: adapter.id, label: adapter.name }))} onChange={(event) => setEditor({ kind: "provider", draft: { ...editor.draft, adapter: event.target.value } })} />
            <MaoTextField label={t("providerName")} value={editor.draft.name} onChange={(event) => setEditor({ kind: "provider", draft: { ...editor.draft, name: event.target.value } })} />
            <MaoTextField label={t("baseUrl")} value={editor.draft.base_url} onChange={(event) => setEditor({ kind: "provider", draft: { ...editor.draft, base_url: event.target.value } })} />
            <MaoSelect label={t("keySource")} value={editor.draft.auth_kind} options={[{ value: "file", label: t("keySourceFile") }, { value: "env", label: t("keySourceEnv") }]} onChange={(event) => setEditor({ kind: "provider", draft: { ...editor.draft, auth_kind: event.target.value as "file" | "env" } })} />
            {editor.draft.auth_kind === "env" ? (
              <MaoTextField label={t("keyEnv")} value={editor.draft.env_name} onChange={(event) => setEditor({ kind: "provider", draft: { ...editor.draft, env_name: event.target.value } })} />
            ) : (
              <MaoTextField label={t("apiKey")} type="password" autoComplete="new-password" value={editor.draft.api_key} onChange={(event) => setEditor({ kind: "provider", draft: { ...editor.draft, api_key: event.target.value } })} />
            )}
          </div>
          {discovered.length === 0 ? null : (
            <div className="model-discovered">
              <span className="model-discovered-title">{t("discoveredModels")}</span>
              <div className="model-discovered-list">
                {discovered.map((model) => (
                  <MaoButton key={model.id} size="sm" variant="bordered" color={pickedModel?.id === model.id ? "primary" : "neutral"} onClick={() => setPickedModel(model)}>
                    {pickedModel?.id === model.id ? <Icon name={ICON.check} className="icon icon-sm" /> : null}
                    {model.name ?? model.id}
                  </MaoButton>
                ))}
              </div>
            </div>
          )}
          <div className="model-editor-actions">
            <MaoButton size="sm" variant="bordered" loading={busy} onClick={() => void discover()}>{t("discoverModels")}</MaoButton>
            <div className="model-editor-actions-right">
              <MaoButton size="sm" variant="flat" onClick={() => setEditor(null)}>{t("cancel")}</MaoButton>
              <MaoButton type="submit" size="sm" color="primary" disabled={busy || editor.draft.name === "" || editor.draft.base_url === ""}>{t("save")}</MaoButton>
            </div>
          </div>
        </form>
      ) : (
        <form className="model-editor" onSubmit={(event) => { event.preventDefault(); void saveModel(); }}>
          <div className="model-editor-title" id="model-editor-title">{editor.draft.model === "" ? t("addModel") : t("editModel")}</div>
          <div className="model-form-grid">
            <MaoSelect label={t("modelProvider")} value={editor.draft.provider} options={configurableProviders.map((provider) => ({ value: provider.id, label: provider.name }))} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, provider: event.target.value } })} />
            <MaoTextField label={t("modelId")} value={editor.draft.model} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, model: event.target.value } })} />
            <MaoTextField label={t("modelName")} value={editor.draft.name} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, name: event.target.value } })} />
            <MaoTextField label={t("contextTokens")} inputMode="numeric" value={editor.draft.context_tokens} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, context_tokens: event.target.value } })} />
            <MaoTextField label={t("maxOutputTokens")} inputMode="numeric" value={editor.draft.max_output_tokens} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, max_output_tokens: event.target.value } })} />
            <MaoTextField label={t("reasoningEfforts")} placeholder="low, medium, high" value={editor.draft.reasoning_efforts} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, reasoning_efforts: event.target.value } })} />
          </div>
          <div className="model-checks">
            <label><input type="checkbox" checked={editor.draft.tools} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, tools: event.target.checked } })} />{t("tools")}</label>
            <label><input type="checkbox" checked={editor.draft.vision} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, vision: event.target.checked } })} />{t("vision")}</label>
          </div>
          <div className="model-editor-actions">
            <div className="model-editor-actions-right">
              <MaoButton size="sm" variant="flat" onClick={() => setEditor(null)}>{t("cancel")}</MaoButton>
              <MaoButton type="submit" size="sm" color="primary" disabled={busy || editor.draft.provider === "" || editor.draft.model === ""}>{t("save")}</MaoButton>
            </div>
          </div>
        </form>
      )}
          </div>
        </div>
      )}

      <div className="models-toolbar">
        <label className="models-search">
          <Icon name={ICON.search} className="icon icon-sm" />
          <input value={query} placeholder={t("searchModels")} aria-label={t("searchModels")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="models-toolbar-actions">
          <MaoButton size="sm" variant="bordered" onClick={openNewProvider}>{t("addProvider")}</MaoButton>
          <MaoButton size="sm" variant="bordered" disabled={configurableProviders.length === 0} onClick={() => openNewModel()}>{t("addModel")}</MaoButton>
        </div>
      </div>

      {error === null ? null : <div className="model-error">{error}</div>}
      {configurableProviders.length === 0 ? (
        <div className="models-empty">
          <div className="models-empty-mark"><Icon name={ICON.cpu} size={20} /></div>
          <div className="models-empty-title">{t("modelsEmptyTitle")}</div>
          <MaoButton size="sm" color="primary" onClick={openNewProvider}>{t("addProvider")}</MaoButton>
        </div>
      ) : visibleProviders.length === 0 ? (
        <div className="models-no-results">{t("noModels")}</div>
      ) : (
        <div className="models-provider-list">
          {visibleProviders.map((provider) => {
            const open = expanded[provider.id] ?? false;
            const allModels = modelsFor(provider);
            const models = allModels.filter((model) => needle === "" || `${provider.name} ${model.name} ${model.model}`.toLowerCase().includes(needle));
            const healthy = provider.key_configured && provider.verified;
            return (
              <div key={provider.id} className="models-provider-group">
                <div className="models-provider-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={provider.enabled}
                    aria-label={provider.name}
                    className={`models-switch${provider.enabled ? " is-on" : ""}`}
                    onClick={() => void toggleProvider(provider)}
                  >
                    <span />
                  </button>
                  <button
                    type="button"
                    className="models-provider-main"
                    aria-expanded={open}
                    onClick={() => setExpanded((was) => ({ ...was, [provider.id]: !open }))}
                  >
                    <span className="models-provider-name">{provider.name}</span>
                    <span className="models-count">{allModels.length}</span>
                    <span className={"models-health " + (healthy ? "is-ok" : "is-warn")} aria-label={healthy ? t("healthy") : provider.verified ? t("verified") : t("configured")}><span className="models-health-dot" /></span>
                  </button>
                  <div className="models-provider-actions">
                    <Popover
                      className="models-menu"
                      align="end"
                      title={t("more")}
                      open={menu === `provider:${provider.id}`}
                      onToggle={() => setMenu(menu === `provider:${provider.id}` ? null : `provider:${provider.id}`)}
                      onClose={() => setMenu(null)}
                      label={<Icon name={ICON.more} className="icon icon-sm" />}
                    >
                      <button type="button" className="option" onClick={() => { setMenu(null); setEditor({ kind: "provider", draft: providerDraft(provider) }); }}>{t("editProvider")}</button>
                      <button type="button" className="option" onClick={() => { setMenu(null); void removeProvider(provider); }}>{t("delete")}</button>
                    </Popover>
                    <button
                      type="button"
                      className="models-expand"
                      aria-label={open ? t("collapse") : t("expand")}
                      aria-expanded={open}
                      onClick={() => setExpanded((was) => ({ ...was, [provider.id]: !open }))}
                    >
                      <Icon name={open ? ICON.chevronDown : ICON.chevronRight} className="icon icon-sm" />
                    </button>
                  </div>
                </div>
                {open ? <div className="models-model-list">
                  {models.map((model) => {
                    return (
                      <div key={`${model.provider}/${model.model}`} className="models-row">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={model.enabled}
                          aria-label={model.name}
                          className={`models-switch${model.enabled ? " is-on" : ""}`}
                          onClick={() => void toggleModel(model)}
                        >
                          <span />
                        </button>
                        <div className="models-row-main">
                          <div className="models-row-title">
                            <span className="models-name">{model.name}</span>
                          </div>
                          <div className="models-row-facts">
                            <span>{model.model}</span>
                            <span>{tokenText(model.context_tokens)}</span>
                            {model.capabilities.tools ? <span>{t("tools")}</span> : null}
                            {model.capabilities.vision ? <span>{t("vision")}</span> : null}
                          </div>
                        </div>
                        <div className="models-row-actions">
                          <Popover
                            className="models-menu"
                            align="end"
                            title={t("more")}
                            open={menu === `model:${model.provider}/${model.model}`}
                            onToggle={() => setMenu(menu === `model:${model.provider}/${model.model}` ? null : `model:${model.provider}/${model.model}`)}
                            onClose={() => setMenu(null)}
                            label={<Icon name={ICON.more} className="icon icon-sm" />}
                          >
                            <button type="button" className="option" onClick={() => { setMenu(null); setEditor({ kind: "model", draft: modelDraft(model.provider, model) }); }}>{t("editModel")}</button>
                            <button type="button" className="option" onClick={() => { setMenu(null); void removeModel(model); }}>{t("delete")}</button>
                          </Popover>
                        </div>
                      </div>
                    );
                  })}
                  {models.length === 0 ? (
                    <div className="models-provider-empty">
                      <span>{t("modelsProviderEmpty")}</span>
                      <MaoButton size="sm" variant="bordered" onClick={() => openNewModel(provider.id)}>{t("addModel")}</MaoButton>
                    </div>
                  ) : null}
                </div> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
