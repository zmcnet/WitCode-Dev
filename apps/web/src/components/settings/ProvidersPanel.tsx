import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProviderInput, ProviderPublic } from '@witcode/protocol';

interface Props {
  providers: ProviderPublic[];
  connected: boolean;
  saving: boolean;
  deletingId: string | null;
  onSave: (input: ProviderInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

interface FormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelIdsText: string;
  contextWindowText: string;
  enabled: boolean;
}

type FormErrors = Partial<
  Record<'name' | 'baseUrl' | 'modelIdsText' | 'contextWindowText', string>
>;

const emptyForm: FormState = {
  name: '',
  baseUrl: '',
  apiKey: '',
  modelIdsText: '',
  contextWindowText: '1000000',
  enabled: true,
};

/** 与 packages/model 的 MIN_CONTEXT_WINDOW 对齐。 */
const MIN_CONTEXT_WINDOW = 1_000_000;

function parseModelIds(text: string): string[] {
  return text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '—';
  const millions = tokens / 1_000_000;
  return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M tokens`;
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = '请输入提供商名称';

  const url = form.baseUrl.trim();
  if (!url) {
    errors.baseUrl = '请输入 Base URL';
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.baseUrl = 'Base URL 必须使用 http 或 https';
      }
    } catch {
      errors.baseUrl = '请输入有效的 http(s) URL';
    }
  }

  if (parseModelIds(form.modelIdsText).length === 0) {
    errors.modelIdsText = '请至少填写一个模型 ID';
  }

  const window = Number(form.contextWindowText);
  if (!Number.isFinite(window) || !Number.isInteger(window)) {
    errors.contextWindowText = '上下文窗口必须是整数 tokens';
  } else if (window < MIN_CONTEXT_WINDOW) {
    errors.contextWindowText = `上下文窗口必须 ≥ ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')}`;
  }
  return errors;
}

export function ProvidersPanel({
  providers,
  connected,
  saving,
  deletingId,
  onSave,
  onDelete,
}: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderPublic | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmTarget, setConfirmTarget] = useState<ProviderPublic | null>(null);
  const formTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogCancelRef = useRef<HTMLButtonElement | null>(null);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === 'name' || key === 'baseUrl' || key === 'modelIdsText' || key === 'contextWindowText') {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  };

  const openNew = (trigger: HTMLButtonElement) => {
    formTriggerRef.current = trigger;
    setEditing(null);
    setForm(emptyForm);
    setErrors({});
    setFormOpen(true);
  };

  const openEdit = (provider: ProviderPublic, trigger: HTMLButtonElement) => {
    formTriggerRef.current = trigger;
    setEditing(provider);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      modelIdsText: provider.modelIds.join(', '),
      contextWindowText: String(provider.contextWindow),
      enabled: provider.enabled,
    });
    setErrors({});
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setErrors({});
    const trigger = formTriggerRef.current;
    requestAnimationFrame(() => trigger?.focus());
  };

  useEffect(() => {
    if (!formOpen || confirmTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeForm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [formOpen, confirmTarget]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const input: ProviderInput = {
      ...(editing ? { id: editing.id } : {}),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      modelIds: parseModelIds(form.modelIdsText),
      contextWindow: Number(form.contextWindowText),
      enabled: form.enabled,
    };
    if (form.apiKey.trim()) input.apiKey = form.apiKey.trim();
    try {
      await onSave(input);
      closeForm();
    } catch {
      // 错误由 App 级错误条展示，保留表单供修改后重试。
    }
  };

  const closeConfirm = () => {
    setConfirmTarget(null);
    const trigger = deleteTriggerRef.current;
    requestAnimationFrame(() => trigger?.focus());
  };

  useEffect(() => {
    if (!confirmTarget) return;
    dialogCancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeConfirm();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmTarget]);

  const confirmDelete = async () => {
    const target = confirmTarget;
    if (!target) return;
    try {
      await onDelete(target.id);
    } catch {
      // 错误由 App 级错误条展示。
    }
    closeConfirm();
  };

  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>提供商</h2>
          <p className="panel-desc">管理模型提供商、API Key 与可用模型。</p>
        </div>
        <button
          type="button"
          className="btn primary"
          aria-label="新增提供商"
          disabled={!connected || saving}
          onClick={(event) => openNew(event.currentTarget)}
        >
          + 新增提供商
        </button>
      </div>

      {formOpen ? (
        <form className="provider-form" noValidate onSubmit={submit}>
          <div className="form-title">
            {editing ? `编辑「${editing.name}」` : '新增提供商'}
          </div>
          <div className="form-grid">
            <label className="form-field">
              <span>名称</span>
              <input
                value={form.name}
                aria-label="名称"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'provider-name-error' : undefined}
                onChange={(event) => setField('name', event.target.value)}
                placeholder="例如 DeepSeek"
              />
              {errors.name ? (
                <span id="provider-name-error" className="field-error" role="alert">
                  {errors.name}
                </span>
              ) : null}
            </label>
            <label className="form-field">
              <span>Base URL</span>
              <input
                value={form.baseUrl}
                aria-label="Base URL"
                aria-invalid={Boolean(errors.baseUrl)}
                aria-describedby={errors.baseUrl ? 'provider-url-error' : undefined}
                onChange={(event) => setField('baseUrl', event.target.value)}
                placeholder="https://api.example.com/v1"
              />
              {errors.baseUrl ? (
                <span id="provider-url-error" className="field-error" role="alert">
                  {errors.baseUrl}
                </span>
              ) : null}
            </label>
            <label className="form-field form-field-wide">
              <span>API Key</span>
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                aria-label="API Key"
                onChange={(event) => setField('apiKey', event.target.value)}
                placeholder={editing ? '留空表示不修改' : '输入 API Key'}
              />
            </label>
            <label className="form-field form-field-wide">
              <span>模型 ID（逗号或换行分隔）</span>
              <textarea
                rows={2}
                value={form.modelIdsText}
                aria-label="模型 ID（逗号或换行分隔）"
                aria-invalid={Boolean(errors.modelIdsText)}
                aria-describedby={errors.modelIdsText ? 'provider-models-error' : undefined}
                onChange={(event) => setField('modelIdsText', event.target.value)}
                placeholder="deepseek-chat, deepseek-reasoner"
              />
              {errors.modelIdsText ? (
                <span id="provider-models-error" className="field-error" role="alert">
                  {errors.modelIdsText}
                </span>
              ) : null}
            </label>
            <label className="form-field form-field-wide">
              <span>上下文窗口（tokens，最低 1M）</span>
              <input
                type="number"
                min={MIN_CONTEXT_WINDOW}
                step={100000}
                value={form.contextWindowText}
                aria-label="上下文窗口（tokens，最低 1M）"
                aria-invalid={Boolean(errors.contextWindowText)}
                aria-describedby={errors.contextWindowText ? 'provider-window-error' : undefined}
                onChange={(event) => setField('contextWindowText', event.target.value)}
                placeholder="1000000"
              />
              {errors.contextWindowText ? (
                <span id="provider-window-error" className="field-error" role="alert">
                  {errors.contextWindowText}
                </span>
              ) : null}
            </label>
          </div>
          <label className="form-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              aria-label="启用该提供商"
              onChange={(event) => setField('enabled', event.target.checked)}
            />
            <span>启用该提供商</span>
          </label>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={!connected || saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn ghost" disabled={saving} onClick={closeForm}>
              取消
            </button>
          </div>
        </form>
      ) : null}

      {providers.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">还没有提供商，先加一个</div>
          <div className="empty-state-hint">添加后即可在顶栏切换模型并查看用量。</div>
        </div>
      ) : (
        <div className="provider-grid">
          {providers.map((provider) => (
            <div className="provider-card" key={provider.id}>
              <div className="provider-card-head">
                <span className="provider-name" title={provider.name}>
                  {provider.name || '未命名提供商'}
                </span>
                <span className={provider.enabled ? 'provider-badge on' : 'provider-badge off'}>
                  {provider.enabled ? '已启用' : '已停用'}
                </span>
              </div>
              <div className="provider-line">
                <span className="provider-key">Base URL</span>
                <span className="provider-value" title={provider.baseUrl}>
                  {provider.baseUrl || '—'}
                </span>
              </div>
              <div className="provider-line">
                <span className="provider-key">模型数</span>
                <span className="provider-value">{provider.modelIds.length} 个</span>
              </div>
              <div className="provider-line">
                <span className="provider-key">上下文窗口</span>
                <span className="provider-value" title={`${provider.contextWindow} tokens`}>
                  {formatWindow(provider.contextWindow)}
                </span>
              </div>
              <div className="provider-line">
                <span className="provider-key">API Key</span>
                <span
                  className="provider-value"
                  title={provider.apiKeyHint || (provider.hasApiKey ? '已设置' : '未设置')}
                >
                  {provider.apiKeyHint || (provider.hasApiKey ? '已设置' : '未设置')}
                </span>
              </div>
              <div className="provider-actions">
                <button
                  type="button"
                  className="btn small ghost"
                  aria-label={`编辑提供商 ${provider.name}`}
                  disabled={!connected || saving}
                  onClick={(event) => openEdit(provider, event.currentTarget)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  aria-label={`删除提供商 ${provider.name}`}
                  disabled={!connected || deletingId !== null}
                  onClick={(event) => {
                    deleteTriggerRef.current = event.currentTarget;
                    setConfirmTarget(provider);
                  }}
                >
                  {deletingId === provider.id ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmTarget ? (
        <div className="dialog-backdrop">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
          >
            <div id="confirm-delete-title" className="dialog-title">
              删除提供商
            </div>
            <p className="dialog-text">
              确定删除「{confirmTarget.name}」吗？此操作不可撤销。
            </p>
            <div className="dialog-actions">
              <button
                ref={dialogCancelRef}
                type="button"
                className="btn ghost"
                aria-label="取消删除"
                disabled={deletingId !== null}
                onClick={closeConfirm}
              >
                取消
              </button>
              <button
                type="button"
                className="btn danger"
                aria-label={`确认删除 ${confirmTarget.name}`}
                disabled={deletingId !== null}
                onClick={confirmDelete}
              >
                {deletingId === confirmTarget.id ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
