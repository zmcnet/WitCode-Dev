import { useEffect, useState } from 'react';
import type { SessionSummary } from '@witcode/protocol';
import {
  IconBlocks,
  IconCheck,
  IconClock,
  IconFilter,
  IconFolder,
  IconMessagePlus,
  IconMore,
  IconPanelLeft,
  IconSearch,
  IconSettings,
  IconX,
} from './icons';

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

type ViewMode = 'recent' | 'project';

const NAV_ITEMS: Array<{ key: NavKey; label: string; Glyph: typeof IconBlocks }> = [
  { key: 'chat', label: '会话', Glyph: IconMessagePlus },
  { key: 'plugins', label: '插件', Glyph: IconBlocks },
  { key: 'tasks', label: '任务', Glyph: IconClock },
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [view, setView] = useState<ViewMode>('recent');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (!menuFor && !viewMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.session-menu-wrap, .side-view-wrap')) {
        setMenuFor(null);
        setViewMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuFor(null);
        setViewMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuFor, viewMenuOpen]);

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
      {/* ZCode 侧栏顶部是 48px 留白/拖拽区，没有品牌 logo。 */}
      <div className="side-top">
        <button
          type="button"
          className="icon-btn drawer-close"
          aria-label="关闭会话列表"
          onClick={onClose}
        >
          <IconX size={16} />
        </button>
        <button
          type="button"
          className="icon-btn collapse-toggle"
          aria-label={collapsed ? '展开会话列表' : '收起会话列表'}
          title={collapsed ? '展开会话列表' : '收起会话列表'}
          onClick={onToggleCollapse}
        >
          <IconPanelLeft size={16} />
        </button>
      </div>

      <div className="side-primary">
        <button type="button" className="side-row side-new" onClick={onNew}>
          <IconMessagePlus size={16} />
          <span className="side-row-label">新建会话</span>
        </button>
        {NAV_ITEMS.map((item) => {
          const Glyph = item.Glyph;
          return (
            <button
              key={item.key}
              type="button"
              className={activeNav === item.key ? 'side-row active' : 'side-row'}
              title={item.label}
              aria-current={activeNav === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <Glyph size={16} />
              <span className="side-row-label">{item.label}</span>
              {activeNav === item.key ? (
                <span className="side-row-dot" aria-hidden="true" />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="side-list-head">
        <span className="side-list-title">会话</span>
        <span className="side-count">{sessions.length}</span>
        <span className="side-head-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="搜索会话"
            title="搜索会话"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((value) => !value)}
          >
            <IconSearch size={14} />
          </button>
          <div className="side-view-wrap">
            <button
              type="button"
              className="icon-btn"
              aria-label="会话视图"
              title="会话视图"
              aria-expanded={viewMenuOpen}
              onClick={() => setViewMenuOpen((value) => !value)}
            >
              <IconFilter size={14} />
            </button>
            {viewMenuOpen ? (
              <div className="side-view-menu" role="menu">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === 'recent'}
                  onClick={() => {
                    setView('recent');
                    setViewMenuOpen(false);
                  }}
                >
                  <span className="menu-check">{view === 'recent' ? <IconCheck size={14} /> : null}</span>
                  按最近
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === 'project'}
                  disabled
                  title="按项目视图即将上线"
                >
                  <span className="menu-check" />
                  按项目
                </button>
              </div>
            ) : null}
          </div>
        </span>
      </div>

      {searchOpen ? (
        <div className="side-search-row">
          <IconSearch size={14} />
          <input
            className="side-search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
          {query ? (
            <button
              type="button"
              className="icon-btn"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <IconX size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="side-sessions">
        <div className="session-scroll">
          <div className="workspace-group">
            <div className="group-head">
              <IconFolder size={14} />
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
                        <IconMore size={14} />
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
          <IconSettings size={16} />
        </button>
      </div>
    </aside>
  );
}
