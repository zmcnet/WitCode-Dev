import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SlashCommand } from '@witcode/protocol';
import { IconPlus, IconX } from '../../icons';
import './commands.css';

export interface CommandsPanelProps {
  items: SlashCommand[];
  connected: boolean;
  onRefresh(): void;
  onSave(command: SlashCommand): Promise<void>;
  onDelete(name: string): Promise<void>;
}

/** null 表示关闭；add 为新增，edit 携带原始命令。 */
type EditorState = { kind: 'add' } | { kind: 'edit'; command: SlashCommand } | null;

interface CommandForm {
  name: string;
  description: string;
  prompt: string;
}

function emptyForm(): CommandForm {
  return { name: '', description: '', prompt: '' };
}

function formFromCommand(command: SlashCommand): CommandForm {
  return { name: command.name, description: command.description, prompt: command.prompt };
}

/** 命令名只允许字母、数字、- 与 _。 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function validate(form: CommandForm, items: SlashCommand[], editingName: string | null): string {
  const name = form.name.trim();
  if (!name) return '请输入命令名称';
  if (!NAME_PATTERN.test(name)) return '命令名称只允许字母、数字、- 与 _';
  if (name !== editingName && items.some((item) => item.name === name)) {
    return `命令 /${name} 已存在`;
  }
  return '';
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

export function CommandsPanel({ items, connected, onRefresh, onSave, onDelete }: CommandsPanelProps): JSX.Element {
  const [editor, setEditor] = useState<EditorState>(null);
  const [form, setForm] = useState<CommandForm>(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const pendingDelete = confirmDeleteName
    ? items.find((item) => item.name === confirmDeleteName) ?? null
    : null;

  function openEditor(next: Exclude<EditorState, null>) {
    editorTriggerRef.current = document.activeElement as HTMLElement | null;
    setForm(next.kind === 'add' ? emptyForm() : formFromCommand(next.command));
    setFormError('');
    setEditor(next);
  }

  function closeEditor() {
    setEditor(null);
    setFormError('');
    requestAnimationFrame(() => editorTriggerRef.current?.focus());
  }

  function openConfirm(name: string) {
    confirmTriggerRef.current = document.activeElement as HTMLElement | null;
    setDeleteError('');
    setConfirmDeleteName(name);
  }

  function closeConfirm() {
    setConfirmDeleteName(null);
    setDeleteError('');
    requestAnimationFrame(() => confirmTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (editor) nameRef.current?.focus();
  }, [editor]);

  useEffect(() => {
    if (confirmDeleteName) confirmCancelRef.current?.focus();
  }, [confirmDeleteName]);

  // Esc 先关闭删除确认，再关闭编辑器；保存/删除进行中不允许关闭。
  useEffect(() => {
    if (!editor && !confirmDeleteName) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmDeleteName) {
        if (deletingName !== null) return;
        setConfirmDeleteName(null);
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
  }, [editor, confirmDeleteName, saving, deletingName]);

  useEffect(() => {
    if (confirmDeleteName && !items.some((item) => item.name === confirmDeleteName)) {
      setConfirmDeleteName(null);
      setDeleteError('');
    }
  }, [items, confirmDeleteName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving) return;
    const error = validate(
      form,
      items,
      editor.kind === 'edit' ? editor.command.name : null,
    );
    if (error) {
      setFormError(error);
      return;
    }
    const command: SlashCommand = {
      name: form.name.trim(),
      description: form.description.trim(),
      prompt: form.prompt,
    };

    setSaving(true);
    setFormError('');
    try {
      await onSave(command);
      closeEditor();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!confirmDeleteName || deletingName !== null) return;
    const name = confirmDeleteName;
    setDeletingName(name);
    setDeleteError('');
    try {
      await onDelete(name);
      setConfirmDeleteName(null);
      requestAnimationFrame(() => editorTriggerRef.current?.focus());
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <section className="commands-panel" aria-label="斜杠命令管理">
      <div className="commands-head">
        <div>
          <h2 className="commands-title">斜杠命令</h2>
          <p className="commands-desc">管理在输入框中以 / 调用的自定义命令</p>
        </div>
        <div className="commands-head-actions">
          <button
            type="button"
            className="commands-icon-btn"
            aria-label="刷新命令列表"
            title="刷新"
            onClick={onRefresh}
          >
            <RefreshGlyph />
          </button>
          <button
            type="button"
            className="commands-btn commands-btn-primary"
            onClick={() => openEditor({ kind: 'add' })}
          >
            <IconPlus size={14} />
            新增命令
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="commands-notice" role="status">与服务端断开连接，命令操作可能无法保存。</div>
      ) : null}

      {items.length === 0 ? (
        <div className="commands-empty">
          <div className="commands-empty-title">还没有自定义命令</div>
          <div className="commands-empty-hint">新增后可在对话输入框输入 /name 调用。</div>
          <button
            type="button"
            className="commands-btn commands-btn-primary"
            onClick={() => openEditor({ kind: 'add' })}
          >
            <IconPlus size={14} />
            新增命令
          </button>
        </div>
      ) : (
        <div className="commands-list" role="list" aria-label="命令列表">
          {items.map((command) => (
            <div className="commands-row" role="listitem" key={command.name}>
              <div className="commands-row-main">
                <div className="commands-row-title">
                  <code className="commands-name">/{command.name}</code>
                </div>
                <p className="commands-row-desc">{command.description}</p>
              </div>
              <div className="commands-row-actions">
                <button
                  type="button"
                  className="commands-icon-btn"
                  aria-label={`编辑命令 /${command.name}`}
                  title="编辑"
                  onClick={() => openEditor({ kind: 'edit', command })}
                >
                  <EditGlyph />
                </button>
                <button
                  type="button"
                  className="commands-icon-btn danger"
                  aria-label={`删除命令 /${command.name}`}
                  title="删除"
                  disabled={!connected || deletingName !== null}
                  onClick={() => openConfirm(command.name)}
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
          className="commands-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) closeEditor();
          }}
        >
          <div className="commands-modal" role="dialog" aria-modal="true" aria-labelledby="commands-editor-title">
            <form className="commands-modal-form" noValidate onSubmit={(event) => void submit(event)}>
              <header className="commands-modal-head">
                <div>
                  <h3 id="commands-editor-title">
                    {editor.kind === 'add' ? '新增命令' : `编辑 /${editor.command.name}`}
                  </h3>
                  <p>名称只允许字母、数字、- 与 _，调用时使用 /name。</p>
                </div>
                <button
                  type="button"
                  className="commands-icon-btn"
                  aria-label="关闭编辑器"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  <IconX size={16} />
                </button>
              </header>

              <div className="commands-modal-body">
                <label className="commands-field" htmlFor="commands-name">
                  <span className="commands-field-label">名称</span>
                  <input
                    id="commands-name"
                    ref={nameRef}
                    className="commands-input"
                    value={form.name}
                    aria-invalid={Boolean(formError)}
                    aria-describedby={formError ? 'commands-form-error' : undefined}
                    placeholder="例如 review"
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, name: event.target.value }));
                      if (formError) setFormError('');
                    }}
                  />
                </label>

                <label className="commands-field" htmlFor="commands-description">
                  <span className="commands-field-label">描述</span>
                  <input
                    id="commands-description"
                    className="commands-input"
                    value={form.description}
                    placeholder="一句话说明命令的用途"
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, description: event.target.value }))
                    }
                  />
                </label>

                <label className="commands-field" htmlFor="commands-prompt">
                  <span className="commands-field-label">提示词</span>
                  <textarea
                    id="commands-prompt"
                    className="commands-textarea"
                    value={form.prompt}
                    spellCheck={false}
                    placeholder={'请按以下步骤完成任务：\n1. ...'}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, prompt: event.target.value }))
                    }
                  />
                </label>

                {formError ? (
                  <p className="commands-form-error" id="commands-form-error" role="alert">{formError}</p>
                ) : null}
              </div>

              <footer className="commands-modal-actions">
                <button type="button" className="commands-btn" disabled={saving} onClick={closeEditor}>
                  取消
                </button>
                <button
                  type="submit"
                  className="commands-btn commands-btn-primary"
                  disabled={saving || !connected}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}

      {confirmDeleteName ? (
        <div
          className="commands-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && deletingName === null) closeConfirm();
          }}
        >
          <div
            className="commands-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="commands-confirm-title"
            aria-describedby="commands-confirm-desc"
          >
            <h4 id="commands-confirm-title">删除命令</h4>
            <p id="commands-confirm-desc">
              确定删除 /{pendingDelete?.name ?? confirmDeleteName} 吗？此操作不可撤销。
            </p>
            {deleteError ? (
              <p className="commands-confirm-error" role="alert">{deleteError}</p>
            ) : null}
            <div className="commands-confirm-actions">
              <button
                ref={confirmCancelRef}
                type="button"
                className="commands-btn"
                disabled={deletingName !== null}
                onClick={closeConfirm}
              >
                取消
              </button>
              <button
                type="button"
                className="commands-btn commands-btn-danger"
                disabled={deletingName !== null}
                onClick={() => void confirmDelete()}
              >
                {deletingName !== null ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
