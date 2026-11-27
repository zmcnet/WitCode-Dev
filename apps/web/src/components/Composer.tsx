import { useEffect, useRef } from 'react';
import type {
  BrainSummary,
  ModelInfo,
  ModelSelection,
  PartnerConfig,
  PermissionMode,
  ProviderPublic,
  SlashCommand,
} from '@witcode/protocol';
import { BrainSelector } from './BrainSelector';
import { IconPlus, IconSend, IconStop } from './icons';
import { ModelSelector } from './ModelSelector';
import { PartnerSlots } from './PartnerSlots';
import { PermissionSelector } from './PermissionSelector';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  connected: boolean;
  models: ModelInfo[];
  providers: ProviderPublic[];
  selection: ModelSelection | null;
  modelId: string;
  onSelectModel: (selection: ModelSelection) => void;
  brains: BrainSummary[];
  officialBrainIds: string[];
  activeBrainId: string;
  onSelectBrain: (id: string) => void;
  partners: PartnerConfig[];
  onSetPartner: (partner: PartnerConfig) => void;
  permissionMode: PermissionMode;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  /** 草稿态推荐提示词；有值时显示在输入框下方。 */
  suggestions?: string[];
  onSuggestion?: (text: string) => void;
  /** 已用上下文（近似 tokens）；用于右下角圆环。 */
  contextUsedTokens?: number;
  contextLimit?: number;
  /** 发送键：Enter 或 Ctrl/⌘+Enter。 */
  sendKey?: 'enter' | 'ctrl-enter';
  /** 自定义斜杠命令；输入 / 时给出提示。 */
  commands?: SlashCommand[];
}

/** ZCode 输入区右下角的上下文用量圆环。 */
function ContextRing({ used, limit }: { used: number; limit: number }) {
  const pct = Math.max(0, Math.min(1, used / limit));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const label = `${Math.round(pct * 100)}%`;
  return (
    <span
      className="context-ring"
      role="img"
      aria-label={`上下文用量约 ${label}`}
      title={`上下文约 ${label} · ${Math.round(used / 1000)}K / ${Math.round(limit / 1_000_000)}M`}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="2"
        />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${pct * circumference} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  );
}

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

const MAX_LINES = 14;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  connected,
  models,
  providers,
  selection,
  modelId,
  onSelectModel,
  brains,
  officialBrainIds,
  activeBrainId,
  onSelectBrain,
  partners,
  onSetPartner,
  permissionMode,
  onSelectPermissionMode,
  suggestions,
  onSuggestion,
  contextUsedTokens = 0,
  contextLimit = 1_000_000,
  sendKey = 'enter',
  commands = [],
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;

    element.style.height = 'auto';
    const style = getComputedStyle(element);
    const lineHeight = pixels(style.lineHeight) || 22;
    const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
    const border = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
    const maxHeight = lineHeight * MAX_LINES + padding + border;

    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value]);

  const canSend = connected && !busy && Boolean(value.trim());

  const slashQuery =
    value.startsWith('/') && !value.includes('\n') ? value.slice(1).split(/\s/)[0] ?? '' : null;
  const slashMatches =
    slashQuery === null
      ? []
      : commands.filter((command) => command.name.startsWith(slashQuery)).slice(0, 6);

  return (
    <div className="composer-wrap">
      {slashMatches.length > 0 ? (
        <div className="composer-slash-menu" role="listbox" aria-label="斜杠命令">
          {slashMatches.map((command) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={command.name}
              className="composer-slash-item"
              onClick={() => onChange(`/${command.name} `)}
            >
              <span className="composer-slash-name">/{command.name}</span>
              <span className="composer-slash-desc">{command.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="attachment-bar">
        <button type="button" className="attachment-chip" title="添加附件">
          <span aria-hidden="true">＋</span> 添加附件
        </button>
      </div>

      <div className="composer-shell">
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && busy) {
              event.preventDefault();
              onStop();
              return;
            }
            const withModifier = event.ctrlKey || event.metaKey;
            const shouldSend =
              sendKey === 'ctrl-enter'
                ? event.key === 'Enter' && withModifier
                : event.key === 'Enter' && !event.shiftKey && !withModifier;
            if (shouldSend && canSend) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={
            sendKey === 'ctrl-enter'
              ? '给 WitCode 一条指令，Ctrl/⌘+Enter 发送，Enter 换行'
              : '给 WitCode 一条指令，Enter 发送，Shift+Enter 换行'
          }
          aria-label="消息输入框"
        />

        <div className="composer-toolbar">
          <div className="toolbar-left">
            <button type="button" className="tool-btn" title="添加命令或文件" aria-label="添加命令或文件">
              <IconPlus size={16} />
            </button>
            <BrainSelector
              brains={brains}
              officialIds={officialBrainIds}
              activeId={activeBrainId}
              onSelect={onSelectBrain}
            />
            <PermissionSelector mode={permissionMode} onSelect={onSelectPermissionMode} />
            <PartnerSlots
              partners={partners}
              brains={brains}
              officialBrainIds={officialBrainIds}
              models={models}
              onSetPartner={onSetPartner}
            />
          </div>

          <div className="toolbar-right">
            <ContextRing used={contextUsedTokens} limit={contextLimit} />
            <ModelSelector
              models={models}
              providers={providers}
              selection={selection}
              modelId={modelId}
              onSelect={onSelectModel}
            />
            {busy ? (
              <button type="button" className="send-btn stop" aria-label="停止" title="停止" onClick={onStop}>
                <IconStop size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                aria-label="发送"
                title="发送"
                disabled={!canSend}
                onClick={onSend}
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {suggestions && suggestions.length > 0 ? (
        <div className="composer-suggestions" aria-label="推荐提示词">
          {suggestions.map((text) => (
            <button
              type="button"
              className="suggestion-chip"
              key={text}
              onClick={() => onSuggestion?.(text)}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
