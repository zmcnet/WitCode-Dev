import { useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  AutomationInput,
  AutomationPublic,
  BrainSummary,
  HookConfig,
  McpServerInput,
  McpServerPublic,
  ModelInfo,
  PartnerConfig,
  PermissionMode,
  PluginSummary,
  ProviderInput,
  ProviderPublic,
  ProviderTestResult,
  RoutingStrategy,
  SessionSummary,
  SkillSummary,
  SlashCommand,
  UsageRecord,
  UsageSummary,
} from '@witcode/protocol';
import type { SettingsTab } from '../../useChat';
import {
  IconArchive,
  IconBlocks,
  IconCable,
  IconClock,
  IconCpu,
  IconDatabase,
  IconFolder,
  IconInfo,
  IconKeyboard,
  IconMemory,
  IconPalette,
  IconSearch,
  IconSettings,
  IconSliders,
  IconTerminal,
  IconSparkles,
  IconUser,
  IconUsers,
  IconX,
} from '../icons';
import { BrainsPanel } from './BrainsPanel';
import { PartnersPanel } from './PartnersPanel';
import { McpPanel } from './mcp/McpPanel';
import { ModelSettingsPanel } from './model/ModelSettingsPanel';
import { AutomationsPanel } from './automations/AutomationsPanel';
import { ArchivePanel } from './panels/ArchivePanel';
import { HooksPanel } from './hooks/HooksPanel';
import { CommandsPanel } from './commands/CommandsPanel';
import { PluginsPanel } from './plugins/PluginsPanel';
import { SkillsPanel } from './skills/SkillsPanel';
import { UsagePanel } from './UsagePanel';
import {
  AboutPanel,
  AppearancePanel,
  BehaviorPanel,
  DataPanel,
  GeneralPanel,
  MemoryPanel,
  PersonalizationPanel,
  ProjectsPanel,
  ShortcutsPanel,
  SubagentsPanel,
} from './panels/SettingsPanels';

interface Props {
  providers: ProviderPublic[];
  usage: { summary: UsageSummary | null; records: UsageRecord[] };
  connected: boolean;
  saving: boolean;
  deletingId: string | null;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  brains: BrainSummary[];
  officialBrainIds: string[];
  activeBrainId: string;
  onSelectBrain: (id: string) => void;
  partners: PartnerConfig[];
  models: ModelInfo[];
  onSetPartner: (partner: PartnerConfig) => void;
  permissionMode: PermissionMode;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  appSettings: AppSettings | null;
  onSaveSettings: (patch: Partial<AppSettings>) => void;
  personalization: string;
  onLoadPersonalization: () => void;
  onSavePersonalization: (text: string) => void;
  memoryText: string;
  memoryPath: string;
  onLoadMemory: () => void;
  onSaveMemory: (text: string) => void;
  plugins: PluginSummary[];
  onLoadPlugins: () => void;
  onSetPlugin: (id: string, enabled: boolean) => void;
  onSetPluginComponent: (pluginId: string, componentId: string, enabled: boolean) => void;
  onInstallPlugin: (manifest: string) => Promise<void>;
  onInstallLocalPlugin: (path: string) => Promise<void>;
  onSetPluginConfig: (pluginId: string, patch: Record<string, unknown>) => Promise<void>;
  onUninstallPlugin: (id: string) => Promise<void>;
  skills: SkillSummary[];
  onSaveSkill: (skill: SkillSummary) => Promise<void>;
  onDeleteSkill: (id: string) => Promise<void>;
  onLoadSkills: () => void;
  commands: SlashCommand[];
  onSaveCommand: (command: SlashCommand) => Promise<void>;
  onDeleteCommand: (name: string) => Promise<void>;
  onLoadCommands: () => void;
  mcpServers: McpServerPublic[];
  onSaveMcp: (server: McpServerInput) => Promise<void>;
  onDeleteMcp: (id: string) => Promise<void>;
  onReconnectMcp: (id: string) => Promise<void>;
  onLoadMcp: () => void;
  automations: AutomationPublic[];
  onSaveAutomation: (input: AutomationInput) => Promise<void>;
  onDeleteAutomation: (id: string) => Promise<void>;
  onRunAutomation: (id: string) => Promise<void>;
  onLoadAutomations: () => void;
  hooks: HookConfig[];
  onSaveHook: (hook: HookConfig) => Promise<void>;
  onDeleteHook: (id: string) => Promise<void>;
  onLoadHooks: () => void;
  routing: RoutingStrategy;
  onRoutingChange: (strategy: RoutingStrategy) => void;
  testingProviderId: string | null;
  onTestProvider: (id: string) => Promise<ProviderTestResult>;
  onReorderProviders: (ids: string[]) => Promise<void>;
  sessionCount: number;
  archivedSessions: SessionSummary[];
  onRestoreSession: (id: string) => void;
  onLoadArchivedSessions: () => void;
  workspaceName: string;
  workspacePath: string;
  onBack: () => void;
  onSaveProvider: (input: ProviderInput) => Promise<void>;
  onDeleteProvider: (id: string) => Promise<void>;
}

interface NavItem {
  key: SettingsTab;
  label: string;
  Glyph: typeof IconSettings;
  keywords: string;
}

const GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '基础',
    items: [
      { key: 'general', label: '常规', Glyph: IconSettings, keywords: '语言 数据目录 版本 更新' },
      { key: 'appearance', label: '外观', Glyph: IconPalette, keywords: '主题 深色 浅色 字体 平滑' },
      { key: 'models', label: '模型', Glyph: IconCpu, keywords: '提供商 provider 模型 model api key 路由 测试' },
      { key: 'shortcuts', label: '键盘快捷键', Glyph: IconKeyboard, keywords: '快捷键 键盘 发送 enter' },
    ],
  },
  {
    title: 'Agent 能力',
    items: [
      { key: 'brains', label: 'Brains', Glyph: IconSparkles, keywords: '脑子 brain 模式 人格' },
      { key: 'partners', label: '伙伴', Glyph: IconUsers, keywords: '伙伴 partner 子智能体 协作' },
      { key: 'personalization', label: '个性化', Glyph: IconUser, keywords: '个性化 用户指令 AGENTS 提示词' },
      { key: 'behavior', label: '行为与工具', Glyph: IconSliders, keywords: '行为 工具 推理 回复 语言 步数 权限' },
      { key: 'memory', label: '记忆', Glyph: IconMemory, keywords: '记忆 上下文 context 压缩 token' },
      { key: 'subagents', label: '子智能体', Glyph: IconUsers, keywords: '子智能体 subagent 深度 并发' },
      { key: 'automations', label: '自动化', Glyph: IconClock, keywords: '自动化 automation 定时 计划任务 schedule' },
      { key: 'hooks', label: '钩子', Glyph: IconSliders, keywords: '钩子 hook 生命周期 工具 命令' },
      { key: 'plugins', label: '插件', Glyph: IconBlocks, keywords: '插件 plugin 扩展 安装 启用' },
      { key: 'mcp', label: 'MCP 服务器', Glyph: IconCable, keywords: 'mcp 服务器 工具 stdio' },
      { key: 'skills', label: '技能', Glyph: IconSparkles, keywords: '技能 skill 提示词 能力' },
      { key: 'commands', label: '命令', Glyph: IconTerminal, keywords: '命令 command slash /' },
    ],
  },
  {
    title: '数据与统计',
    items: [
      { key: 'usage', label: '使用统计', Glyph: IconCpu, keywords: '用量 usage token 请求 统计' },
      { key: 'projects', label: '项目管理', Glyph: IconFolder, keywords: '项目 workspace 工作区' },
      { key: 'archive', label: '归档管理', Glyph: IconArchive, keywords: '归档 archive 会话' },
      { key: 'data', label: '数据', Glyph: IconDatabase, keywords: '数据 会话 存储' },
      { key: 'about', label: '关于', Glyph: IconInfo, keywords: '关于 版本 许可 github' },
    ],
  },
];

const TITLES: Record<SettingsTab, string> = {
  general: '常规',
  appearance: '外观',
  models: '模型',
  shortcuts: '键盘快捷键',
  personalization: '个性化',
  behavior: '行为与工具',
  memory: '记忆',
  brains: 'Brains',
  partners: '伙伴',
  subagents: '子智能体',
  plugins: '插件',
  automations: '自动化',
  hooks: '钩子',
  mcp: 'MCP 服务器',
  skills: '技能',
  commands: '命令',
  usage: '使用统计',
  projects: '项目管理',
  archive: '归档管理',
  data: '数据',
  about: '关于',
};

export function SettingsView({
  providers,
  usage,
  connected,
  saving,
  deletingId,
  tab,
  onTabChange,
  brains,
  officialBrainIds,
  activeBrainId,
  onSelectBrain,
  partners,
  models,
  onSetPartner,
  permissionMode,
  onSelectPermissionMode,
  appSettings,
  onSaveSettings,
  personalization,
  onLoadPersonalization,
  onSavePersonalization,
  memoryText,
  memoryPath,
  onLoadMemory,
  onSaveMemory,
  plugins,
  onLoadPlugins,
  onSetPlugin,
  onSetPluginComponent,
  onInstallPlugin,
  onInstallLocalPlugin,
  onSetPluginConfig,
  onUninstallPlugin,
  skills,
  onSaveSkill,
  onDeleteSkill,
  onLoadSkills,
  commands,
  onSaveCommand,
  onDeleteCommand,
  onLoadCommands,
  mcpServers,
  onSaveMcp,
  onDeleteMcp,
  onReconnectMcp,
  onLoadMcp,
  automations,
  onSaveAutomation,
  onDeleteAutomation,
  onRunAutomation,
  onLoadAutomations,
  hooks,
  onSaveHook,
  onDeleteHook,
  onLoadHooks,
  routing,
  onRoutingChange,
  testingProviderId,
  onTestProvider,
  onReorderProviders,
  sessionCount,
  archivedSessions,
  onRestoreSession,
  onLoadArchivedSessions,
  workspaceName,
  workspacePath,
  onBack,
  onSaveProvider,
  onDeleteProvider,
}: Props) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl/⌘+K 聚焦设置搜索，与 ZCode 设置页一致。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const normalized = query.trim().toLowerCase();
  const groups = GROUPS.map((group) => ({
    ...group,
    items: normalized
      ? group.items.filter(
          (item) =>
            item.label.toLowerCase().includes(normalized) ||
            item.keywords.toLowerCase().includes(normalized),
        )
      : group.items,
  })).filter((group) => group.items.length > 0);

  const commonPanels = {
    settings: appSettings,
    onSave: onSaveSettings,
    connected,
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="设置导航">
          <div className="settings-nav-top">
            <button type="button" className="btn ghost settings-back" onClick={onBack}>
              <span aria-hidden="true">←</span>
              <span className="settings-back-label">返回工作区</span>
            </button>
            <div className="settings-search">
              <IconSearch size={14} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索设置"
                aria-label="搜索设置"
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
              ) : (
                <kbd className="settings-search-kbd">Ctrl K</kbd>
              )}
            </div>
          </div>
          <nav>
            {groups.map((group) => (
              <div className="settings-nav-group" key={group.title}>
                <div className="settings-nav-title">{group.title}</div>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={tab === item.key ? 'settings-nav-item active' : 'settings-nav-item'}
                    aria-current={tab === item.key ? 'page' : undefined}
                    title={item.label}
                    onClick={() => onTabChange(item.key)}
                  >
                    <span className="settings-nav-glyph" aria-hidden="true">
                      <item.Glyph size={16} />
                    </span>
                    <span className="settings-nav-label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 ? (
              <div className="settings-nav-empty">没有匹配的设置</div>
            ) : null}
          </nav>
          <div className="settings-nav-footer">
            <span className={connected ? 'conn-dot ok' : 'conn-dot'} aria-hidden="true" />
            <span className="conn-text">{connected ? '已连接' : '未连接'}</span>
            <span className="settings-version">v0.1.0</span>
          </div>
        </aside>

        <div className="settings-main">
          <div className="settings-breadcrumb">
            <span>设置</span>
            <span className="topbar-sep" aria-hidden="true">/</span>
            <span className="settings-crumb-current">{TITLES[tab]}</span>
          </div>

          {!connected ? (
            <div className="connection-notice" role="status">
              与服务端断开连接，设置可能无法保存。
            </div>
          ) : null}

          <div className="settings-scroll">
            {tab === 'general' ? <GeneralPanel {...commonPanels} /> : null}
            {tab === 'appearance' ? <AppearancePanel {...commonPanels} /> : null}
            {tab === 'behavior' ? (
              <BehaviorPanel
                {...commonPanels}
                permissionMode={permissionMode}
                onSelectPermissionMode={onSelectPermissionMode}
              />
            ) : null}
            {tab === 'shortcuts' ? <ShortcutsPanel {...commonPanels} /> : null}

            {tab === 'personalization' ? (
              <PersonalizationPanel
                {...commonPanels}
                personalization={personalization}
                onLoadPersonalization={onLoadPersonalization}
                onSavePersonalization={onSavePersonalization}
              />
            ) : null}

            {tab === 'memory' ? (
              <MemoryPanel
                {...commonPanels}
                memoryText={memoryText}
                memoryPath={memoryPath}
                onLoadMemory={onLoadMemory}
                onSaveMemory={onSaveMemory}
              />
            ) : null}

            {tab === 'subagents' ? (
              <SubagentsPanel {...commonPanels} brains={brains} models={models} />
            ) : null}

            {tab === 'models' ? (
              <ModelSettingsPanel
                providers={providers}
                models={models}
                connected={connected}
                saving={saving}
                deletingId={deletingId}
                routing={routing}
                onSave={onSaveProvider}
                onDelete={onDeleteProvider}
                onTest={onTestProvider}
                onReorder={onReorderProviders}
                onRoutingChange={onRoutingChange}
              />
            ) : null}

            {tab === 'usage' ? (
              <UsagePanel summary={usage.summary} records={usage.records} providers={providers} />
            ) : null}

            {tab === 'brains' ? (
              <BrainsPanel
                brains={brains}
                officialIds={officialBrainIds}
                activeId={activeBrainId}
                onSelect={onSelectBrain}
              />
            ) : null}

            {tab === 'partners' ? (
              <PartnersPanel
                partners={partners}
                brains={brains}
                officialBrainIds={officialBrainIds}
                models={models}
                onSetPartner={onSetPartner}
              />
            ) : null}

            {tab === 'plugins' ? (
              <PluginsPanel
                items={plugins}
                connected={connected}
                onRefresh={onLoadPlugins}
                onSetPlugin={onSetPlugin}
                onSetComponent={onSetPluginComponent}
                onInstall={onInstallPlugin}
                onInstallLocal={onInstallLocalPlugin}
                onSetConfig={onSetPluginConfig}
                onUninstall={onUninstallPlugin}
              />
            ) : null}
            {tab === 'automations' ? (
              <AutomationsPanel
                items={automations}
                connected={connected}
                onRefresh={onLoadAutomations}
                onSave={onSaveAutomation}
                onDelete={onDeleteAutomation}
                onRun={onRunAutomation}
              />
            ) : null}
            {tab === 'hooks' ? (
              <HooksPanel
                items={hooks}
                connected={connected}
                onRefresh={onLoadHooks}
                onSave={onSaveHook}
                onDelete={onDeleteHook}
              />
            ) : null}
            {tab === 'mcp' ? (
              <McpPanel
                items={mcpServers}
                connected={connected}
                onRefresh={onLoadMcp}
                onSave={onSaveMcp}
                onDelete={onDeleteMcp}
                onReconnect={onReconnectMcp}
              />
            ) : null}
            {tab === 'skills' ? (
              <SkillsPanel
                items={skills}
                connected={connected}
                onRefresh={onLoadSkills}
                onSave={onSaveSkill}
                onDelete={onDeleteSkill}
              />
            ) : null}
            {tab === 'commands' ? (
              <CommandsPanel
                items={commands}
                connected={connected}
                onRefresh={onLoadCommands}
                onSave={onSaveCommand}
                onDelete={onDeleteCommand}
              />
            ) : null}
            {tab === 'projects' ? (
              <ProjectsPanel
                {...commonPanels}
                sessionCount={sessionCount}
                workspaceName={workspaceName}
                workspacePath={workspacePath}
              />
            ) : null}
            {tab === 'archive' ? (
              <ArchivePanel
                sessions={archivedSessions}
                connected={connected}
                onLoad={onLoadArchivedSessions}
                onRestore={onRestoreSession}
              />
            ) : null}
            {tab === 'data' ? <DataPanel {...commonPanels} sessionCount={sessionCount} /> : null}
            {tab === 'about' ? <AboutPanel {...commonPanels} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
