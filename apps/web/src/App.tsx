import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ApprovalDialog } from './components/ApprovalDialog';
import { Composer } from './components/Composer';
import { ErrorBanner } from './components/ErrorBanner';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { SettingsView } from './components/settings/SettingsView';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import type { NavKey } from './components/WorkspaceSidebar';
import { useChat } from './useChat';

const WORKSPACE_NAME = String(import.meta.env.VITE_WITCODE_WORKSPACE ?? 'witcode');
const SIDEBAR_KEY = 'witcode:sidebar-width';
const MIN_WIDTH = 240;
const MAX_WIDTH = 420;

function initialWidth(): number {
  const saved = Number(localStorage.getItem(SIDEBAR_KEY));
  return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 264;
}

export function App() {
  const chat = useChat();
  const [sidebarWidth, setSidebarWidth] = useState(initialWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [activeNav, setActiveNav] = useState<NavKey>('chat');
  const dragRef = useRef(false);

  const settingsOpen = chat.view === 'settings';

  const closeDrawer = () => setDrawerOpen(false);

  useEffect(() => {
    if (!drawerOpen || settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 确认弹窗打开时，Esc 只用于拒绝工具调用。
      if (event.key === 'Escape' && !chat.pendingApproval) closeDrawer();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, settingsOpen, chat.pendingApproval, closeDrawer]);

  const toggleSidebar = () => {
    if (window.innerWidth < 768) {
      setDrawerOpen((value) => !value);
    } else {
      setSidebarCollapsed((value) => !value);
    }
  };

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 1024) return;
    dragRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-dragging');
  };

  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setSidebarWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(event.clientX))));
  };

  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('is-dragging');
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth));
  };

  const openSettings = () => {
    setDrawerOpen(false);
    chat.openSettings();
  };

  const currentSession = chat.visibleSessions.find((item) => item.id === chat.currentSessionId);
  const activeBrain = chat.brains.find((item) => item.id === chat.activeBrainId);
  const brainName = activeBrain?.name ?? '默认脑子';
  const sessionTitle =
    activeNav !== 'chat'
      ? activeNav === 'plugins'
        ? '插件'
        : '任务'
      : (currentSession?.title ?? '新会话');

  return (
    <>
      <div className="app-shell" aria-hidden={settingsOpen || undefined}>
        <Header
          workspaceName={WORKSPACE_NAME}
          sessionTitle={sessionTitle}
          brainName={brainName}
          approvalPending={chat.pendingApproval !== null}
          rightOpen={rightOpen}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          onToggleRight={() => setRightOpen((value) => !value)}
          onOpenSettings={openSettings}
        />

        <ErrorBanner message={chat.error} onClose={() => chat.setError(null)} />

        <div className="shell-body">
          <WorkspaceSidebar
            sessions={chat.visibleSessions}
            currentSessionId={chat.currentSessionId}
            workspaceName={WORKSPACE_NAME}
            connected={chat.connected}
            activeNav={activeNav}
            onNavigate={(nav) => {
              setActiveNav(nav);
              if (drawerOpen) closeDrawer();
            }}
            onNew={() => {
              chat.newSession();
              setActiveNav('chat');
              if (drawerOpen) closeDrawer();
            }}
            onOpen={(id) => {
              chat.openSession(id);
              setActiveNav('chat');
              if (drawerOpen) closeDrawer();
            }}
            onRename={chat.renameSession}
            onArchive={chat.archiveSession}
            onOpenSettings={openSettings}
            drawerOpen={drawerOpen}
            onClose={closeDrawer}
            collapsed={sidebarCollapsed}
            width={sidebarWidth}
            onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
          />

          <div
            className="drag-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          />

          <div className="center-col">
            {activeNav === 'chat' ? (
              <>
                <main className="messages">
                  <MessageList
                    messages={chat.messages}
                    partnerCards={chat.partnerCards}
                    subagentCards={chat.subagentCards}
                    partners={chat.partners}
                    brains={chat.brains}
                  />
                </main>
                <Composer
                  value={chat.input}
                  onChange={chat.setInput}
                  onSend={chat.send}
                  onStop={chat.stop}
                  busy={chat.busy}
                  connected={chat.connected}
                  models={chat.models}
                  providers={chat.providers}
                  selection={chat.selection}
                  modelId={chat.modelId}
                  onSelectModel={chat.chooseModel}
                  brains={chat.brains}
                  officialBrainIds={chat.officialBrainIds}
                  activeBrainId={chat.activeBrainId}
                  onSelectBrain={chat.selectBrain}
                  partners={chat.partners}
                  onSetPartner={chat.setPartner}
                  permissionMode={chat.permissionMode}
                  onSelectPermissionMode={chat.selectPermissionMode}
                />
              </>
            ) : (
              <main className="messages">
                <div className="empty">
                  <h1>{sessionTitle}</h1>
                  <p>{activeNav === 'plugins' ? '插件管理' : '定时任务'}即将上线。</p>
                </div>
              </main>
            )}
          </div>

          {rightOpen ? (
            <aside className="rightbar" aria-label="右栏">
              <div className="rightbar-head">
                <span>右栏</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭右栏"
                  onClick={() => setRightOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="rightbar-body">
                <div className="empty-state">
                  <div className="empty-state-title">右栏内容即将上线</div>
                </div>
              </div>
            </aside>
          ) : null}
        </div>

        {drawerOpen && activeNav === 'chat' ? (
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="关闭会话列表"
            onClick={closeDrawer}
          />
        ) : null}
      </div>

      {settingsOpen ? (
        <SettingsView
          providers={chat.providers}
          usage={chat.usage}
          connected={chat.connected}
          saving={chat.saving}
          deletingId={chat.deletingId}
          tab={chat.settingsTab}
          onTabChange={chat.setSettingsTab}
          brains={chat.brains}
          officialBrainIds={chat.officialBrainIds}
          activeBrainId={chat.activeBrainId}
          onSelectBrain={chat.selectBrain}
          partners={chat.partners}
          models={chat.models}
          onSetPartner={chat.setPartner}
          permissionMode={chat.permissionMode}
          onSelectPermissionMode={chat.selectPermissionMode}
          onBack={chat.openChat}
          onSaveProvider={chat.saveProvider}
          onDeleteProvider={chat.deleteProvider}
        />
      ) : null}

      {chat.pendingApproval ? (
        <ApprovalDialog
          request={chat.pendingApproval}
          onDecide={chat.respondApproval}
        />
      ) : null}
    </>
  );
}
