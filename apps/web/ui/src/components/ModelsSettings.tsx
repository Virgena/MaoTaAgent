import { useEffect, useRef, useState } from "react";

import { useT } from "../lib/i18n.ts";
import { useMaoChange, useMaoInput } from "../lib/maoEvents.ts";
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

  const patchProvider = (field: keyof ProviderDraft, value: string): void =>
    setEditor((current) => current?.kind === "provider" ? { kind: "provider", draft: { ...current.draft, [field]: value } } : current);
  const patchModel = (field: keyof ModelDraft, value: string): void =>
    setEditor((current) => current?.kind === "model" ? { kind: "model", draft: { ...current.draft, [field]: value } } : current);
  const setAuthKind = (value: string): void =>
    setEditor((current) => current?.kind === "provider"
      ? { kind: "provider", draft: { ...current.draft, auth_kind: value === "env" ? "env" : "file" } }
      : current);

  const adapterRef = useMaoChange((value) => patchProvider("adapter", value));
  const providerNameRef = useMaoInput((value) => patchProvider("name", value));
  const baseUrlRef = useMaoInput((value) => patchProvider("base_url", value));
  const authKindRef = useMaoChange(setAuthKind);
  const envNameRef = useMaoInput((value) => patchProvider("env_name", value));
  const apiKeyRef = useMaoInput((value) => patchProvider("api_key", value));
  const modelProviderRef = useMaoChange((value) => patchModel("provider", value));
  const modelIdRef = useMaoInput((value) => patchModel("model", value));
  const modelNameRef = useMaoInput((value) => patchModel("name", value));
  const contextRef = useMaoInput((value) => patchModel("context_tokens", value));
  const maxOutputRef = useMaoInput((value) => patchModel("max_output_tokens", value));
  const effortsRef = useMaoInput((value) => patchModel("reasoning_efforts", value));

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
      editorDialog.current?.querySelector<HTMLElement>("mao-select, mao-text-field, mao-text-area, button")?.focus();
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
            <mao-select ref={adapterRef} label={t("adapter")} value={editor.draft.adapter} options={JSON.stringify(adapters.map((adapter) => ({ value: adapter.id, label: adapter.name })))} />
            <mao-text-field ref={providerNameRef} label={t("providerName")} value={editor.draft.name} />
            <mao-text-field ref={baseUrlRef} label={t("baseUrl")} value={editor.draft.base_url} />
            <mao-select ref={authKindRef} label={t("keySource")} value={editor.draft.auth_kind} options={JSON.stringify([{ value: "file", label: t("keySourceFile") }, { value: "env", label: t("keySourceEnv") }])} />
            {editor.draft.auth_kind === "env" ? (
              <mao-text-field ref={envNameRef} label={t("keyEnv")} value={editor.draft.env_name} />
            ) : (
              <mao-text-field ref={apiKeyRef} label={t("apiKey")} type="password" autocomplete="new-password" value={editor.draft.api_key} />
            )}
          </div>
          {discovered.length === 0 ? null : (
            <div className="model-discovered">
              <span className="model-discovered-title">{t("discoveredModels")}</span>
              <div className="model-discovered-list">
                {discovered.map((model) => (
                  <mao-button key={model.id} size="sm" variant="bordered" color={pickedModel?.id === model.id ? "primary" : "neutral"} onClick={() => setPickedModel(model)}>
                    {pickedModel?.id === model.id ? <mao-icon name="check" className="icon icon-sm" /> : null}
                    {model.name ?? model.id}
                  </mao-button>
                ))}
              </div>
            </div>
          )}
          <div className="model-editor-actions">
            <mao-button size="sm" variant="bordered" loading={busy} onClick={() => void discover()}>{t("discoverModels")}</mao-button>
            <div className="model-editor-actions-right">
              <mao-button size="sm" variant="flat" onClick={() => setEditor(null)}>{t("cancel")}</mao-button>
              <mao-button size="sm" color="primary" disabled={busy || editor.draft.name === "" || editor.draft.base_url === ""} onClick={() => void saveProvider()}>{t("save")}</mao-button>
            </div>
          </div>
        </form>
      ) : (
        <form className="model-editor" onSubmit={(event) => { event.preventDefault(); void saveModel(); }}>
          <div className="model-editor-title" id="model-editor-title">{editor.draft.model === "" ? t("addModel") : t("editModel")}</div>
          <div className="model-form-grid">
            <mao-select ref={modelProviderRef} label={t("modelProvider")} value={editor.draft.provider} options={JSON.stringify(configurableProviders.map((provider) => ({ value: provider.id, label: provider.name })))} />
            <mao-text-field ref={modelIdRef} label={t("modelId")} value={editor.draft.model} />
            <mao-text-field ref={modelNameRef} label={t("modelName")} value={editor.draft.name} />
            <mao-text-field ref={contextRef} label={t("contextTokens")} value={editor.draft.context_tokens} />
            <mao-text-field ref={maxOutputRef} label={t("maxOutputTokens")} value={editor.draft.max_output_tokens} />
            <mao-text-field ref={effortsRef} label={t("reasoningEfforts")} placeholder="low, medium, high" value={editor.draft.reasoning_efforts} />
          </div>
          <div className="model-checks">
            <label><input type="checkbox" checked={editor.draft.tools} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, tools: event.target.checked } })} />{t("tools")}</label>
            <label><input type="checkbox" checked={editor.draft.vision} onChange={(event) => setEditor({ kind: "model", draft: { ...editor.draft, vision: event.target.checked } })} />{t("vision")}</label>
          </div>
          <div className="model-editor-actions">
            <div className="model-editor-actions-right">
              <mao-button size="sm" variant="flat" onClick={() => setEditor(null)}>{t("cancel")}</mao-button>
              <mao-button size="sm" color="primary" disabled={busy || editor.draft.provider === "" || editor.draft.model === ""} onClick={() => void saveModel()}>{t("save")}</mao-button>
            </div>
          </div>
        </form>
      )}
          </div>
        </div>
      )}

      <div className="models-toolbar">
        <label className="models-search">
          <mao-icon name="search" className="icon icon-sm" />
          <input value={query} placeholder={t("searchModels")} aria-label={t("searchModels")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="models-toolbar-actions">
          <mao-button size="sm" variant="bordered" onClick={openNewProvider}>{t("addProvider")}</mao-button>
          <mao-button size="sm" variant="bordered" disabled={configurableProviders.length === 0} onClick={() => openNewModel()}>{t("addModel")}</mao-button>
        </div>
      </div>

      {error === null ? null : <div className="model-error">{error}</div>}
      {configurableProviders.length === 0 ? (
        <div className="models-empty">
          <div className="models-empty-mark"><mao-icon name="cpu" size={20} /></div>
          <div className="models-empty-title">{t("modelsEmptyTitle")}</div>
          <mao-button size="sm" color="primary" onClick={openNewProvider}>{t("addProvider")}</mao-button>
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
                      label={<mao-icon name="ellipsis" className="icon icon-sm" />}
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
                      <mao-icon name={open ? "chevron-down" : "chevron-right"} className="icon icon-sm" />
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
                            label={<mao-icon name="ellipsis" className="icon icon-sm" />}
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
                      <mao-button size="sm" variant="bordered" onClick={() => openNewModel(provider.id)}>{t("addModel")}</mao-button>
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
