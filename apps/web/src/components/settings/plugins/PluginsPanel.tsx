import { useEffect, useRef, useState } from 'react';
import type { PluginComponent, PluginSummary } from '@witcode/protocol';
import './plugins.css';

export interface PluginsPanelProps {
  items: PluginSummary[];
  connected: boolean;
  onRefresh(): void;
  onSetPlugin(id: string, enabled: boolean): void;
  onSetComponent(pluginId: string, componentId: string, enabled: boolean): void;
  onInstall(manifest: string): Promise<void>;
  onInstallLocal(path: string): Promise<void>;
  onSetConfig(pluginId: string, patch: Record<string, unknown>): Promise<void>;
  onUninstall(id: string): Promise<void>;
}

type PanelTab = 'installed' | 'discover';

const COMPONENT_KIND_LABEL: Record<PluginComponent['kind'], string> = {
  tool: '工具',
  brain: '脑子',
  feature: '功能',
};

const EXAMPLE_MANIFEST = `{
  "id": "my-brain",
  "name": "我的脑子",
  "description": "从 JSON 安装的 Brain 插件示例",
  "bestFor": ["通用编码"],
  "identity": "你是一个专注工程任务的智能体。",
  "rules": ["先读再改", "只汇报真实结果"],
  "tools": {}
}`;

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
      className={checked ? 'plugins-switch on' : 'plugins-switch'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="plugins-switch-thumb" aria-hidden="true" />
    </button>
  );
}

/** 48px 图标：取名称首字符，不引入 DSH 品牌元素。 */
function PluginGlyph({ plugin }: { plugin: PluginSummary }) {
  const letter = Array.from(plugin.name || plugin.id)[0] ?? '?';
  return (
    <span
      className={`plugins-glyph plugins-glyph-${plugin.kind}`}
      aria-hidden="true"
    >
      {letter.toUpperCase()}
    </span>
  );
}

function StatusTags({ plugin }: { plugin: PluginSummary }) {
  return (
    <span className="plugins-tags">
      <span className={plugin.enabled ? 'plugins-tag on' : 'plugins-tag'}>
        {plugin.enabled ? '已启用' : '已停用'}
      </span>
      {plugin.builtin || plugin.kind === 'builtin' ? (
        <span className="plugins-tag origin">内置</span>
      ) : plugin.kind === 'code' ? (
        <span className={plugin.status === 'error' ? 'plugins-tag error' : 'plugins-tag origin'}>
          {plugin.status === 'error' ? '加载失败' : plugin.status === 'running' ? '代码插件' : '已停止'}
        </span>
      ) : plugin.removable ? (
        <span className="plugins-tag origin">自定义</span>
      ) : null}
    </span>
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

function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function WarningGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2.7 19a1 1 0 0 0 .9 1.5h16.8a1 1 0 0 0 .9-1.5L12 3Z" />
      <path d="M12 9v5M12 17.5h.01" />
    </svg>
  );
}

function Skeleton() {
  return (
    <div className="plugins-skeleton" role="status" aria-label="正在加载插件">
      {[0, 1, 2].map((index) => (
        <div className="plugins-skeleton-row" key={index}>
          <span className="plugins-skeleton-glyph" />
          <span className="plugins-skeleton-lines">
            <span className="plugins-skeleton-line" />
            <span className="plugins-skeleton-line short" />
          </span>
          <span className="plugins-skeleton-switch" />
        </div>
      ))}
    </div>
  );
}

export function PluginsPanel(props: PluginsPanelProps): JSX.Element {
  const { items, connected, onRefresh, onSetPlugin, onSetComponent, onInstall, onInstallLocal, onSetConfig, onUninstall } = props;

  const [tab, setTab] = useState<PanelTab>('installed');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [localPath, setLocalPath] = useState('');
  const [localError, setLocalError] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({});
  const [manifest, setManifest] = useState('');
  const [installError, setInstallError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [uninstallConfirmId, setUninstallConfirmId] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [discoverQuery, setDiscoverQuery] = useState('');

  const pendingTimers = useRef<Map<string, number>>(new Map());
  const toastTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  }

  function clearPendingTimer(key: string) {
    const timer = pendingTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingTimers.current.delete(key);
    }
  }

  /** 本地 busy 标记；收到新的 items 或超时后自动解除，避免开关卡在禁用态。 */
  function beginPending(key: string) {
    clearPendingTimer(key);
    setPending((prev) => new Set(prev).add(key));
    const timer = window.setTimeout(() => {
      pendingTimers.current.delete(key);
      setPending((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 5000);
    pendingTimers.current.set(key, timer);
  }

  useEffect(() => {
    // items 更新说明服务端已回包，解除所有本地 busy 标记。
    pendingTimers.current.forEach((timer) => window.clearTimeout(timer));
    pendingTimers.current.clear();
    setPending((prev) => (prev.size === 0 ? prev : new Set()));
  }, [items]);

  useEffect(() => {
    return () => {
      pendingTimers.current.forEach((timer) => window.clearTimeout(timer));
      pendingTimers.current.clear();
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
      setUninstallConfirmId(null);
    }
  }, [items, selectedId]);

  useEffect(() => {
    const plugin = items.find((item) => item.id === selectedId);
    setConfigDraft(plugin?.config ? { ...plugin.config } : {});
  }, [selectedId, items]);

  useEffect(() => {
    if (!installOpen) return;
    textareaRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInstallOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [installOpen]);

  function handleSetPlugin(plugin: PluginSummary, enabled: boolean) {
    const key = `plugin:${plugin.id}`;
    if (pending.has(key)) return;
    beginPending(key);
    onSetPlugin(plugin.id, enabled);
    showToast(`${plugin.name} 已${enabled ? '启用' : '停用'}`);
  }

  function handleSetComponent(plugin: PluginSummary, component: PluginComponent, enabled: boolean) {
    const key = `component:${plugin.id}:${component.id}`;
    if (pending.has(key)) return;
    beginPending(key);
    onSetComponent(plugin.id, component.id, enabled);
  }

  function openInstall() {
    setManifest('');
    setInstallError('');
    setInstallOpen(true);
  }

  async function submitInstall() {
    const text = manifest.trim();
    if (!text) {
      setInstallError('请先粘贴插件 JSON manifest。');
      return;
    }
    try {
      JSON.parse(text);
    } catch {
      setInstallError('manifest 不是合法的 JSON，请检查后重试。');
      return;
    }
    setInstalling(true);
    setInstallError('');
    try {
      await onInstall(text);
      setInstallOpen(false);
      setManifest('');
      setTab('installed');
      showToast('插件安装成功');
      onRefresh();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : '安装失败，请检查 manifest 后重试。');
    } finally {
      setInstalling(false);
    }
  }

  async function confirmUninstall(plugin: PluginSummary) {
    if (uninstallingId) return;
    setUninstallingId(plugin.id);
    try {
      await onUninstall(plugin.id);
      setUninstallConfirmId(null);
      setSelectedId(null);
      showToast(`已卸载 ${plugin.name}`);
      onRefresh();
    } catch {
      showToast('卸载失败，请重试。');
    } finally {
      setUninstallingId(null);
    }
  }

  function renderCard(plugin: PluginSummary) {
    const key = `plugin:${plugin.id}`;
    return (
      <div className="plugins-card" key={plugin.id}>
        <PluginGlyph plugin={plugin} />
        <div className="plugins-card-body">
          <button
            type="button"
            className="plugins-card-name"
            onClick={() => setSelectedId(plugin.id)}
            aria-label={`查看插件 ${plugin.name} 详情`}
          >
            {plugin.name}
          </button>
          <p className="plugins-card-desc">{plugin.description}</p>
          <StatusTags plugin={plugin} />
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={pending.has(key)}
          label={`${plugin.enabled ? '停用' : '启用'}插件 ${plugin.name}`}
          onChange={(next) => handleSetPlugin(plugin, next)}
        />
      </div>
    );
  }

  function renderGroup(title: string, plugins: PluginSummary[]) {
    if (plugins.length === 0) return null;
    return (
      <section className="plugins-group" aria-label={title}>
        <h3 className="plugins-group-title">{title}</h3>
        <div className="plugins-list">{plugins.map(renderCard)}</div>
      </section>
    );
  }

  function renderInstalled() {
    if (!connected && items.length === 0) return <Skeleton />;
    if (items.length === 0) {
      return (
        <div className="plugins-empty">
          <div className="plugins-empty-title">还没有插件</div>
          <div className="plugins-empty-hint">安装插件后，可在此启用或配置它的能力。</div>
          <button type="button" className="plugins-btn plugins-btn-primary" onClick={openInstall}>
            <PlusGlyph />
            从 JSON 安装
          </button>
        </div>
      );
    }
    return (
      <>
        {renderGroup('内置插件', items.filter((item) => item.kind === 'builtin'))}
        {renderGroup('已安装插件', items.filter((item) => item.kind !== 'builtin'))}
      </>
    );
  }

  function renderDiscover() {
    return (
      <div className="plugins-discover">
        <div className="plugins-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={discoverQuery}
            onChange={(event) => setDiscoverQuery(event.target.value)}
            placeholder="搜索插件市场"
            aria-label="搜索插件市场"
          />
        </div>
        <div className="plugins-empty">
          <div className="plugins-empty-title">插件市场即将上线</div>
          <div className="plugins-empty-hint">上线后可从这里发现并安装社区插件。现在仍可从 JSON 安装。</div>
          <button type="button" className="plugins-btn" onClick={openInstall}>
            <PlusGlyph />
            从 JSON 安装
          </button>
        </div>
      </div>
    );
  }

  function renderDetail(plugin: PluginSummary) {
    const pluginKey = `plugin:${plugin.id}`;
    return (
      <section className="plugins-detail" aria-label={`${plugin.name} 插件详情`}>
        <nav className="plugins-detail-crumb" aria-label="面包屑">
          <button type="button" className="plugins-detail-back" onClick={() => setSelectedId(null)}>
            <span aria-hidden="true">←</span> 返回插件列表
          </button>
          <span className="plugins-crumb-sep" aria-hidden="true">/</span>
          <span>插件</span>
          <span className="plugins-crumb-sep" aria-hidden="true">/</span>
          <span className="plugins-crumb-current">{plugin.name}</span>
        </nav>

        <div className="plugins-detail-head">
          <PluginGlyph plugin={plugin} />
          <div className="plugins-detail-meta">
            <div className="plugins-detail-name-row">
              <h3 className="plugins-detail-name">{plugin.name}</h3>
              <span className="plugins-detail-version">v{plugin.version}</span>
              <StatusTags plugin={plugin} />
            </div>
            <p className="plugins-detail-desc">{plugin.description}</p>
            <div className="plugins-detail-source">来源：{plugin.source}</div>
          </div>
          <div className="plugins-detail-toggle">
            <span aria-hidden="true">{plugin.enabled ? '已启用' : '已停用'}</span>
            <Switch
              checked={plugin.enabled}
              disabled={pending.has(pluginKey)}
              label={`${plugin.enabled ? '停用' : '启用'}插件 ${plugin.name}`}
              onChange={(next) => handleSetPlugin(plugin, next)}
            />
          </div>
        </div>

        <section className="plugins-detail-section">
          <h3 className="plugins-detail-section-title">组件</h3>
          {plugin.components.length === 0 ? (
            <div className="plugins-detail-empty">该插件没有可单独配置的组件。</div>
          ) : (
            <div className="plugins-components">
              {plugin.components.map((component) => {
                const key = `component:${plugin.id}:${component.id}`;
                return (
                  <div className="plugins-component" key={component.id}>
                    <div className="plugins-component-main">
                      <span className="plugins-component-title">
                        {component.label}
                        {component.locked ? (
                          <span className="plugins-component-lock" title={component.lockReason ?? '该组件不可关闭'}>
                            锁定
                          </span>
                        ) : null}
                      </span>
                      <span className="plugins-component-kind">{COMPONENT_KIND_LABEL[component.kind]}</span>
                      <span className="plugins-component-desc">{component.lockReason ?? ''}</span>
                    </div>
                    <Switch
                      checked={component.enabled}
                      disabled={component.locked || pending.has(key)}
                      label={`${component.enabled ? '停用' : '启用'}组件 ${component.label}`}
                      onChange={(next) => handleSetComponent(plugin, component, next)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {plugin.settings && plugin.settings.length > 0 ? (
          <section className="plugins-detail-section">
            <h3 className="plugins-detail-section-title">插件设置</h3>
            <div className="plugins-config-form">
              {plugin.settings.map((field) => {
                const value = configDraft[field.key] ?? field.default;
                if (field.type === 'boolean') {
                  return (
                    <div className="plugins-config-row" key={field.key}>
                      <div className="plugins-config-label">
                        <span>{field.label}</span>
                        {field.description ? <span className="plugins-config-desc">{field.description}</span> : null}
                      </div>
                      <Switch
                        checked={Boolean(value)}
                        label={field.label}
                        onChange={(next) =>
                          setConfigDraft((prev) => ({ ...prev, [field.key]: next }))
                        }
                      />
                    </div>
                  );
                }
                return (
                  <label className="plugins-config-row" key={field.key}>
                    <span className="plugins-config-label">
                      <span>{field.label}</span>
                      {field.description ? <span className="plugins-config-desc">{field.description}</span> : null}
                    </span>
                    <input
                      className="plugins-config-input"
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(value ?? '')}
                      onChange={(event) =>
                        setConfigDraft((prev) => ({
                          ...prev,
                          [field.key]:
                            field.type === 'number' ? Number(event.target.value) : event.target.value,
                        }))
                      }
                    />
                  </label>
                );
              })}
              <div className="plugins-config-actions">
                <button
                  type="button"
                  className="plugins-btn plugins-btn-primary"
                  disabled={!connected}
                  onClick={() => void onSetConfig(plugin.id, configDraft)}
                >
                  保存设置
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {plugin.removable ? (
          <section className="plugins-danger" aria-label="危险操作">
            <h3 className="plugins-detail-section-title">卸载插件</h3>
            {uninstallConfirmId === plugin.id ? (
              <div className="plugins-confirm" role="alertdialog" aria-label="确认卸载插件">
                <span className="plugins-confirm-text">确定卸载「{plugin.name}」？此操作不可撤销。</span>
                <div className="plugins-confirm-actions">
                  <button type="button" className="plugins-btn" onClick={() => setUninstallConfirmId(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="plugins-btn plugins-btn-danger"
                    disabled={uninstallingId !== null}
                    onClick={() => void confirmUninstall(plugin)}
                  >
                    {uninstallingId === plugin.id ? '卸载中…' : '确认卸载'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="plugins-btn plugins-btn-danger"
                onClick={() => setUninstallConfirmId(plugin.id)}
              >
                卸载
              </button>
            )}
          </section>
        ) : null}
      </section>
    );
  }

  return (
    <section className="plugins-panel" aria-label="插件管理">
      <div className="plugins-head">
        <div>
          <h2 className="plugins-title">插件</h2>
          <p className="plugins-desc">安装、启用和配置插件</p>
        </div>
        <div className="plugins-head-actions">
          <button
            type="button"
            className="plugins-icon-btn"
            aria-label="刷新插件列表"
            title="刷新"
            onClick={onRefresh}
          >
            <RefreshGlyph />
          </button>
          <button
            type="button"
            className="plugins-btn"
            onClick={() => {
              setLocalPath('');
              setLocalError('');
              setLocalOpen(true);
            }}
          >
            本地安装
          </button>
          <button type="button" className="plugins-btn plugins-btn-primary" onClick={openInstall}>
            <PlusGlyph />
            安装插件
          </button>
        </div>
      </div>

      {localOpen ? (
        <div
          className="plugins-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !localBusy) setLocalOpen(false);
          }}
        >
          <div className="plugins-modal" role="dialog" aria-modal="true" aria-labelledby="plugins-local-title">
            <div className="plugins-modal-head">
              <h3 className="plugins-modal-title" id="plugins-local-title">从本地目录安装代码插件</h3>
              <button type="button" className="plugins-icon-btn" aria-label="关闭窗口" onClick={() => !localBusy && setLocalOpen(false)}>
                ×
              </button>
            </div>
            <div className="plugins-modal-body">
              <p className="plugins-warning">
                <WarningGlyph />
                代码插件会以服务端权限运行，只安装可信来源。目录内需要 manifest.json 与 main（默认 main.mjs）。
              </p>
              <label className="plugins-field">
                <span className="plugins-field-label">插件目录（服务端绝对路径）</span>
                <input
                  className="plugins-textarea"
                  value={localPath}
                  placeholder="例如 D:\plugins\my-plugin"
                  onChange={(event) => {
                    setLocalPath(event.target.value);
                    if (localError) setLocalError('');
                  }}
                />
              </label>
              {localError ? <p className="plugins-form-error" role="alert">{localError}</p> : null}
            </div>
            <div className="plugins-modal-actions">
              <button type="button" className="plugins-btn" disabled={localBusy} onClick={() => setLocalOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="plugins-btn plugins-btn-primary"
                disabled={localBusy || !localPath.trim()}
                onClick={async () => {
                  setLocalBusy(true);
                  setLocalError('');
                  try {
                    await onInstallLocal(localPath.trim());
                    setLocalOpen(false);
                    onRefresh();
                  } catch (error) {
                    setLocalError(error instanceof Error ? error.message : '安装失败');
                  } finally {
                    setLocalBusy(false);
                  }
                }}
              >
                {localBusy ? '安装中…' : '安装'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!connected ? (
        <div className="plugins-notice" role="status">与服务端断开连接，插件操作可能无法保存。</div>
      ) : null}
      {toast ? (
        <div className="plugins-toast" role="status">{toast}</div>
      ) : null}

      {selected ? (
        renderDetail(selected)
      ) : (
        <>
          <div className="plugins-tabs" role="tablist" aria-label="插件分类">
            <button
              type="button"
              role="tab"
              id="plugins-tab-installed"
              aria-controls="plugins-panel-installed"
              aria-selected={tab === 'installed'}
              className={tab === 'installed' ? 'plugins-tab active' : 'plugins-tab'}
              onClick={() => setTab('installed')}
            >
              已安装 <span className="plugins-tab-count">{items.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              id="plugins-tab-discover"
              aria-controls="plugins-panel-discover"
              aria-selected={tab === 'discover'}
              className={tab === 'discover' ? 'plugins-tab active' : 'plugins-tab'}
              onClick={() => setTab('discover')}
            >
              发现
            </button>
          </div>

          <div
            role="tabpanel"
            id="plugins-panel-installed"
            aria-labelledby="plugins-tab-installed"
            hidden={tab !== 'installed'}
          >
            {renderInstalled()}
          </div>
          <div
            role="tabpanel"
            id="plugins-panel-discover"
            aria-labelledby="plugins-tab-discover"
            hidden={tab !== 'discover'}
          >
            {renderDiscover()}
          </div>
        </>
      )}

      {installOpen ? (
        <div
          className="plugins-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !installing) setInstallOpen(false);
          }}
        >
          <div className="plugins-modal" role="dialog" aria-modal="true" aria-labelledby="plugins-modal-title">
            <div className="plugins-modal-head">
              <h3 className="plugins-modal-title" id="plugins-modal-title">从 JSON 安装插件</h3>
              <button
                type="button"
                className="plugins-icon-btn"
                aria-label="关闭安装窗口"
                onClick={() => setInstallOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="plugins-modal-body">
              <p className="plugins-warning">
                <WarningGlyph />
                插件以你的权限运行，只安装可信来源。
              </p>
              <label className="plugins-label" htmlFor="plugins-manifest">Brain 插件 JSON manifest</label>
              <textarea
                id="plugins-manifest"
                ref={textareaRef}
                className="plugins-textarea"
                value={manifest}
                spellCheck={false}
                placeholder={'{\n  "id": "my-brain",\n  "name": "我的脑子"\n}'}
                aria-invalid={installError ? true : undefined}
                aria-describedby={installError ? 'plugins-install-error' : undefined}
                onChange={(event) => {
                  setManifest(event.target.value);
                  if (installError) setInstallError('');
                }}
              />
              <details className="plugins-example">
                <summary>查看示例 manifest</summary>
                <pre>{EXAMPLE_MANIFEST}</pre>
              </details>
              {installError ? (
                <p className="plugins-install-error" id="plugins-install-error" role="alert">{installError}</p>
              ) : null}
            </div>
            <div className="plugins-modal-actions">
              <button type="button" className="plugins-btn" onClick={() => setInstallOpen(false)}>取消</button>
              <button
                type="button"
                className="plugins-btn plugins-btn-primary"
                disabled={installing}
                onClick={() => void submitInstall()}
              >
                {installing ? '安装中…' : '安装'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
