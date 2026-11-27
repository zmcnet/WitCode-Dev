import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ApprovalDialog } from './components/ApprovalDialog';
import { Composer } from './components/Composer';
import { RightDock } from './components/dock/RightDock';
import type { DockTab } from './components/dock/RightDock';
import { ErrorBanner } from './components/ErrorBanner';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { TodoDock } from './components/TodoDock';
import { SettingsView } from './components/settings/SettingsView';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import type { NavKey } from './components/WorkspaceSidebar';
import { applyTheme, loadTheme, watchSystemTheme } from './theme';
import type { ThemeMode } from './theme';
import { useChat } from './useChat';

const WORKSPACE_NAME = String(import.meta.env.VITE_WITCODE_WORKSPACE ?? 'witcode');
const SIDEBAR_KEY = 'witcode:sidebar-width';
const MIN_WIDTH = 240;
const MAX_WIDTH = 420;
const RIGHT_WIDTH_KEY = 'witcode:right-width';

const DRAFT_SUGGESTIONS = [
  '先看一下这个项目，告诉我它是做什么的',
  '把项目里的 TODO / FIXME 找出来，按优先级列一下',
  '跑一遍类型检查和测试，把失败项整理出来',
  '审查最近的改动，指出风险最高的三处',
];

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
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = Number(localStorage.getItem(RIGHT_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 280 && saved <= 720 ? saved : 520;
  });
  const [dockTab, setDockTab] = useState<DockTab>('files');
  const [activeNav, setActiveNav] = useState<NavKey>('chat');
  const [theme, setTheme] = useState<ThemeMode>(loadTheme);
  const dragRef = useRef(false);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [theme]);

  // 服务端设置是跨设备的真源：连上后以服务端主题为准。
  useEffect(() => {
    const next = chat.appSettings?.theme;
    if (next && next !== theme) setTheme(next);
  }, [chat.appSettings?.theme, theme]);

  // 字号缩放：只改文字，布局尺寸由 CSS 控制。
  useEffect(() => {
    const scale = chat.appSettings?.fontScale ?? 1;
    document.documentElement.style.setProperty('--font-scale', String(scale));
  }, [chat.appSettings?.fontScale]);

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

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !chat.pendingApproval) chat.openChat();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen, chat.pendingApproval, chat.openChat]);

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

  const toggleRight = () => {
    const next = !rightOpen;
    setRightOpen(next);
    if (next) {
      chat.loadTree('');
      chat.loadGit();
      chat.loadWorkflows();
      chat.loadPlugins();
    }
  };

  const currentSession = chat.visibleSessions.find((item) => item.id === chat.currentSessionId);
  // 草稿态：与 ZCode 一致，隐藏顶栏、问候语与输入框组成居中列。
  const draft =
    activeNav === 'chat' &&
    !settingsOpen &&
    chat.messages.length === 0 &&
    chat.partnerCards.length === 0 &&
    chat.subagentCards.length === 0 &&
    !chat.busy;
  const sessionTitle =
    activeNav !== 'chat'
      ? activeNav === 'plugins'
        ? '插件'
        : '任务'
      : (currentSession?.title ?? '新会话');
  // 粗估上下文：chars/4；只用于右下角圆环，不作为真实计费。
  const contextUsedTokens = chat.messages.reduce(
    (sum, message) =>
      sum + Math.ceil((message.text.length + (message.reasoning?.length ?? 0)) / 4),
    0,
  );

  return (
    <>
      <div
        className={`app-shell${draft ? ' is-draft' : ''}`}
        aria-hidden={settingsOpen || undefined}
      >
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

        <div className="workspace-main">
          <Header
            workspaceName={WORKSPACE_NAME}
            sessionTitle={sessionTitle}
            approvalPending={chat.pendingApproval !== null}
            rightOpen={rightOpen}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onToggleRight={toggleRight}
          />

          <ErrorBanner message={chat.error} onClose={() => chat.setError(null)} />

          <div className="shell-body">
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
                      showReasoning={chat.appSettings?.reasoningDisplay ?? true}
                    />
                  </main>
                  <TodoDock items={chat.todos} />
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
                    suggestions={draft ? DRAFT_SUGGESTIONS : undefined}
                    onSuggestion={(text) => chat.setInput(text)}
                    contextUsedTokens={contextUsedTokens}
                    contextLimit={1_000_000}
                    sendKey={chat.appSettings?.sendKey ?? 'enter'}
                    commands={chat.commands}
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
              <RightDock
                width={rightWidth}
                onWidthChange={(width) => {
                  setRightWidth(width);
                  localStorage.setItem(RIGHT_WIDTH_KEY, String(width));
                }}
                onClose={() => setRightOpen(false)}
                activeTab={dockTab}
                onTabChange={setDockTab}
                files={{
                  tree: chat.fileTree,
                  treePath: chat.treePath,
                  onLoadTree: chat.loadTree,
                  file: chat.fileContent,
                  onOpenFile: chat.openFile,
                  onCloseFile: chat.closeFile,
                }}
                git={{
                  branch: chat.gitBranch,
                  changes: chat.gitChanges,
                  diff: chat.gitDiff,
                  onLoad: chat.loadGit,
                  onOpenDiff: chat.openGitDiff,
                }}
                terminal={{
                  subscribe: chat.subscribeTerminal,
                  send: chat.terminalSend,
                  resize: chat.terminalResize,
                  create: chat.terminalCreate,
                  close: chat.terminalClose,
                }}
                pluginPanels={chat.plugins
                  .filter((plugin) => plugin.kind === 'code' && plugin.panel)
                  .map((plugin) => ({
                    id: plugin.id,
                    title: plugin.panel!.title,
                    entry: plugin.panel!.entry,
                  }))}
                workflow={{
                  runs: chat.workflows,
                  selectedId: chat.workflowId,
                  onSelect: chat.selectWorkflow,
                  onCancel: chat.cancelWorkflow,
                  onRefresh: chat.loadWorkflows,
                }}
              />
            ) : null}
          </div>
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
          appSettings={chat.appSettings}
          onSaveSettings={chat.saveSettings}
          personalization={chat.personalization}
          onLoadPersonalization={chat.loadPersonalization}
          onSavePersonalization={chat.savePersonalization}
          memoryText={chat.memoryText}
          memoryPath={chat.memoryPath}
          onLoadMemory={chat.loadMemory}
          onSaveMemory={chat.saveMemory}
          plugins={chat.plugins}
          onLoadPlugins={chat.loadPlugins}
          onSetPlugin={chat.setPluginEnabled}
          onSetPluginComponent={chat.setPluginComponent}
          onInstallPlugin={chat.installPlugin}
          onInstallLocalPlugin={chat.installLocalPlugin}
          onSetPluginConfig={chat.setPluginConfig}
          onUninstallPlugin={chat.uninstallPlugin}
          skills={chat.skills}
          onSaveSkill={chat.saveSkill}
          onDeleteSkill={chat.deleteSkill}
          onLoadSkills={chat.loadSkills}
          commands={chat.commands}
          onSaveCommand={chat.saveCommand}
          onDeleteCommand={chat.deleteCommand}
          onLoadCommands={chat.loadCommands}
          mcpServers={chat.mcpServers}
          onSaveMcp={chat.saveMcpServer}
          onDeleteMcp={chat.deleteMcpServer}
          onReconnectMcp={chat.reconnectMcpServer}
          onLoadMcp={chat.loadMcpServers}
          automations={chat.automations}
          onSaveAutomation={chat.saveAutomation}
          onDeleteAutomation={chat.deleteAutomation}
          onRunAutomation={chat.runAutomation}
          onLoadAutomations={chat.loadAutomations}
          hooks={chat.hooks}
          onSaveHook={chat.saveHook}
          onDeleteHook={chat.deleteHook}
          onLoadHooks={chat.loadHooks}
          routing={chat.routing}
          onRoutingChange={chat.setRoutingStrategy}
          testingProviderId={chat.testingProviderId}
          onTestProvider={chat.testProvider}
          onReorderProviders={chat.reorderProviders}
          sessionCount={chat.visibleSessions.length}
          archivedSessions={chat.archivedSessions}
          onRestoreSession={chat.restoreSession}
          onLoadArchivedSessions={chat.loadArchivedSessions}
          workspaceName={WORKSPACE_NAME}
          workspacePath={WORKSPACE_NAME}
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
