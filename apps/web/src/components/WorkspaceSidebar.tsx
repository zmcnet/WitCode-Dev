import { useEffect, useState } from 'react';
import type { SessionSummary } from '@witcode/protocol';

export type NavKey = 'chat' | 'plugins' | 'tasks';

interface Props {
  sessions: SessionSummary[];
  currentSessionId: string;
  workspaceName: string;
  connected: boolean;
  activeNav: NavKey;
  onNavigate: (nav: NavKey) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onOpenSettings: () => void;
  drawerOpen: boolean;
  onClose: () => void;
  collapsed: boolean;
  width: number;
  onToggleCollapse: () => void;
}

const NAV_ITEMS: Array<{ key: NavKey; glyph: string; label: string }> = [
  { key: 'chat', glyph: '▤', label: '会话' },
  { key: 'plugins', glyph: '◈', label: '插件' },
  { key: 'tasks', glyph: '◷', label: '任务' },
];

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function WorkspaceSidebar({
  sessions,
  currentSessionId,
  workspaceName,
  connected,
  activeNav,
  onNavigate,
  onNew,
  onOpen,
  onRename,
  onArchive,
  onOpenSettings,
  drawerOpen,
  onClose,
  collapsed,
  width,
  onToggleCollapse,
}: Props) {
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.session-menu-wrap')) setMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuFor]);

  const filtered = query.trim()
    ? sessions.filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()))
    : sessions;

  const commitRename = (id: string) => {
    if (renamingId === id) {
      onRename(id, renameValue);
      setRenamingId(null);
    }
  };

  const classes = [
    'sidebar',
    collapsed ? 'is-collapsed' : '',
    drawerOpen ? 'drawer-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <aside
      className={classes}
      aria-label="工作台侧栏"
      style={collapsed ? undefined : { width, flexBasis: width }}
    >
      <div className="side-top">
        <div className="side-brand-row">
          <div className="brand" title="WitCode">
            <span className="brand-glyph" aria-hidden="true">W</span>
            <span className="brand-name">WitCode</span>
          </div>
          <div className="side-top-actions">
            <button
              type="button"
              className="icon-btn drawer-close"
              aria-label="关闭会话列表"
              onClick={onClose}
            >
              ×
            </button>
            <button
              type="button"
              className="icon-btn collapse-toggle"
              aria-label={collapsed ? '展开会话列表' : '收起会话列表'}
              title={collapsed ? '展开会话列表' : '收起会话列表'}
              onClick={onToggleCollapse}
            >
              {collapsed ? '»' : '«'}
            </button>
          </div>
        </div>
        <button type="button" className="new-session" onClick={onNew}>
          <span className="new-session-plus" aria-hidden="true">+</span>
          <span className="new-session-label">新建会话</span>
        </button>
      </div>

      <nav className="side-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={activeNav === item.key ? 'nav-item active' : 'nav-item'}
            title={item.label}
            aria-current={activeNav === item.key ? 'page' : undefined}
            onClick={() => onNavigate(item.key)}
          >
            <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="side-sessions">
        <div className="side-section-head">
          <span className="side-section-label">会话</span>
          <span className="side-count">{sessions.length}</span>
        </div>

        <div className="side-tools">
          <div className="side-search-wrap">
            <span className="search-glyph" aria-hidden="true">⌕</span>
            <input
              className="side-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话"
              aria-label="搜索会话"
            />
          </div>
          <div className="view-toggle" role="group" aria-label="会话视图">
            <button type="button" className="view-tab active" aria-pressed="true">
              按最近
            </button>
            <button
              type="button"
              className="view-tab"
              aria-pressed="false"
              title="按项目视图即将上线"
              disabled
            >
              按项目
            </button>
          </div>
        </div>

        <div className="session-scroll">
          <div className="workspace-group">
            <div className="group-head">
              <span className="folder-glyph" aria-hidden="true">▱</span>
              <span className="group-name">{workspaceName}</span>
              <span className="group-count">{filtered.length}</span>
            </div>

            {filtered.length === 0 ? (
              <div className="session-empty">
                {sessions.length === 0 ? '等待会话列表…' : '没有匹配的会话'}
              </div>
            ) : (
              filtered.map((session) => {
                const active = session.id === currentSessionId;
                const renaming = renamingId === session.id;
                return (
                  <div
                    key={session.id}
                    className={active ? 'session-row active' : 'session-row'}
                  >
                    <span className={active ? 'session-dot active' : 'session-dot'} aria-hidden="true" />
                    {renaming ? (
                      <input
                        className="rename-input"
                        autoFocus
                        value={renameValue}
                        aria-label="重命名会话"
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={() => commitRename(session.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename(session.id);
                          if (event.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="session-open"
                        title={session.title || '未命名会话'}
                        onClick={() => onOpen(session.id)}
                        onDoubleClick={() => {
                          setRenamingId(session.id);
                          setRenameValue(session.title);
                          setMenuFor(null);
                        }}
                      >
                        <span className="session-name">{session.title || '未命名会话'}</span>
                        <span className="session-time">{relativeTime(session.updatedAt)}</span>
                      </button>
                    )}
                    <div className="session-menu-wrap">
                      <button
                        type="button"
                        className="session-more"
                        aria-label={`更多操作：${session.title}`}
                        aria-expanded={menuFor === session.id}
                        onClick={() => setMenuFor((value) => (value === session.id ? null : session.id))}
                      >
                        …
                      </button>
                      {menuFor === session.id ? (
                        <div className="session-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setRenamingId(session.id);
                              setRenameValue(session.title);
                              setMenuFor(null);
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onArchive(session.id);
                              setMenuFor(null);
                            }}
                          >
                            归档
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="side-footer">
        <span className={connected ? 'conn-dot ok' : 'conn-dot'} aria-hidden="true" />
        <span className="conn-text">{connected ? '已连接' : '未连接'}</span>
        <button
          type="button"
          className="icon-btn footer-settings"
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </aside>
  );
}
