import type { BrainSummary, ModelInfo, PartnerConfig } from '@witcode/protocol';
import {
  CompactSelect,
  brainOptions,
  modelOptions,
  partnerModelKey,
  parsePartnerModelKey,
} from '../PartnerControls';

interface Props {
  partners: PartnerConfig[];
  brains: BrainSummary[];
  officialBrainIds: string[];
  models: ModelInfo[];
  onSetPartner: (partner: PartnerConfig) => void;
}

const SLOT_DESCRIPTIONS: Record<1 | 2, string> = {
  1: '第一视角：常驻审查，对方案补充边界与风险。',
  2: '第二视角：独立参照，交叉验证关键结论。',
};

export function PartnersPanel({
  partners,
  brains,
  officialBrainIds,
  models,
  onSetPartner,
}: Props) {
  const brainsForSelect = brainOptions(brains, officialBrainIds);
  const modelsForSelect = modelOptions(models);

  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>伙伴</h2>
          <p className="panel-desc">伙伴是另一个脑子的视角，只读、只给建议；最多 2 个</p>
        </div>
      </div>

      <div className="partner-settings-grid">
        {partners.map((partner) => (
          <div
            className={
              partner.enabled ? 'partner-settings-card enabled' : 'partner-settings-card'
            }
            key={partner.slot}
          >
            <div className="partner-settings-card-head">
              <div>
                <div className="partner-settings-slot">伙伴 {partner.slot}</div>
                <p className="partner-settings-desc">{SLOT_DESCRIPTIONS[partner.slot]}</p>
              </div>
              <label className="partner-switch">
                <input
                  type="checkbox"
                  checked={partner.enabled}
                  aria-label={`启用伙伴 ${partner.slot}`}
                  onChange={(event) =>
                    onSetPartner({ ...partner, enabled: event.target.checked })
                  }
                />
                <span className="partner-switch-track" aria-hidden="true" />
              </label>
            </div>

            <div className="partner-settings-fields">
              <div className="partner-field">
                <span className="partner-field-label">脑子</span>
                <CompactSelect
                  ariaLabel={`伙伴 ${partner.slot} 脑子`}
                  value={partner.brainId}
                  options={brainsForSelect}
                  glyph="◈"
                  align="down"
                  onChange={(brainId) => onSetPartner({ ...partner, brainId })}
                />
              </div>
              <div className="partner-field">
                <span className="partner-field-label">模型</span>
                <CompactSelect
                  ariaLabel={`伙伴 ${partner.slot} 模型`}
                  value={partnerModelKey(partner.model)}
                  options={modelsForSelect}
                  glyph="◇"
                  align="down"
                  onChange={(key) =>
                    onSetPartner({ ...partner, model: parsePartnerModelKey(key) })
                  }
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
