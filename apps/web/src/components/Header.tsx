import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconFolder, IconPanelRight } from './icons';

interface Props {
  workspaceName: string;
  sessionTitle: string;
  approvalPending: boolean;
  rightOpen: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleRight: () => void;
}

export function Header({
  workspaceName,
  sessionTitle,
  approvalPending,
  rightOpen,
  sidebarCollapsed,
  onToggleSidebar,
  onToggleRight,
}: Props) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspaceOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!workspaceRef.current?.contains(event.target as Node)) setWorkspaceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [workspaceOpen]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="icon-btn topbar-menu"
          aria-label={sidebarCollapsed ? '展开会话列表' : '收起会话列表'}
          title={sidebarCollapsed ? '展开会话列表' : '收起会话列表'}
          onClick={onToggleSidebar}
        >
          ☰
        </button>
        <div className="workspace-wrap" ref={workspaceRef}>
          <button
            type="button"
            className="workspace-btn"
            aria-expanded={workspaceOpen}
            title={`当前工作区：${workspaceName}`}
            onClick={() => setWorkspaceOpen((value) => !value)}
          >
            <IconFolder size={14} />
            <span className="workspace-name">{workspaceName}</span>
            <IconChevronDown size={12} />
          </button>
          {workspaceOpen ? (
            <div className="workspace-popover">
              <div className="popover-title">当前工作区</div>
              <div className="popover-path">{workspaceName}</div>
              <div className="popover-hint">工作区切换即将上线</div>
            </div>
          ) : null}
        </div>
        <span className="topbar-sep" aria-hidden="true">/</span>
        <span className="topbar-session-title" title={sessionTitle}>{sessionTitle}</span>
      </div>

      <div className="topbar-right">
        {approvalPending ? (
          <span
            className="approval-hint"
            role="status"
            aria-label="有待确认的工具调用"
            title="有待确认的工具调用"
          >
            <span className="approval-hint-dot" aria-hidden="true" />
          </span>
        ) : null}
        <button
          type="button"
          className={`icon-btn ${rightOpen ? 'active' : ''}`}
          aria-label="右栏"
          aria-pressed={rightOpen}
          title="右栏"
          onClick={onToggleRight}
        >
          <IconPanelRight size={16} />
        </button>
      </div>
    </header>
  );
}
