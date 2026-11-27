import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { HookConfig } from '@witcode/protocol';
import { IconInfo, IconPlus, IconX } from '../../icons';
import './hooks.css';

export interface HooksPanelProps {
  items: HookConfig[];
  connected: boolean;
  onRefresh(): void;
  onSave(hook: HookConfig): Promise<void>;
  onDelete(id: string): Promise<void>;
}

type HookEvent = HookConfig['event'];
/** null 表示关闭；add 为新增，edit 携带原始钩子。 */
type EditorState = { kind: 'add' } | { kind: 'edit'; hook: HookConfig } | null;

const EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'];
const TOOL_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse'];
const EVENT_LABEL: Record<HookEvent, string> = {
  PreToolUse: '工具调用前',
  PostToolUse: '工具调用后',
  Stop: '回合结束',
  SessionStart: '会话开始',
};

const DEFAULT_TIMEOUT = 10000;
const MIN_TIMEOUT = 100;
const MAX_TIMEOUT = 60000;

function isToolEvent(event: HookEvent): boolean {
  return TOOL_EVENTS.includes(event);
}

interface HookForm {
  name: string;
  event: HookEvent;
  matcher: string;
  command: string;
  /** 输入框按字符串维护，提交时再解析为数字。 */
  timeoutMs: string;
  enabled: boolean;
}

function emptyForm(): HookForm {
  return {
    name: '',
    event: 'PreToolUse',
    matcher: '',
    command: '',
    timeoutMs: String(DEFAULT_TIMEOUT),
    enabled: true,
  };
}

function formFromHook(hook: HookConfig): HookForm {
  return {
    name: hook.name,
    event: hook.event,
    matcher: hook.matcher ?? '',
    command: hook.command,
    timeoutMs: String(hook.timeoutMs ?? DEFAULT_TIMEOUT),
    enabled: hook.enabled,
  };
}

function nextId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseTimeout(raw: string): number {
  const trimmed = raw.trim();
  return trimmed === '' ? DEFAULT_TIMEOUT : Number(trimmed);
}

function validate(form: HookForm, items: HookConfig[], editingId: string | null): string {
  const name = form.name.trim();
  if (!name) return '请输入钩子名称';
  if (items.some((item) => item.id !== editingId && item.name === name)) {
    return `钩子「${name}」已存在`;
  }
  if (!form.command.trim()) return '请输入要执行的命令';
  const timeout = parseTimeout(form.timeoutMs);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
    return `超时需为 ${MIN_TIMEOUT}–${MAX_TIMEOUT}ms 之间的整数`;
  }
  return '';
}

/** 开关：语义化 role="switch"，busy 时禁用，避免重复点击。 */
function Switch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(next: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'hooks-switch on' : 'hooks-switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="hooks-switch-thumb" aria-hidden="true" />
    </button>
  );
}

function RefreshGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.4" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function EditGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

function commandSummary(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

export function HooksPanel({ items, connected, onRefresh, onSave, onDelete }: HooksPanelProps): JSX.Element {
  const [editor, setEditor] = useState<EditorState>(null);
  const [form, setForm] = useState<HookForm>(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState('');

  const nameRef = useRef<HTMLInputElement>(null);
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const pendingDelete = confirmDeleteId
    ? items.find((item) => item.id === confirmDeleteId) ?? null
    : null;

  function openEditor(next: Exclude<EditorState, null>) {
    editorTriggerRef.current = document.activeElement as HTMLElement | null;
    setForm(next.kind === 'add' ? emptyForm() : formFromHook(next.hook));
    setFormError('');
    setEditor(next);
  }

  function closeEditor() {
    setEditor(null);
    setFormError('');
    requestAnimationFrame(() => editorTriggerRef.current?.focus());
  }

  function openConfirm(id: string) {
    confirmTriggerRef.current = document.activeElement as HTMLElement | null;
    setDeleteError('');
    setConfirmDeleteId(id);
  }

  function closeConfirm() {
    setConfirmDeleteId(null);
    setDeleteError('');
    requestAnimationFrame(() => confirmTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (editor) nameRef.current?.focus();
  }, [editor]);

  useEffect(() => {
    if (confirmDeleteId) confirmCancelRef.current?.focus();
  }, [confirmDeleteId]);

  // Esc 先关闭删除确认，再关闭编辑器；保存/删除进行中不允许关闭。
  useEffect(() => {
    if (!editor && !confirmDeleteId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmDeleteId) {
        if (deletingId !== null) return;
        setConfirmDeleteId(null);
        setDeleteError('');
        requestAnimationFrame(() => confirmTriggerRef.current?.focus());
      } else if (editor) {
        if (saving) return;
        setEditor(null);
        setFormError('');
        requestAnimationFrame(() => editorTriggerRef.current?.focus());
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [editor, confirmDeleteId, saving, deletingId]);

  useEffect(() => {
    if (confirmDeleteId && !items.some((item) => item.id === confirmDeleteId)) {
      setConfirmDeleteId(null);
      setDeleteError('');
    }
  }, [items, confirmDeleteId]);

  async function toggleEnabled(hook: HookConfig) {
    if (!connected || togglingId !== null) return;
    setTogglingId(hook.id);
    setToggleError('');
    try {
      await onSave({ ...hook, enabled: !hook.enabled });
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : '切换启用状态失败，请重试。');
    } finally {
      setTogglingId(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving) return;
    const editingId = editor.kind === 'edit' ? editor.hook.id : null;
    const error = validate(form, items, editingId);
    if (error) {
      setFormError(error);
      return;
    }
    const matcher = isToolEvent(form.event) ? form.matcher.trim() : '';
    const hook: HookConfig = {
      id: editingId ?? nextId(),
      name: form.name.trim(),
      event: form.event,
      ...(matcher ? { matcher } : {}),
      command: form.command,
      timeoutMs: parseTimeout(form.timeoutMs),
      enabled: form.enabled,
    };

    setSaving(true);
    setFormError('');
    try {
      await onSave(hook);
      closeEditor();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!confirmDeleteId || deletingId !== null) return;
    const id = confirmDeleteId;
    setDeletingId(id);
    setDeleteError('');
    try {
      await onDelete(id);
      setConfirmDeleteId(null);
      requestAnimationFrame(() => confirmTriggerRef.current?.focus());
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="hooks-panel" aria-label="钩子管理">
      <div className="hooks-head">
        <div>
          <h2 className="hooks-title">钩子</h2>
          <p className="hooks-desc">在工具调用/回合/会话生命周期执行本机命令</p>
        </div>
        <div className="hooks-head-actions">
          <button
            type="button"
            className="hooks-icon-btn"
            aria-label="刷新钩子列表"
            title="刷新"
            onClick={onRefresh}
          >
            <RefreshGlyph />
          </button>
          <button
            type="button"
            className="hooks-btn hooks-btn-primary"
            onClick={() => openEditor({ kind: 'add' })}
          >
            <IconPlus size={14} />
            新增钩子
          </button>
        </div>
      </div>

      <div className="hooks-warning" role="note">
        <IconInfo size={15} />
        <span>钩子会以你的权限执行本机命令，只添加可信来源。PreToolUse 返回退出码 2 会阻断工具调用。</span>
      </div>

      {!connected ? (
        <div className="hooks-notice" role="status">与服务端断开连接，钩子操作可能无法保存。</div>
      ) : null}

      {toggleError ? (
        <div className="hooks-inline-error" role="alert">{toggleError}</div>
      ) : null}

      {items.length === 0 ? (
        <div className="hooks-empty">
          <div className="hooks-empty-title">还没有钩子</div>
          <div className="hooks-empty-hint">新增后可在工具调用、回合结束或会话开始时执行本机命令。</div>
          <button
            type="button"
            className="hooks-btn hooks-btn-primary"
            onClick={() => openEditor({ kind: 'add' })}
          >
            <IconPlus size={14} />
            新增钩子
          </button>
        </div>
      ) : (
        <div className="hooks-list" role="list" aria-label="钩子列表">
          {items.map((hook) => (
            <div className="hooks-row" role="listitem" key={hook.id}>
              <div className="hooks-row-main">
                <div className="hooks-row-title">
                  <span className="hooks-row-name">{hook.name}</span>
                  <span className={`hooks-event-tag hooks-event-${hook.event.toLowerCase()}`} title={EVENT_LABEL[hook.event]}>
                    {hook.event}
                  </span>
                  {hook.matcher ? <code className="hooks-matcher">{hook.matcher}</code> : null}
                </div>
                <code className="hooks-row-command" title={hook.command}>{commandSummary(hook.command)}</code>
              </div>
              <div className="hooks-row-actions">
                <Switch
                  checked={hook.enabled}
                  disabled={!connected || togglingId !== null}
                  label={`${hook.enabled ? '停用' : '启用'}钩子 ${hook.name}`}
                  onChange={() => void toggleEnabled(hook)}
                />
                <button
                  type="button"
                  className="hooks-icon-btn"
                  aria-label={`编辑钩子 ${hook.name}`}
                  title="编辑"
                  onClick={() => openEditor({ kind: 'edit', hook })}
                >
                  <EditGlyph />
                </button>
                <button
                  type="button"
                  className="hooks-icon-btn danger"
                  aria-label={`删除钩子 ${hook.name}`}
                  title="删除"
                  disabled={!connected || deletingId !== null}
                  onClick={() => openConfirm(hook.id)}
                >
                  <TrashGlyph />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editor ? (
        <div
          className="hooks-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) closeEditor();
          }}
        >
          <div className="hooks-modal" role="dialog" aria-modal="true" aria-labelledby="hooks-editor-title">
            <form className="hooks-modal-form" noValidate onSubmit={(event) => void submit(event)}>
              <header className="hooks-modal-head">
                <div>
                  <h3 id="hooks-editor-title">
                    {editor.kind === 'add' ? '新增钩子' : `编辑钩子 ${editor.hook.name}`}
                  </h3>
                  <p>钩子会以你的权限执行本机命令，请确认命令来源可信。</p>
                </div>
                <button
                  type="button"
                  className="hooks-icon-btn"
                  aria-label="关闭编辑器"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  <IconX size={16} />
                </button>
              </header>

              <div className="hooks-modal-body">
                <label className="hooks-field" htmlFor="hooks-name">
                  <span className="hooks-field-label">名称</span>
                  <input
                    id="hooks-name"
                    ref={nameRef}
                    className="hooks-input"
                    value={form.name}
                    aria-invalid={Boolean(formError)}
                    aria-describedby={formError ? 'hooks-form-error' : undefined}
                    placeholder="例如 format-on-save"
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, name: event.target.value }));
                      if (formError) setFormError('');
                    }}
                  />
                </label>

                <label className="hooks-field" htmlFor="hooks-event">
                  <span className="hooks-field-label">事件</span>
                  <select
                    id="hooks-event"
                    className="hooks-input hooks-select"
                    value={form.event}
                    onChange={(event) => {
                      const nextEvent = event.target.value as HookEvent;
                      setForm((prev) => ({
                        ...prev,
                        event: nextEvent,
                        matcher: isToolEvent(nextEvent) ? prev.matcher : '',
                      }));
                    }}
                  >
                    {EVENTS.map((event) => (
                      <option key={event} value={event}>{event} · {EVENT_LABEL[event]}</option>
                    ))}
                  </select>
                </label>

                <label className="hooks-field" htmlFor="hooks-matcher">
                  <span className="hooks-field-label">Matcher（仅工具事件可用）</span>
                  <input
                    id="hooks-matcher"
                    className="hooks-input hooks-mono"
                    value={form.matcher}
                    disabled={!isToolEvent(form.event)}
                    placeholder="write_*"
                    spellCheck={false}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, matcher: event.target.value }))
                    }
                  />
                  <span className="hooks-field-hint">留空匹配全部工具，支持 write_* 形式的通配。</span>
                </label>

                <label className="hooks-field" htmlFor="hooks-command">
                  <span className="hooks-field-label">命令</span>
                  <textarea
                    id="hooks-command"
                    className="hooks-textarea"
                    value={form.command}
                    spellCheck={false}
                    placeholder={'例如 npm run lint'}
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, command: event.target.value }));
                      if (formError) setFormError('');
                    }}
                  />
                  <span className="hooks-field-hint">
                    {form.event === 'PreToolUse'
                      ? 'PreToolUse 返回退出码 2 会阻断本次工具调用。'
                      : '命令在对应生命周期由本机执行。'}
                  </span>
                </label>

                <label className="hooks-field" htmlFor="hooks-timeout">
                  <span className="hooks-field-label">超时（毫秒）</span>
                  <input
                    id="hooks-timeout"
                    className="hooks-input hooks-mono"
                    type="number"
                    min={MIN_TIMEOUT}
                    max={MAX_TIMEOUT}
                    step={1}
                    value={form.timeoutMs}
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, timeoutMs: event.target.value }));
                      if (formError) setFormError('');
                    }}
                  />
                  <span className="hooks-field-hint">范围 {MIN_TIMEOUT}–{MAX_TIMEOUT}ms。</span>
                </label>

                <div className="hooks-toggle-row">
                  <span className="hooks-field-label">启用</span>
                  <Switch
                    checked={form.enabled}
                    disabled={saving}
                    label="启用钩子"
                    onChange={(next) => setForm((prev) => ({ ...prev, enabled: next }))}
                  />
                </div>

                {formError ? (
                  <p className="hooks-form-error" id="hooks-form-error" role="alert">{formError}</p>
                ) : null}
              </div>

              <footer className="hooks-modal-actions">
                <button type="button" className="hooks-btn" disabled={saving} onClick={closeEditor}>
                  取消
                </button>
                <button
                  type="submit"
                  className="hooks-btn hooks-btn-primary"
                  disabled={saving || !connected}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}

      {confirmDeleteId ? (
        <div
          className="hooks-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && deletingId === null) closeConfirm();
          }}
        >
          <div
            className="hooks-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="hooks-confirm-title"
            aria-describedby="hooks-confirm-desc"
          >
            <h4 id="hooks-confirm-title">删除钩子</h4>
            <p id="hooks-confirm-desc">
              确定删除「{pendingDelete?.name ?? ''}」吗？此操作不可撤销。
            </p>
            {deleteError ? (
              <p className="hooks-confirm-error" role="alert">{deleteError}</p>
            ) : null}
            <div className="hooks-confirm-actions">
              <button
                ref={confirmCancelRef}
                type="button"
                className="hooks-btn"
                disabled={deletingId !== null}
                onClick={closeConfirm}
              >
                取消
              </button>
              <button
                type="button"
                className="hooks-btn hooks-btn-danger"
                disabled={deletingId !== null}
                onClick={() => void confirmDelete()}
              >
                {deletingId !== null ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
