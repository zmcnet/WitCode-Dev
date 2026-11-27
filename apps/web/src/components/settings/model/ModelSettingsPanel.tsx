import { useCallback, useRef, useState } from 'react';
import type {
  ModelInfo,
  ProviderInput,
  ProviderPublic,
  ProviderTestResult,
  RoutingStrategy,
} from '@witcode/protocol';
import { IconCpu, IconPlus, IconX } from '../../icons';
import { ModelEditor } from './ModelEditor';
import { ProviderRow } from './ProviderRow';
import './model-settings.css';

export interface ModelSettingsPanelProps {
  providers: ProviderPublic[];
  models: ModelInfo[];
  connected: boolean;
  saving: boolean;
  deletingId: string | null;
  routing: RoutingStrategy | null;
  onSave(input: ProviderInput): Promise<void>;
  onDelete(id: string): Promise<void>;
  onTest(id: string): Promise<ProviderTestResult>;
  onReorder(ids: string[]): Promise<void>;
  onRoutingChange(strategy: RoutingStrategy): void;
}

const ROUTING_OPTIONS: Array<{ value: RoutingStrategy; label: string; description: string }> = [
  {
    value: 'order',
    label: '按顺序',
    description: 'order：按列表顺序选择模型，靠前的优先，失败后依次尝试下一个。',
  },
  {
    value: 'rotate',
    label: '轮换',
    description: 'rotate：每次请求在可用模型之间轮换，均匀分担调用。',
  },
];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ModelSettingsPanel(props: ModelSettingsPanelProps): JSX.Element {
  const {
    providers,
    models,
    connected,
    saving,
    deletingId,
    routing,
    onSave,
    onDelete,
    onTest,
    onReorder,
    onRoutingChange,
  } = props;
  const [editor, setEditor] = useState<{ open: boolean; provider: ProviderPublic | null }>({
    open: false,
    provider: null,
  });
  const [reordering, setReordering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const closeEditor = useCallback(() => {
    setEditor({ open: false, provider: null });
    const trigger = triggerRef.current;
    requestAnimationFrame(() => trigger?.focus());
  }, []);

  const openNew = (trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setEditor({ open: true, provider: null });
  };

  const openEdit = (provider: ProviderPublic, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setEditor({ open: true, provider });
  };

  const handleToggle = async (provider: ProviderPublic) => {
    if (!connected || saving || reordering) return;
    setActionError(null);
    try {
      await onSave({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        modelIds: provider.modelIds,
        contextWindow: provider.contextWindow,
        modelSettings: provider.modelSettings,
        enabled: !provider.enabled,
      });
    } catch (error) {
      setActionError(errorMessage(error, `更新「${provider.name}」失败`));
    }
  };

  const handleMove = async (provider: ProviderPublic, direction: -1 | 1) => {
    if (!connected || saving || reordering) return;
    const index = providers.findIndex((item) => item.id === provider.id);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= providers.length) return;
    const ids = providers.map((item) => item.id);
    const from = ids[index];
    const to = ids[target];
    if (!from || !to) return;
    ids[index] = to;
    ids[target] = from;
    setReordering(true);
    setActionError(null);
    try {
      await onReorder(ids);
    } catch (error) {
      setActionError(errorMessage(error, '重排提供商失败'));
    } finally {
      setReordering(false);
    }
  };

  const currentRouting = routing ?? 'order';
  const routingDescription =
    ROUTING_OPTIONS.find((option) => option.value === currentRouting)?.description ?? '';

  return (
    <section className="model-settings" aria-label="模型设置">
      <header className="model-settings-head">
        <div>
          <h2 className="model-settings-title">模型</h2>
          <p className="model-settings-desc">管理模型提供商、API Key、可用模型与路由策略。</p>
          <p className="model-settings-summary">
            {providers.length} 个提供商 · {models.length} 个模型
          </p>
        </div>
        <button
          type="button"
          className="model-settings-btn primary"
          aria-label="新增提供商"
          disabled={!connected || saving}
          onClick={(event) => openNew(event.currentTarget)}
        >
          <IconPlus size={15} />
          新增提供商
        </button>
      </header>

      <div className="model-settings-routing">
        <div className="model-settings-routing-top">
          <span className="model-settings-routing-label">路由策略</span>
          <div className="model-settings-segment" role="radiogroup" aria-label="路由策略">
            {ROUTING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={currentRouting === option.value}
                className={
                  currentRouting === option.value
                    ? 'model-settings-segment-btn active'
                    : 'model-settings-segment-btn'
                }
                disabled={!connected}
                onClick={() => onRoutingChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="model-settings-routing-desc">{routingDescription}</p>
      </div>

      {!connected ? (
        <div className="model-settings-notice" role="status">
          与服务端断开连接，更改可能无法保存。
        </div>
      ) : null}

      {actionError ? (
        <div className="model-settings-error" role="alert">
          <IconX size={14} />
          <span>{actionError}</span>
          <button
            type="button"
            className="model-settings-icon-btn"
            aria-label="关闭错误提示"
            onClick={() => setActionError(null)}
          >
            <IconX size={13} />
          </button>
        </div>
      ) : null}

      {providers.length === 0 ? (
        !connected ? (
          <div className="model-settings-loading" role="status">
            <span className="model-settings-spinner" aria-hidden="true" />
            正在连接服务端…
          </div>
        ) : (
          <div className="model-settings-empty">
            <span className="model-settings-empty-icon" aria-hidden="true">
              <IconCpu size={22} />
            </span>
            <div className="model-settings-empty-title">还没有提供商，先加一个</div>
            <div className="model-settings-empty-hint">
              添加后即可配置模型、切换路由，并在用量页查看调用记录。
            </div>
            <button
              type="button"
              className="model-settings-btn"
              aria-label="新增提供商"
              disabled={saving}
              onClick={(event) => openNew(event.currentTarget)}
            >
              <IconPlus size={14} />
              新增提供商
            </button>
          </div>
        )
      ) : (
        <div className="model-settings-list" role="list">
          {providers.map((provider, index) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              index={index}
              total={providers.length}
              disabled={!connected || saving}
              reordering={reordering}
              onEdit={openEdit}
              onToggle={handleToggle}
              onMove={handleMove}
            />
          ))}
        </div>
      )}

      {editor.open ? (
        <ModelEditor
          key={editor.provider?.id ?? 'new'}
          provider={editor.provider}
          models={models}
          connected={connected}
          saving={saving}
          deletingId={deletingId}
          onClose={closeEditor}
          onSave={onSave}
          onDelete={onDelete}
          onTest={onTest}
        />
      ) : null}
    </section>
  );
}
