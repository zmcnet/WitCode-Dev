import { useState } from 'react';
import type {
  BrainSummary,
  ModelInfo,
  PartnerConfig,
  PermissionMode,
  ProviderInput,
  ProviderPublic,
  UsageRecord,
  UsageSummary,
} from '@witcode/protocol';
import type { SettingsTab } from '../../useChat';
import { PERMISSION_MODES, permissionOption, ShieldIcon } from '../../permission';
import { BrainsPanel } from './BrainsPanel';
import { PartnersPanel } from './PartnersPanel';
import { ProvidersPanel } from './ProvidersPanel';
import { UsagePanel } from './UsagePanel';

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
  onBack: () => void;
  onSaveProvider: (input: ProviderInput) => Promise<void>;
  onDeleteProvider: (id: string) => Promise<void>;
}

const NAV: Array<{ key: SettingsTab; glyph: string; label: string }> = [
  { key: 'general', glyph: '⚙', label: '通用' },
  { key: 'models', glyph: '◇', label: '模型' },
  { key: 'brains', glyph: '◎', label: 'Brains' },
  { key: 'partners', glyph: '◉', label: '伙伴' },
  { key: 'plugins', glyph: '◈', label: '插件' },
  { key: 'data', glyph: '▦', label: '数据' },
];

const TITLES: Record<SettingsTab, string> = {
  general: '通用',
  models: '模型',
  brains: 'Brains',
  partners: '伙伴',
  plugins: '插件',
  data: '数据',
};

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="panel-desc">{hint}</p>
        </div>
      </div>
      <div className="empty-state">
        <div className="empty-state-title">{title}管理即将上线</div>
        <div className="empty-state-hint">这里会放与{title}相关的配置。</div>
      </div>
    </section>
  );
}

function GeneralPanel({
  permissionMode,
  onSelectPermissionMode,
}: Pick<Props, 'permissionMode' | 'onSelectPermissionMode'>) {
  const rows = [
    { label: '外观', value: '石墨深色' },
    { label: '语言', value: '简体中文' },
    { label: '基础字号', value: '14px' },
    { label: '发送消息', value: 'Enter' },
  ];
  const current = permissionOption(permissionMode);
  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>通用</h2>
          <p className="panel-desc">工作台的基础偏好。</p>
        </div>
      </div>
      <div className="pref-list">
        {rows.map((row) => (
          <div className="pref-row" key={row.label}>
            <span className="pref-label">{row.label}</span>
            <span className="pref-value">{row.value}</span>
          </div>
        ))}
      </div>
      <div className="permission-pref">
        <div className="permission-pref-head">
          <span className="pref-label">权限模式</span>
          <div className="permission-options" role="radiogroup" aria-label="权限模式">
            {PERMISSION_MODES.map((item) => {
              const active = item.mode === permissionMode;
              return (
                <button
                  key={item.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? 'permission-option active' : 'permission-option'}
                  onClick={() => onSelectPermissionMode(item.mode)}
                >
                  <ShieldIcon />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="permission-pref-desc">
          <span className="permission-pref-current">{current.label}</span>
          <span>{current.description}</span>
        </div>
      </div>
    </section>
  );
}

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
  onBack,
  onSaveProvider,
  onDeleteProvider,
}: Props) {
  const [modelSubTab, setModelSubTab] = useState<'providers' | 'usage'>('providers');

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="设置导航">
          <div className="settings-nav-top">
            <button type="button" className="btn ghost settings-back" onClick={onBack}>
              <span aria-hidden="true">←</span>
              <span className="settings-back-label">返回工作区</span>
            </button>
          </div>
          <nav>
            {NAV.map((item) => (
              <button
                key={item.key}
                type="button"
                className={tab === item.key ? 'settings-nav-item active' : 'settings-nav-item'}
                aria-current={tab === item.key ? 'page' : undefined}
                title={item.label}
                onClick={() => onTabChange(item.key)}
              >
                <span className="settings-nav-glyph" aria-hidden="true">{item.glyph}</span>
                <span className="settings-nav-label">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-nav-footer">
            <span className={connected ? 'conn-dot ok' : 'conn-dot'} aria-hidden="true" />
            <span className="conn-text">{connected ? '已连接' : '未连接'}</span>
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
            {tab === 'general' ? (
              <GeneralPanel
                permissionMode={permissionMode}
                onSelectPermissionMode={onSelectPermissionMode}
              />
            ) : null}

            {tab === 'models' ? (
              <>
                <div className="settings-subtabs" role="tablist" aria-label="模型设置">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={modelSubTab === 'providers'}
                    className={modelSubTab === 'providers' ? 'settings-tab active' : 'settings-tab'}
                    onClick={() => setModelSubTab('providers')}
                  >
                    提供商
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={modelSubTab === 'usage'}
                    className={modelSubTab === 'usage' ? 'settings-tab active' : 'settings-tab'}
                    onClick={() => setModelSubTab('usage')}
                  >
                    用量
                  </button>
                </div>
                {modelSubTab === 'providers' ? (
                  <ProvidersPanel
                    providers={providers}
                    connected={connected}
                    saving={saving}
                    deletingId={deletingId}
                    onSave={onSaveProvider}
                    onDelete={onDeleteProvider}
                  />
                ) : (
                  <UsagePanel
                    summary={usage.summary}
                    records={usage.records}
                    providers={providers}
                  />
                )}
              </>
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
              <Placeholder title="插件" hint="管理工作区启用的插件。" />
            ) : null}
            {tab === 'data' ? (
              <Placeholder title="数据" hint="管理会话数据与存储。" />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
