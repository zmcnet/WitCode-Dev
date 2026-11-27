import { useEffect, useRef, useState } from 'react';
import type { McpServerInput, McpServerPublic } from '@witcode/protocol';
import { IconCheck, IconInfo, IconPlus, IconSettings, IconX } from '../../icons';
import './mcp.css';

export interface McpPanelProps {
  items: McpServerPublic[];
  connected: boolean;
  onRefresh(): void;
  onSave(server: McpServerInput): Promise<void>;
  onDelete(id: string): Promise<void>;
  onReconnect(id: string): Promise<void>;
}

type EditorState = { kind: 'create' } | { kind: 'edit'; server: McpServerPublic };

interface FormState {
  name: string;
  command: string;
  argsText: string;
  envText: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  command: '',
  argsText: '',
  envText: '',
  enabled: true,
};

/** 参数支持逗号或换行分隔；空白项直接忽略。 */
function parseArgs(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 环境变量每行一条 KEY=VALUE；空行忽略，非法行给出明确报错。 */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) {
      throw new Error(`环境变量「${line}」格式不正确，应为 KEY=VALUE。`);
    }
    const key = line.slice(0, sep).trim();
    if (!key) {
      throw new Error(`环境变量「${line}」的 KEY 不能为空。`);
    }
    env[key] = line.slice(sep + 1).trim();
  }
  return env;
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

function StatusTag({ status }: { status: McpServerPublic['status'] }) {
  const label = status === 'connected' ? '已连接' : status === 'error' ? '失败' : '已停用';
  return <span className={`mcp-tag mcp-tag-${status}`}>{label}</span>;
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
      className={checked ? 'mcp-switch on' : 'mcp-switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="mcp-switch-thumb" aria-hidden="true" />
    </button>
  );
}

function Skeleton() {
  return (
    <div className="mcp-skeleton" role="status" aria-label="正在加载 MCP 服务器">
      {[0, 1, 2].map((index) => (
        <div className="mcp-skeleton-row" key={index}>
          <span className="mcp-skeleton-lines">
            <span className="mcp-skeleton-line" />
            <span className="mcp-skeleton-line short" />
          </span>
          <span className="mcp-skeleton-tag" />
        </div>
      ))}
    </div>
  );
}

export function McpPanel(props: McpPanelProps): JSX.Element {
  const { items, connected, onRefresh, onSave, onDelete, onReconnect } = props;

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const nameInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);

  const busy = saving || reconnectingId !== null || deletingId !== null;

  useEffect(() => {
    if (!editor) return;
    nameInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) setEditor(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editor, saving]);

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

  function openEdit(server: McpServerPublic) {
    setForm({
      name: server.name,
      command: server.command,
      argsText: server.args.join('\n'),
      // 公共信息只暴露变量名，不暴露变量值，保留变量名供重新填写。
      envText: server.envKeys.map((key) => `${key}=`).join('\n'),
      enabled: server.enabled,
    });
    setFormError('');
    setEditor({ kind: 'edit', server });
  }

  async function submit() {
    if (saving) return;
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name) {
      setFormError('请填写服务器名称。');
      return;
    }
    if (!command) {
      setFormError('请填写启动命令。');
      return;
    }

    let args: string[];
    let env: Record<string, string>;
    try {
      args = parseArgs(form.argsText);
      env = parseEnv(form.envText);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '参数或环境变量格式不正确。');
      return;
    }

    // 编辑时仅回显变量名，留空的变量视为“保留原值”，避免误清空已有密钥。
    if (editor?.kind === 'edit') {
      for (const [key, value] of Object.entries(env)) {
        if (value === '') delete env[key];
      }
    }

    const input: McpServerInput = {
      name,
      command,
      args,
      enabled: form.enabled,
    };
    if (editor?.kind === 'edit') input.id = editor.server.id;
    if (Object.keys(env).length > 0) input.env = env;

    setSaving(true);
    setFormError('');
    try {
      await onSave(input);
      setEditor(null);
      showToast(editor?.kind === 'edit' ? '服务器已更新' : '服务器已添加');
      onRefresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  async function handleReconnect(server: McpServerPublic) {
    if (busy) return;
    setReconnectingId(server.id);
    try {
      await onReconnect(server.id);
      showToast(`已重新连接 ${server.name}`);
      onRefresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重连失败，请重试。');
    } finally {
      setReconnectingId(null);
    }
  }

  async function handleDelete(server: McpServerPublic) {
    if (deletingId) return;
    setDeletingId(server.id);
    try {
      await onDelete(server.id);
      setConfirmDeleteId(null);
      showToast(`已删除 ${server.name}`);
      onRefresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      setDeletingId(null);
    }
  }

  function renderRow(server: McpServerPublic) {
    const rowBusy = busy || confirmDeleteId === server.id;
    const commandLine = [server.command, ...server.args].join(' ');
    const confirming = confirmDeleteId === server.id;

    return (
      <div className="mcp-row" key={server.id}>
        <div className="mcp-row-main">
          <div className="mcp-row-title">
            <span className="mcp-row-name">{server.name}</span>
            <StatusTag status={server.status} />
            <span className="mcp-tools">工具 {server.toolCount}</span>
          </div>
          <code className="mcp-command" title={commandLine}>{commandLine || '—'}</code>
          {server.status === 'error' && server.error ? (
            <p className="mcp-error" role="alert">{server.error}</p>
          ) : null}
          {confirming ? (
            <div className="mcp-confirm" role="alertdialog" aria-label={`确认删除 ${server.name}`}>
              <span className="mcp-confirm-text">确定删除「{server.name}」？此操作不可撤销。</span>
              <div className="mcp-confirm-actions">
                <button type="button" className="mcp-btn" disabled={deletingId !== null} onClick={() => setConfirmDeleteId(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="mcp-btn mcp-btn-danger"
                  disabled={deletingId !== null}
                  onClick={() => void handleDelete(server)}
                >
                  {deletingId === server.id ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="mcp-row-actions">
          <button
            type="button"
            className="mcp-btn"
            disabled={rowBusy}
            title="重新连接"
            onClick={() => void handleReconnect(server)}
          >
            <RefreshGlyph />
            {reconnectingId === server.id ? '重连中…' : '重连'}
          </button>
          <button
            type="button"
            className="mcp-btn"
            disabled={busy}
            title="编辑"
            onClick={() => openEdit(server)}
          >
            <IconSettings size={14} />
            编辑
          </button>
          <button
            type="button"
            className="mcp-btn mcp-btn-danger"
            disabled={busy}
            title="删除"
            onClick={() => setConfirmDeleteId(server.id)}
          >
            <TrashGlyph />
            删除
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="mcp-panel" aria-label="MCP 服务器管理">
      <div className="mcp-head">
        <div>
          <h2 className="mcp-title">MCP 服务器</h2>
          <p className="mcp-desc">配置通过 MCP 协议提供工具的本地服务器</p>
        </div>
        <div className="mcp-head-actions">
          <button
            type="button"
            className="mcp-icon-btn"
            aria-label="刷新 MCP 服务器列表"
            title="刷新"
            onClick={onRefresh}
          >
            <RefreshGlyph />
          </button>
          <button type="button" className="mcp-btn mcp-btn-primary" disabled={busy} onClick={openCreate}>
            <IconPlus size={14} />
            新增
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="mcp-notice" role="status">与服务端断开连接，MCP 操作可能无法保存。</div>
      ) : null}
      {toast ? <div className="mcp-toast" role="status">{toast}</div> : null}

      {!connected && items.length === 0 ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <div className="mcp-empty">
          <div className="mcp-empty-title">还没有 MCP 服务器</div>
          <div className="mcp-empty-hint">添加一个服务器后，它的工具会自动出现在会话中。</div>
          <button type="button" className="mcp-btn mcp-btn-primary" onClick={openCreate}>
            <IconPlus size={14} />
            新增服务器
          </button>
        </div>
      ) : (
        <div className="mcp-list">{items.map(renderRow)}</div>
      )}

      {editor ? (
        <div
          className="mcp-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setEditor(null);
          }}
        >
          <div className="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-modal-title">
            <div className="mcp-modal-head">
              <h3 className="mcp-modal-title" id="mcp-modal-title">
                {editor.kind === 'create' ? '新增 MCP 服务器' : '编辑 MCP 服务器'}
              </h3>
              <button
                type="button"
                className="mcp-icon-btn"
                aria-label="关闭窗口"
                disabled={saving}
                onClick={() => setEditor(null)}
              >
                <IconX size={15} />
              </button>
            </div>
            <div className="mcp-modal-body">
              <p className="mcp-warning">
                <IconInfo size={15} />
                MCP 服务器会以你的权限执行本机命令，只添加可信来源
              </p>

              <label className="mcp-field">
                <span className="mcp-label">名称</span>
                <input
                  ref={nameInputRef}
                  className="mcp-input"
                  value={form.name}
                  disabled={saving}
                  placeholder="例如：filesystem"
                  onChange={(event) => updateForm('name', event.target.value)}
                />
              </label>

              <label className="mcp-field">
                <span className="mcp-label">启动命令</span>
                <input
                  className="mcp-input mcp-mono"
                  value={form.command}
                  disabled={saving}
                  spellCheck={false}
                  placeholder="例如：npx 或 /usr/bin/python3"
                  onChange={(event) => updateForm('command', event.target.value)}
                />
              </label>

              <label className="mcp-field">
                <span className="mcp-label">参数</span>
                <textarea
                  className="mcp-textarea"
                  value={form.argsText}
                  disabled={saving}
                  spellCheck={false}
                  rows={3}
                  placeholder={'每行一个参数，也可用逗号分隔\n例如：-y\n@modelcontextprotocol/server-filesystem'}
                  onChange={(event) => updateForm('argsText', event.target.value)}
                />
                <span className="mcp-hint">逗号或换行分隔，空行会被忽略。</span>
              </label>

              <label className="mcp-field">
                <span className="mcp-label">环境变量</span>
                <textarea
                  className="mcp-textarea"
                  value={form.envText}
                  disabled={saving}
                  spellCheck={false}
                  rows={4}
                  placeholder={'KEY=VALUE\nAPI_TOKEN=xxxx'}
                  onChange={(event) => updateForm('envText', event.target.value)}
                />
                <span className="mcp-hint">
                  {editor.kind === 'edit'
                    ? '每行一个 KEY=VALUE；原有变量值不会回显，留空表示保留原值。'
                    : '每行一个 KEY=VALUE，可留空。'}
                </span>
              </label>

              <div className="mcp-enabled">
                <span className="mcp-label">启用此服务器</span>
                <Switch
                  checked={form.enabled}
                  disabled={saving}
                  label="启用此服务器"
                  onChange={(next) => updateForm('enabled', next)}
                />
              </div>

              {formError ? <p className="mcp-form-error" role="alert">{formError}</p> : null}
            </div>
            <div className="mcp-modal-actions">
              <button type="button" className="mcp-btn" disabled={saving} onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="button"
                className="mcp-btn mcp-btn-primary"
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
