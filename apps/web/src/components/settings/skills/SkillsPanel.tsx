import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SkillSummary } from '@witcode/protocol';
import { IconPlus, IconX } from '../../icons';
import './skills.css';

export interface SkillsPanelProps {
  items: SkillSummary[];
  connected: boolean;
  onRefresh(): void;
  onSave(skill: SkillSummary): Promise<void>;
  onDelete(id: string): Promise<void>;
}

/** null 表示关闭；add 为新增，edit 携带原始技能。 */
type EditorState = { kind: 'add' } | { kind: 'edit'; skill: SkillSummary } | null;

interface SkillForm {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}

function emptyForm(): SkillForm {
  return { name: '', description: '', content: '', enabled: true };
}

function formFromSkill(skill: SkillSummary): SkillForm {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    enabled: skill.enabled,
  };
}

/** 为新增技能生成可读且不与现有项冲突的 id。 */
function makeSkillId(name: string, items: SkillSummary[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill';
  const used = new Set(items.map((item) => item.id));
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
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

export function SkillsPanel({ items, connected, onRefresh, onSave, onDelete }: SkillsPanelProps): JSX.Element {
  const [editor, setEditor] = useState<EditorState>(null);
  const [form, setForm] = useState<SkillForm>(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const confirmTriggerRef = useRef<HTMLElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const pendingDelete = confirmDeleteId
    ? items.find((item) => item.id === confirmDeleteId) ?? null
    : null;

  function openEditor(next: Exclude<EditorState, null>) {
    editorTriggerRef.current = document.activeElement as HTMLElement | null;
    setForm(next.kind === 'add' ? emptyForm() : formFromSkill(next.skill));
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving) return;
    const name = form.name.trim();
    if (!name) {
      setFormError('请输入技能名称');
      return;
    }
    const skill: SkillSummary =
      editor.kind === 'edit'
        ? {
            ...editor.skill,
            name,
            description: form.description.trim(),
            content: form.content,
            enabled: form.enabled,
          }
        : {
            id: makeSkillId(name, items),
            name,
            description: form.description.trim(),
            content: form.content,
            enabled: form.enabled,
          };

    setSaving(true);
    setFormError('');
    try {
      await onSave(skill);
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
      requestAnimationFrame(() => editorTriggerRef.current?.focus());
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="skills-panel" aria-label="技能管理">
      <div className="skills-head">
        <div>
          <h2 className="skills-title">技能</h2>
          <p className="skills-desc">管理可复用的提示词技能与 SKILL.md 内容</p>
        </div>
        <div className="skills-head-actions">
          <button
            type="button"
            className="skills-icon-btn"
            aria-label="刷新技能列表"
            title="刷新"
            onClick={onRefresh}
          >
            <RefreshGlyph />
          </button>
          <button
            type="button"
            className="skills-btn skills-btn-primary"
            onClick={() => openEditor({ kind: 'add' })}
          >
            <IconPlus size={14} />
            新增技能
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="skills-notice" role="status">与服务端断开连接，技能操作可能无法保存。</div>
      ) : null}

      {items.length === 0 ? (
        <div className="skills-empty">
          <div className="skills-empty-title">还没有技能</div>
          <div className="skills-empty-hint">新增技能后，可在对话中按需使用它。</div>
          <button
            type="button"
            className="skills-btn skills-btn-primary"
            onClick={() => openEditor({ kind: 'add' })}
          >
            <IconPlus size={14} />
            新增技能
          </button>
        </div>
      ) : (
        <div className="skills-list" role="list" aria-label="技能列表">
          {items.map((skill) => (
            <div className="skills-row" role="listitem" key={skill.id}>
              <div className="skills-row-main">
                <div className="skills-row-title">
                  <span className="skills-row-name">{skill.name}</span>
                  <span className={skill.enabled ? 'skills-tag on' : 'skills-tag'}>
                    {skill.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <p className="skills-row-desc">{skill.description}</p>
              </div>
              <div className="skills-row-actions">
                <button
                  type="button"
                  className="skills-icon-btn"
                  aria-label={`编辑技能 ${skill.name}`}
                  title="编辑"
                  onClick={() => openEditor({ kind: 'edit', skill })}
                >
                  <EditGlyph />
                </button>
                <button
                  type="button"
                  className="skills-icon-btn danger"
                  aria-label={`删除技能 ${skill.name}`}
                  title="删除"
                  disabled={!connected || deletingId !== null}
                  onClick={() => openConfirm(skill.id)}
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
          className="skills-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) closeEditor();
          }}
        >
          <div className="skills-modal" role="dialog" aria-modal="true" aria-labelledby="skills-editor-title">
            <form className="skills-modal-form" noValidate onSubmit={(event) => void submit(event)}>
              <header className="skills-modal-head">
                <div>
                  <h3 id="skills-editor-title">
                    {editor.kind === 'add' ? '新增技能' : `编辑「${editor.skill.name}」`}
                  </h3>
                  <p>技能由名称、描述与 SKILL.md 内容组成。</p>
                </div>
                <button
                  type="button"
                  className="skills-icon-btn"
                  aria-label="关闭编辑器"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  <IconX size={16} />
                </button>
              </header>

              <div className="skills-modal-body">
                <label className="skills-field" htmlFor="skills-name">
                  <span className="skills-field-label">名称</span>
                  <input
                    id="skills-name"
                    ref={nameRef}
                    className="skills-input"
                    value={form.name}
                    aria-invalid={formError && !form.name.trim() ? true : undefined}
                    placeholder="例如 code-review"
                    onChange={(event) => {
                      setForm((prev) => ({ ...prev, name: event.target.value }));
                      if (formError) setFormError('');
                    }}
                  />
                </label>

                <label className="skills-field" htmlFor="skills-description">
                  <span className="skills-field-label">描述</span>
                  <input
                    id="skills-description"
                    className="skills-input"
                    value={form.description}
                    placeholder="一句话说明技能的用途"
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, description: event.target.value }))
                    }
                  />
                </label>

                <div className="skills-toggle-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.enabled}
                    aria-label="启用该技能"
                    className={form.enabled ? 'skills-switch on' : 'skills-switch'}
                    onClick={() => setForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
                  >
                    <span className="skills-switch-thumb" aria-hidden="true" />
                  </button>
                  <span>启用该技能</span>
                </div>

                <label className="skills-field" htmlFor="skills-content">
                  <span className="skills-field-label">内容（SKILL.md）</span>
                  <textarea
                    id="skills-content"
                    className="skills-textarea"
                    value={form.content}
                    spellCheck={false}
                    placeholder={'# 技能标题\n\n在这里编写技能提示词。'}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, content: event.target.value }))
                    }
                  />
                </label>

                {formError ? (
                  <p className="skills-form-error" role="alert">{formError}</p>
                ) : null}
              </div>

              <footer className="skills-modal-actions">
                <button type="button" className="skills-btn" disabled={saving} onClick={closeEditor}>
                  取消
                </button>
                <button
                  type="submit"
                  className="skills-btn skills-btn-primary"
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
          className="skills-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && deletingId === null) closeConfirm();
          }}
        >
          <div
            className="skills-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="skills-confirm-title"
            aria-describedby="skills-confirm-desc"
          >
            <h4 id="skills-confirm-title">删除技能</h4>
            <p id="skills-confirm-desc">
              确定删除「{pendingDelete?.name ?? confirmDeleteId}」吗？此操作不可撤销。
            </p>
            {deleteError ? (
              <p className="skills-confirm-error" role="alert">{deleteError}</p>
            ) : null}
            <div className="skills-confirm-actions">
              <button
                ref={confirmCancelRef}
                type="button"
                className="skills-btn"
                disabled={deletingId !== null}
                onClick={closeConfirm}
              >
                取消
              </button>
              <button
                type="button"
                className="skills-btn skills-btn-danger"
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
