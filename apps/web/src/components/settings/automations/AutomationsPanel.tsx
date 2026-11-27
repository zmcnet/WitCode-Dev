import { useEffect, useRef, useState } from 'react';
import type { AutomationInput, AutomationPublic } from '@witcode/protocol';
import { IconCheck, IconClock, IconPlus, IconSettings, IconX } from '../../icons';
import './automations.css';

export interface AutomationsPanelProps {
  items: AutomationPublic[];
  connected: boolean;
  onRefresh(): void;
  onSave(input: AutomationInput): Promise<void>;
  onDelete(id: string): Promise<void>;
  onRun(id: string): Promise<void>;
}

type EditorState = { kind: 'create' } | { kind: 'edit'; item: AutomationPublic };

interface FormState {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { name: '', schedule: '', prompt: '', enabled: true };
const SCHEDULE_HINT = '支持 every 30m / every 2h / daily 09:30';

/** 前端基本校验：every <n><s|m|h|d> 或 daily HH:mm。 */
function validateSchedule(value: string): string | null {
  const text = value.trim();
  if (!text) return '请填写调度规则。';

  const every = /^every\s+(\d+)\s*([smhd])$/i.exec(text);
  if (every) {
    return Number(every[1]) > 0 ? null : '间隔必须大于 0。';
  }

  const daily = /^daily\s+(\d{1,2}):(\d{2})$/i.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    return hour <= 23 && minute <= 59 ? null : '时间需在 00:00–23:59 之间。';
  }

  return '格式不正确，应为 every 30m 或 daily 09:30。';
}

function formatTime(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function PlayGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4.5 19 12 7 19.5Z" />
    </svg>
  );
}

function RefreshGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.4" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </svg>
  );
}

function StatusTag({ status }: { status?: AutomationPublic['lastStatus'] }) {
  if (!status || status === 'ok' || status === 'error' || status === 'running') {
    const label = status === 'ok' ? '成功' : status === 'error' ? '失败' : status === 'running' ? '运行中' : '未运行';
    const variant = status ?? 'none';
    return <span className={`automations-tag automations-tag-${variant}`}>{label}</span>;
  }
  return <span className="automations-tag">未运行</span>;
}

function Switch({
  checked,
  disabled,
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
      className={checked ? 'automations-switch on' : 'automations-switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="automations-switch-thumb" aria-hidden="true" />
    </button>
  );
}

function Skeleton() {
  return (
    <div className="automations-skeleton" role="status" aria-label="正在加载自动化任务">
      {[0, 1, 2].map((index) => (
        <div className="automations-skeleton-row" key={index}>
          <span className="automations-skeleton-lines">
            <span className="automations-skeleton-line" />
            <span className="automations-skeleton-line short" />
          </span>
          <span className="automations-skeleton-tag" />
        </div>
      ))}
    </div>
  );
}

export function AutomationsPanel(props: AutomationsPanelProps): JSX.Element {
  const { items, connected, onRefresh, onSave, onDelete, onRun } = props;

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const nameInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);

  const busy = saving || runningId !== null || togglingId !== null || deletingId !== null;

  useEffect(() => {
    if (!editor) return;
    nameInputRef.current?.focus();
  }, [editor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editor) {
        if (!saving) setEditor(null);
      } else if (confirmDeleteId && !deletingId) {
        setConfirmDeleteId(null);
      }
    };
    if (editor || confirmDeleteId) {
      document.addEventListener('keydown', onKeyDown);
      return () => document.removeEventListener('keydown', onKeyDown);
    }
  }, [editor, saving, confirmDeleteId, deletingId]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  }

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (formError) setFormError('');
  }

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setFormError('');
    setEditor({ kind: 'create' });
  }

  function openEdit(item: AutomationPublic) {
    setForm({ name: item.name, schedule: item.schedule, prompt: item.prompt, enabled: item.enabled });
    setFormError('');
    setEditor({ kind: 'edit', item });
  }

  async function submit() {
    if (saving) return;
    const name = form.name.trim();
    const schedule = form.schedule.trim();
    const prompt = form.prompt.trim();

    if (!name) {
      setFormError('请填写名称。');
      return;
    }
    const scheduleError = validateSchedule(schedule);
    if (scheduleError) {
      setFormError(scheduleError);
      return;
    }
    if (!prompt) {
      setFormError('请填写提示词。');
      return;
    }

    const input: AutomationInput = { name, schedule, prompt, enabled: form.enabled };
    if (editor?.kind === 'edit') input.id = editor.item.id;

    setSaving(true);
    setFormError('');
    try {
      await onSave(input);
      setEditor(null);
      showToast(editor?.kind === 'edit' ? '自动化已更新' : '自动化已添加');
      onRefresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function handleRun(item: AutomationPublic) {
    if (busy || item.lastStatus === 'running') return;
    setRunningId(item.id);
    try {
      await onRun(item.id);
      showToast(`已触发 ${item.name}`);
      onRefresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '运行失败，请重试。');
    } finally {
      setRunningId(null);
    }
  }

  async function handleToggle(item: AutomationPublic, next: boolean) {
    if (busy) return;
    setTogglingId(item.id);
    const input: AutomationInput = {
      id: item.id,
      name: item.name,
      prompt: item.prompt,
      schedule: item.schedule,
      enabled: next,
    };
    try {
      await onSave(input);
      showToast(next ? `已启用 ${item.name}` : `已停用 ${item.name}`);
      onRefresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '更新状态失败，请重试。');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(item: AutomationPublic) {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      await onDelete(item.id);
      setConfirmDeleteId(null);
      showToast(`已删除 ${item.name}`);
      onRefresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      setDeletingId(null);
    }
  }

  function renderRow(item: AutomationPublic) {
    const confirming = confirmDeleteId === item.id;
    const rowRunning = item.lastStatus === 'running';
    const rowBusy = busy || confirming;

    return (
      <div className="automations-row" key={item.id}>
        <div className="automations-row-main">
          <div className="automations-row-title">
            <span className="automations-row-name">{item.name}</span>
            <span className="automations-schedule-tag" title="调度规则">{item.schedule}</span>
            <StatusTag status={item.lastStatus} />
          </div>
          <div className="automations-row-meta">
            <span><IconClock size={12} /> 下次运行 {formatTime(item.nextRun)}</span>
            <span>上次运行 {formatTime(item.lastRun)}</span>
          </div>
          <code className="automations-prompt" title={item.prompt}>{item.prompt || '—'}</code>
          {item.lastStatus === 'error' && item.lastError ? (
            <p className="automations-error" role="alert">{item.lastError}</p>
          ) : null}
          {confirming ? (
            <div className="automations-confirm" role="alertdialog" aria-label={`确认删除 ${item.name}`}>
              <span className="automations-confirm-text">确定删除「{item.name}」？此操作不可撤销。</span>
              <div className="automations-confirm-actions">
                <button
                  type="button"
                  className="automations-btn"
                  disabled={deletingId !== null}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="automations-btn automations-btn-danger"
                  disabled={deletingId !== null}
                  onClick={() => void handleDelete(item)}
                >
                  {deletingId === item.id ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="automations-row-side">
          <div className="automations-row-toggle">
            <span>启用</span>
            <Switch
              checked={item.enabled}
              disabled={rowBusy}
              label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
              onChange={(next) => void handleToggle(item, next)}
            />
          </div>
          <div className="automations-row-actions">
            <button
              type="button"
              className="automations-btn"
              disabled={rowBusy || rowRunning}
              title={rowRunning ? '正在运行' : '运行'}
              onClick={() => void handleRun(item)}
            >
              <PlayGlyph />
              {runningId === item.id ? '运行中…' : rowRunning ? '运行中' : '运行'}
            </button>
            <button
              type="button"
              className="automations-btn"
              disabled={rowBusy}
              title="编辑"
              onClick={() => openEdit(item)}
            >
              <IconSettings size={14} />
              编辑
            </button>
            <button
              type="button"
              className="automations-btn automations-btn-danger"
              disabled={rowBusy}
              title="删除"
              onClick={() => setConfirmDeleteId(item.id)}
            >
              <TrashGlyph />
              删除
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="automations-panel" aria-label="自动化任务管理">
      <div className="automations-head">
        <div>
          <h2 className="automations-title">自动化</h2>
          <p className="automations-desc">按时间自动把提示词交给智能体执行</p>
        </div>
        <div className="automations-head-actions">
          <button
            type="button"
            className="automations-icon-btn"
            aria-label="刷新自动化列表"
            title="刷新"
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshGlyph />
          </button>
          <button
            type="button"
            className="automations-btn automations-btn-primary"
            disabled={busy}
            onClick={openCreate}
          >
            <IconPlus size={14} />
            新增
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="automations-notice" role="status">与服务端断开连接，自动化操作可能无法保存。</div>
      ) : null}
      {toast ? <div className="automations-toast" role="status">{toast}</div> : null}

      {!connected && items.length === 0 ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <div className="automations-empty">
          <div className="automations-empty-title">还没有自动化任务</div>
          <div className="automations-empty-hint">新增一条任务后，智能体会按设定的时间自动执行提示词。</div>
          <button type="button" className="automations-btn automations-btn-primary" onClick={openCreate}>
            <IconPlus size={14} />
            新增自动化
          </button>
        </div>
      ) : (
        <div className="automations-list">{items.map(renderRow)}</div>
      )}

      {editor ? (
        <div
          className="automations-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setEditor(null);
          }}
        >
          <div className="automations-modal" role="dialog" aria-modal="true" aria-labelledby="automations-modal-title">
            <div className="automations-modal-head">
              <h3 className="automations-modal-title" id="automations-modal-title">
                {editor.kind === 'create' ? '新增自动化' : '编辑自动化'}
              </h3>
              <button
                type="button"
                className="automations-icon-btn"
                aria-label="关闭窗口"
                disabled={saving}
                onClick={() => setEditor(null)}
              >
                <IconX size={15} />
              </button>
            </div>
            <div className="automations-modal-body">
              <label className="automations-field">
                <span className="automations-label">名称</span>
                <input
                  ref={nameInputRef}
                  className="automations-input"
                  value={form.name}
                  disabled={saving}
                  placeholder="例如：每日晨报"
                  onChange={(event) => updateForm('name', event.target.value)}
                />
              </label>

              <label className="automations-field">
                <span className="automations-label">调度规则</span>
                <input
                  className="automations-input automations-mono"
                  value={form.schedule}
                  disabled={saving}
                  spellCheck={false}
                  placeholder="every 30m / daily 09:30"
                  onChange={(event) => updateForm('schedule', event.target.value)}
                />
                <span className="automations-hint">{SCHEDULE_HINT}</span>
              </label>

              <label className="automations-field">
                <span className="automations-label">提示词</span>
                <textarea
                  className="automations-textarea automations-mono"
                  value={form.prompt}
                  disabled={saving}
                  spellCheck={false}
                  rows={5}
                  placeholder="到时间后交给智能体执行的提示词内容"
                  onChange={(event) => updateForm('prompt', event.target.value)}
                />
              </label>

              <div className="automations-enabled">
                <span className="automations-label">启用此自动化</span>
                <Switch
                  checked={form.enabled}
                  disabled={saving}
                  label="启用此自动化"
                  onChange={(next) => updateForm('enabled', next)}
                />
              </div>

              {formError ? <p className="automations-form-error" role="alert">{formError}</p> : null}
            </div>
            <div className="automations-modal-actions">
              <button type="button" className="automations-btn" disabled={saving} onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="button"
                className="automations-btn automations-btn-primary"
                disabled={saving}
                onClick={() => void submit()}
              >
                {saving ? (
                  '保存中…'
                ) : (
                  <>
                    <IconCheck size={14} />
                    保存
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
