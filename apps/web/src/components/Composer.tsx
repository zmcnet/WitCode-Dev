import { useEffect, useRef } from 'react';
import type {
  BrainSummary,
  ModelInfo,
  ModelSelection,
  PartnerConfig,
  PermissionMode,
  ProviderPublic,
} from '@witcode/protocol';
import { BrainSelector } from './BrainSelector';
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

  return (
    <div className="composer-wrap">
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
            if (event.key === 'Enter' && !event.shiftKey && canSend) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="给 WitCode 一条指令，Enter 发送，Shift+Enter 换行"
          aria-label="消息输入框"
        />

        <div className="composer-toolbar">
          <div className="toolbar-left">
            <button type="button" className="tool-btn" title="添加命令或文件" aria-label="添加命令或文件">
              +
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
            <ModelSelector
              models={models}
              providers={providers}
              selection={selection}
              modelId={modelId}
              onSelect={onSelectModel}
            />
            {busy ? (
              <button type="button" className="send-btn stop" onClick={onStop}>
                停止
              </button>
            ) : (
              <button type="button" className="send-btn" disabled={!canSend} onClick={onSend}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
