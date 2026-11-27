import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type {
  ModelInfo,
  ProviderInput,
  ProviderModelSettings,
  ProviderPublic,
  ProviderTestResult,
} from '@witcode/protocol';
import { IconCheck, IconPlus, IconX } from '../../icons';

/** 与服务端 MIN_CONTEXT_WINDOW / MAX_OUTPUT_TOKENS 对齐。 */
const MIN_CONTEXT_WINDOW = 1_000_000;
const MAX_OUTPUT_TOKENS = 128_000;

export interface ModelEditorProps {
  /** null 表示新增。 */
  provider: ProviderPublic | null;
  models: ModelInfo[];
  connected: boolean;
  saving: boolean;
  deletingId: string | null;
  onClose(): void;
  onSave(input: ProviderInput): Promise<void>;
  onDelete(id: string): Promise<void>;
  onTest(id: string): Promise<ProviderTestResult>;
}

interface ModelDraft {
  displayName: string;
  contextWindow: string;
  maxOutputTokens: string;
  enabled: boolean;
}

interface EditorForm {
  name: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: string;
  enabled: boolean;
  modelIds: string[];
  drafts: Record<string, ModelDraft>;
}

interface FormErrors {
  name?: string;
  baseUrl?: string;
  modelIds?: string;
  contextWindow?: string;
}

interface DraftErrors {
  contextWindow?: string;
  maxOutputTokens?: string;
}

type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; latencyMs: number; modelCount?: number }
  | { status: 'error'; message: string };

function emptyDraft(): ModelDraft {
  return { displayName: '', contextWindow: '', maxOutputTokens: '', enabled: true };
}

function draftFromModel(id: string, provider: ProviderPublic | null, models: ModelInfo[]): ModelDraft {
  const info = models.find(
    (model) => model.id === id && (provider === null || model.providerId === provider.id),
  );
  const windowValue =
    info && Number.isFinite(info.contextWindow) && info.contextWindow >= MIN_CONTEXT_WINDOW
      ? String(info.contextWindow)
      : '';
  return {
    displayName: info?.displayName ?? '',
    contextWindow: windowValue,
    maxOutputTokens: info?.maxOutputTokens ? String(info.maxOutputTokens) : '',
    enabled: info?.enabled ?? true,
  };
}

function initialForm(provider: ProviderPublic | null, models: ModelInfo[]): EditorForm {
  if (!provider) {
    return {
      name: '',
      baseUrl: '',
      apiKey: '',
      contextWindow: String(MIN_CONTEXT_WINDOW),
      enabled: true,
      modelIds: [],
      drafts: {},
    };
  }
  const drafts: Record<string, ModelDraft> = {};
  for (const id of provider.modelIds) {
    const base = draftFromModel(id, provider, models);
    const override = provider.modelSettings?.[id];
    drafts[id] = {
      displayName: override?.displayName ?? base.displayName,
      contextWindow:
        override?.contextWindow !== undefined ? String(override.contextWindow) : base.contextWindow,
      maxOutputTokens:
        override?.maxOutputTokens !== undefined
          ? String(override.maxOutputTokens)
          : base.maxOutputTokens,
      enabled: override?.enabled ?? base.enabled,
    };
  }
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: '',
    contextWindow: String(provider.contextWindow),
    enabled: provider.enabled,
    modelIds: [...provider.modelIds],
    drafts,
  };
}

function validate(form: EditorForm): { errors: FormErrors; draftErrors: Record<string, DraftErrors> } {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = '请输入提供商名称';

  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = '请输入 Base URL';
  } else {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.baseUrl = 'Base URL 必须使用 http 或 https';
      }
    } catch {
      errors.baseUrl = '请输入有效的 http(s) URL';
    }
  }

  if (form.modelIds.length === 0) errors.modelIds = '请至少添加一个模型 ID';

  const windowTokens = Number(form.contextWindow);
  if (!form.contextWindow.trim() || !Number.isFinite(windowTokens) || !Number.isInteger(windowTokens)) {
    errors.contextWindow = '上下文窗口必须是整数 tokens';
  } else if (windowTokens < MIN_CONTEXT_WINDOW) {
    errors.contextWindow = `上下文窗口必须 ≥ ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')}`;
  }

  const draftErrors: Record<string, DraftErrors> = {};
  for (const id of form.modelIds) {
    const draft = form.drafts[id];
    if (!draft) continue;
    const local: DraftErrors = {};
    if (draft.contextWindow.trim()) {
      const value = Number(draft.contextWindow);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        local.contextWindow = '必须是整数 tokens';
      } else if (value < MIN_CONTEXT_WINDOW) {
        local.contextWindow = `必须 ≥ ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')}`;
      }
    }
    if (draft.maxOutputTokens.trim()) {
      const value = Number(draft.maxOutputTokens);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        local.maxOutputTokens = '必须是整数 tokens';
      } else if (value <= 0) {
        local.maxOutputTokens = '必须大于 0';
      } else if (value > MAX_OUTPUT_TOKENS) {
        local.maxOutputTokens = `不能超过 ${MAX_OUTPUT_TOKENS.toLocaleString('en-US')}`;
      }
    }
    if (Object.keys(local).length > 0) draftErrors[id] = local;
  }
  return { errors, draftErrors };
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="model-settings-field" htmlFor={id}>
      <span className="model-settings-field-label">{label}</span>
      {children}
      {hint ? <span className="model-settings-field-hint">{hint}</span> : null}
      {error ? (
        <span className="model-settings-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function ModelEditor({
  provider,
  models,
  connected,
  saving,
  deletingId,
  onClose,
  onSave,
  onDelete,
  onTest,
}: ModelEditorProps) {
  const [form, setForm] = useState<EditorForm>(() => initialForm(provider, models));
  const [errors, setErrors] = useState<FormErrors>({});
  const [draftErrors, setDraftErrors] = useState<Record<string, DraftErrors>>({});
  const [modelInput, setModelInput] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (confirmOpen) cancelRef.current?.focus();
  }, [confirmOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmOpen) {
        setConfirmOpen(false);
        requestAnimationFrame(() => deleteRef.current?.focus());
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [confirmOpen, onClose]);

  const setField = <K extends keyof EditorForm>(key: K, value: EditorForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === 'name' || key === 'baseUrl' || key === 'modelIds' || key === 'contextWindow') {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  };

  const addModels = () => {
    const ids = modelInput
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const fresh = ids.filter((id) => !form.modelIds.includes(id));
    setModelInput('');
    setErrors((prev) => ({ ...prev, modelIds: undefined }));
    if (fresh.length === 0) return;
    const drafts = { ...form.drafts };
    for (const id of fresh) drafts[id] = draftFromModel(id, provider, models);
    setForm((prev) => ({
      ...prev,
      modelIds: [...prev.modelIds, ...fresh],
      drafts: { ...prev.drafts, ...drafts },
    }));
    setExpandedId(fresh[fresh.length - 1] ?? null);
  };

  const onModelInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addModels();
    }
  };

  const removeModel = (id: string) => {
    setForm((prev) => {
      const drafts = { ...prev.drafts };
      delete drafts[id];
      return { ...prev, modelIds: prev.modelIds.filter((item) => item !== id), drafts };
    });
    setDraftErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (expandedId === id) setExpandedId(null);
    setErrors((prev) => ({ ...prev, modelIds: undefined }));
  };

  const updateDraft = (id: string, patch: Partial<ModelDraft>) => {
    setForm((prev) => {
      const current = prev.drafts[id] ?? emptyDraft();
      return { ...prev, drafts: { ...prev.drafts, [id]: { ...current, ...patch } } };
    });
    setDraftErrors((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const next = { ...current };
      if (Object.prototype.hasOwnProperty.call(patch, 'contextWindow')) {
        next.contextWindow = undefined;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'maxOutputTokens')) {
        next.maxOutputTokens = undefined;
      }
      return { ...prev, [id]: next };
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validate(form);
    setErrors(result.errors);
    setDraftErrors(result.draftErrors);
    if (Object.keys(result.errors).length > 0 || Object.keys(result.draftErrors).length > 0) return;

    const modelSettings: Record<string, ProviderModelSettings> = {};
    for (const id of form.modelIds) {
      const draft = form.drafts[id];
      if (!draft) continue;
      const entry: ProviderModelSettings = {};
      const displayName = draft.displayName.trim();
      if (displayName) entry.displayName = displayName;
      if (draft.contextWindow.trim()) entry.contextWindow = Number(draft.contextWindow);
      if (draft.maxOutputTokens.trim()) {
        entry.maxOutputTokens = Number(draft.maxOutputTokens);
      }
      if (!draft.enabled) entry.enabled = false;
      if (Object.keys(entry).length > 0) modelSettings[id] = entry;
    }

    const input: ProviderInput = {
      ...(provider ? { id: provider.id } : {}),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      modelIds: form.modelIds,
      contextWindow: Number(form.contextWindow),
      modelSettings,
      enabled: form.enabled,
    };
    const apiKey = form.apiKey.trim();
    if (apiKey) input.apiKey = apiKey;

    try {
      await onSave(input);
      onClose();
    } catch {
      // 错误由上层错误条展示，保留表单供修改后重试。
    }
  };

  const testConnection = async () => {
    if (!provider) return;
    setTest({ status: 'loading' });
    try {
      const result = await onTest(provider.id);
      if (result.ok) {
        setTest({
          status: 'ok',
          latencyMs: result.latencyMs,
          modelCount: result.modelCount,
        });
      } else {
        setTest({ status: 'error', message: result.error || '连接测试失败' });
      }
    } catch (error) {
      setTest({
        status: 'error',
        message: error instanceof Error ? error.message : '连接测试失败',
      });
    }
  };

  const confirmDelete = async () => {
    if (!provider) return;
    try {
      await onDelete(provider.id);
      onClose();
    } catch {
      // 错误由上层错误条展示，保留编辑器。
      setConfirmOpen(false);
    }
  };

  const titleId = 'model-settings-editor-title';
  const expandedDraft = expandedId ? form.drafts[expandedId] : undefined;
  const expandedErrors = expandedId ? draftErrors[expandedId] : undefined;

  return (
    <div
      className="model-settings-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !confirmOpen && !saving) onClose();
      }}
    >
      <div
        className="model-settings-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <form className="model-settings-editor-form" noValidate onSubmit={submit}>
          <header className="model-settings-editor-head">
            <div>
              <h3 id={titleId}>{provider ? `编辑「${provider.name}」` : '新增提供商'}</h3>
              <p>配置连接信息、可用模型与单个模型的覆盖参数。</p>
            </div>
            <button
              type="button"
              className="model-settings-icon-btn"
              aria-label="关闭编辑器"
              disabled={saving}
              onClick={onClose}
            >
              <IconX size={16} />
            </button>
          </header>

          <div className="model-settings-editor-body">
            <div className="model-settings-form-grid">
              <Field id="ms-name" label="名称" error={errors.name}>
                <input
                  id="ms-name"
                  ref={nameRef}
                  className="model-settings-input"
                  value={form.name}
                  aria-label="提供商名称"
                  aria-invalid={Boolean(errors.name)}
                  placeholder="例如 DeepSeek"
                  onChange={(event) => setField('name', event.target.value)}
                />
              </Field>
              <Field id="ms-base-url" label="Base URL" error={errors.baseUrl}>
                <input
                  id="ms-base-url"
                  className="model-settings-input"
                  value={form.baseUrl}
                  aria-label="Base URL"
                  aria-invalid={Boolean(errors.baseUrl)}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => setField('baseUrl', event.target.value)}
                />
              </Field>
              <Field
                id="ms-api-key"
                label="API Key"
                hint={provider ? '留空表示不修改已有 Key' : '保存后可用于请求模型服务'}
              >
                <input
                  id="ms-api-key"
                  type="password"
                  autoComplete="off"
                  className="model-settings-input"
                  value={form.apiKey}
                  aria-label="API Key（留空不变）"
                  placeholder={provider ? '留空不变' : '输入 API Key'}
                  onChange={(event) => setField('apiKey', event.target.value)}
                />
              </Field>
              <Field
                id="ms-context-window"
                label="默认上下文窗口（tokens）"
                hint={`最低 ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')}`}
                error={errors.contextWindow}
              >
                <input
                  id="ms-context-window"
                  type="number"
                  min={MIN_CONTEXT_WINDOW}
                  step={100000}
                  className="model-settings-input"
                  value={form.contextWindow}
                  aria-label="默认上下文窗口（tokens，最低 1M）"
                  aria-invalid={Boolean(errors.contextWindow)}
                  onChange={(event) => setField('contextWindow', event.target.value)}
                />
              </Field>
            </div>

            <label className="model-settings-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                aria-label="启用该提供商"
                onChange={(event) => setField('enabled', event.target.checked)}
              />
              <span>启用该提供商</span>
            </label>

            <section className="model-settings-models" aria-label="模型列表">
              <div className="model-settings-section-head">
                <span className="model-settings-section-title">模型</span>
                <span className="model-settings-section-hint">点击模型可展开单模型设置</span>
              </div>
              <div className="model-settings-model-add">
                <input
                  className="model-settings-input"
                  value={modelInput}
                  aria-label="添加模型 ID"
                  aria-invalid={Boolean(errors.modelIds)}
                  placeholder="输入模型 ID 后回车，如 deepseek-chat"
                  onChange={(event) => setModelInput(event.target.value)}
                  onKeyDown={onModelInputKeyDown}
                />
                <button
                  type="button"
                  className="model-settings-btn"
                  aria-label="添加模型"
                  onClick={addModels}
                >
                  <IconPlus size={14} />
                  添加
                </button>
              </div>
              {errors.modelIds ? (
                <span className="model-settings-field-error" role="alert">
                  {errors.modelIds}
                </span>
              ) : null}

              <div className="model-settings-chips" aria-label="已添加的模型">
                {form.modelIds.length === 0 ? (
                  <span className="model-settings-chips-empty">尚未添加模型</span>
                ) : (
                  form.modelIds.map((id) => (
                    <span className="model-settings-chip" key={id}>
                      <button
                        type="button"
                        className={expandedId === id ? 'model-settings-chip-label active' : 'model-settings-chip-label'}
                        aria-expanded={expandedId === id}
                        aria-label={`模型设置 ${id}`}
                        onClick={() => setExpandedId((current) => (current === id ? null : id))}
                      >
                        {form.drafts[id]?.displayName ? `${form.drafts[id]?.displayName} · ${id}` : id}
                      </button>
                      <button
                        type="button"
                        className="model-settings-chip-remove"
                        aria-label={`移除模型 ${id}`}
                        onClick={() => removeModel(id)}
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  ))
                )}
              </div>

              {expandedId && expandedDraft ? (
                <div className="model-settings-chip-config">
                  <div className="model-settings-chip-config-head">
                    <strong>{expandedId}</strong>
                    <span>仅该模型生效；留空则继承提供商默认值</span>
                  </div>
                  <div className="model-settings-form-grid">
                    <Field id="ms-model-display" label="显示名">
                      <input
                        id="ms-model-display"
                        className="model-settings-input"
                        value={expandedDraft.displayName}
                        aria-label={`${expandedId} 显示名`}
                        placeholder="留空使用模型 ID"
                        onChange={(event) => updateDraft(expandedId, { displayName: event.target.value })}
                      />
                    </Field>
                    <Field
                      id="ms-model-window"
                      label="上下文窗口（tokens）"
                      error={expandedErrors?.contextWindow}
                    >
                      <input
                        id="ms-model-window"
                        type="number"
                        min={MIN_CONTEXT_WINDOW}
                        step={100000}
                        className="model-settings-input"
                        value={expandedDraft.contextWindow}
                        aria-label={`${expandedId} 上下文窗口`}
                        aria-invalid={Boolean(expandedErrors?.contextWindow)}
                        placeholder={form.contextWindow}
                        onChange={(event) => updateDraft(expandedId, { contextWindow: event.target.value })}
                      />
                    </Field>
                    <Field
                      id="ms-model-output"
                      label="最大输出（tokens）"
                      hint={`上限 ${MAX_OUTPUT_TOKENS.toLocaleString('en-US')}`}
                      error={expandedErrors?.maxOutputTokens}
                    >
                      <input
                        id="ms-model-output"
                        type="number"
                        min={1}
                        max={MAX_OUTPUT_TOKENS}
                        className="model-settings-input"
                        value={expandedDraft.maxOutputTokens}
                        aria-label={`${expandedId} 最大输出`}
                        aria-invalid={Boolean(expandedErrors?.maxOutputTokens)}
                        placeholder="留空使用默认值"
                        onChange={(event) =>
                          updateDraft(expandedId, { maxOutputTokens: event.target.value })
                        }
                      />
                    </Field>
                    <label className="model-settings-toggle model-settings-toggle-compact">
                      <input
                        type="checkbox"
                        checked={expandedDraft.enabled}
                        aria-label={`${expandedId} 是否启用`}
                        onChange={(event) => updateDraft(expandedId, { enabled: event.target.checked })}
                      />
                      <span>启用该模型</span>
                    </label>
                  </div>
                </div>
              ) : null}
            </section>

            <div className="model-settings-test" aria-live="polite">
              <button
                type="button"
                className="model-settings-btn"
                aria-label="测试连接"
                disabled={!provider || !connected || saving || test.status === 'loading'}
                onClick={testConnection}
              >
                {test.status === 'loading' ? '测试中…' : '测试连接'}
              </button>
              {test.status === 'ok' ? (
                <span className="model-settings-test-ok">
                  <IconCheck size={14} />
                  连接成功 · {test.latencyMs} ms
                  {test.modelCount !== undefined ? ` · ${test.modelCount} 个模型` : ''}
                </span>
              ) : null}
              {test.status === 'error' ? (
                <span className="model-settings-test-error" role="alert">
                  {test.message}
                </span>
              ) : null}
              {test.status === 'idle' && !provider ? (
                <span className="model-settings-hint">保存后即可测试连接</span>
              ) : null}
            </div>
          </div>

          <footer className="model-settings-editor-foot">
            <button
              ref={deleteRef}
              type="button"
              className="model-settings-btn danger"
              aria-label={provider ? `删除提供商 ${provider.name}` : '删除提供商'}
              disabled={!provider || !connected || saving || deletingId !== null}
              onClick={() => setConfirmOpen(true)}
            >
              {deletingId && provider && deletingId === provider.id ? '删除中…' : '删除'}
            </button>
            <span className="model-settings-foot-spacer" />
            <button
              type="button"
              className="model-settings-btn"
              aria-label="取消编辑"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="model-settings-btn primary"
              aria-label="保存提供商"
              disabled={!connected || saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </footer>
        </form>

        {confirmOpen && provider ? (
          <div
            className="model-settings-confirm-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget && deletingId === null) {
                setConfirmOpen(false);
                requestAnimationFrame(() => deleteRef.current?.focus());
              }
            }}
          >
            <div
              className="model-settings-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="model-settings-delete-title"
              aria-describedby="model-settings-delete-desc"
            >
              <h4 id="model-settings-delete-title">删除提供商</h4>
              <p id="model-settings-delete-desc">
                确定删除「{provider.name}」吗？此操作不可撤销。
              </p>
              <div className="model-settings-confirm-actions">
                <button
                  ref={cancelRef}
                  type="button"
                  className="model-settings-btn"
                  aria-label="取消删除"
                  disabled={deletingId !== null}
                  onClick={() => {
                    setConfirmOpen(false);
                    requestAnimationFrame(() => deleteRef.current?.focus());
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="model-settings-btn danger"
                  aria-label={`确认删除 ${provider.name}`}
                  disabled={deletingId !== null}
                  onClick={confirmDelete}
                >
                  {deletingId === provider.id ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
