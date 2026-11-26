import { useEffect, useRef, useState } from 'react';
import type { BrainSummary, ModelInfo, PartnerConfig } from '@witcode/protocol';
import {
  CompactSelect,
  brainOptions,
  modelOptions,
  partnerModelKey,
  parsePartnerModelKey,
} from './PartnerControls';

interface Props {
  partners: PartnerConfig[];
  brains: BrainSummary[];
  officialBrainIds: string[];
  models: ModelInfo[];
  onSetPartner: (partner: PartnerConfig) => void;
}

/** 输入区工具条上的伙伴入口：显示启用数量，展开后直接配置两个槽位。 */
export function PartnerSlots({
  partners,
  brains,
  officialBrainIds,
  models,
  onSetPartner,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 内层脑子/模型菜单先响应 Esc，避免一次按键把整个面板也关掉。
        if (rootRef.current?.querySelector('.partner-select-menu')) return;
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const enabled = partners.filter((partner) => partner.enabled).length;
  const brainsForSelect = brainOptions(brains, officialBrainIds);
  const modelsForSelect = modelOptions(models);

  return (
    <div className="partner-slots" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="partner-slot-button"
        aria-label={`伙伴槽位，已启用 ${enabled} 个，共 2 个`}
        aria-expanded={open}
        title="配置伙伴槽位"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="partner-glyph" aria-hidden="true">◈</span>
        <span className="partner-count">伙伴 {enabled}/2</span>
        <span className="partner-chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="partner-panel" role="group" aria-label="伙伴槽位">
          <div className="partner-panel-title">伙伴槽位</div>
          {partners.map((partner) => (
            <div
              className={partner.enabled ? 'partner-slot-row' : 'partner-slot-row disabled'}
              key={partner.slot}
            >
              <label className="partner-enable">
                <input
                  type="checkbox"
                  checked={partner.enabled}
                  aria-label={`启用伙伴 ${partner.slot}`}
                  onChange={(event) =>
                    onSetPartner({ ...partner, enabled: event.target.checked })
                  }
                />
                <span>伙伴 {partner.slot}</span>
              </label>
              <CompactSelect
                ariaLabel={`伙伴 ${partner.slot} 脑子`}
                value={partner.brainId}
                options={brainsForSelect}
                glyph="◈"
                className="partner-brain"
                onChange={(brainId) => onSetPartner({ ...partner, brainId })}
              />
              <CompactSelect
                ariaLabel={`伙伴 ${partner.slot} 模型`}
                value={partnerModelKey(partner.model)}
                options={modelsForSelect}
                glyph="◇"
                className="partner-model"
                onChange={(key) =>
                  onSetPartner({ ...partner, model: parsePartnerModelKey(key) })
                }
              />
            </div>
          ))}
          {enabled === 0 ? (
            <div className="partner-panel-hint">未启用伙伴，主智能体不会咨询</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
