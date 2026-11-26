import type { BrainSummary, PartnerConfig } from '@witcode/protocol';
import type { PartnerCard, SubagentCard } from '../ui-types';

const SUBAGENT_STATUS: Record<SubagentCard['status'], string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function preview(text: string, max = 56): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function Chevron() {
  return <span className="collab-chevron" aria-hidden="true">▾</span>;
}

interface PartnerCardViewProps {
  card: PartnerCard;
  order: number;
  partners: PartnerConfig[];
  brains: BrainSummary[];
}

/**
 * 事件到达时配置可能还没加载完，所以渲染时再用当前槽位/脑子列表补全；
 * 卡片自带的字段优先，拿不到模型时只显示脑子。
 */
function partnerTitle(card: PartnerCard, partners: PartnerConfig[], brains: BrainSummary[]): string {
  const partner = partners.find((item) => item.brainId === card.brainId);
  const brain = card.brainName
    || brains.find((item) => item.id === card.brainId)?.name
    || card.brainId;
  const slot = card.slot ?? partner?.slot;
  const model = card.modelLabel ?? partner?.model?.model;
  const title = `伙伴${slot ? ` ${slot}` : ''} · ${brain}`;
  return model ? `${title} / ${model}` : title;
}

/** 伙伴只给意见，卡片独立成行，不并入助手正文。 */
export function PartnerCardView({ card, order, partners, brains }: PartnerCardViewProps) {
  const title = partnerTitle(card, partners, brains);
  return (
    <div className={`msg-row collab partner${card.status === 'running' ? ' running' : ''}`} data-order={order}>
      <div className={`collab-card partner ${card.status}`}>
        <div className="collab-head">
          <span className="collab-glyph" aria-hidden="true">◈</span>
          <span className="collab-title" title={title}>
            {title}
          </span>
          <span className="collab-status">{card.status === 'running' ? '咨询中' : '已完成'}</span>
        </div>
        <details className="collab-fold">
          <summary>
            <span className="fold-label">问题</span>
            <span className="fold-preview">{preview(card.question)}</span>
            <Chevron />
          </summary>
          <div className="fold-body">{card.question}</div>
        </details>
        {card.status === 'running' ? (
          <div className="collab-thinking">
            <span className="collab-pulse" aria-hidden="true" />
            正在思考…
          </div>
        ) : (
          <details className="collab-fold answer">
            <summary>
              <span className="fold-label">回答</span>
              <span className="fold-preview">{preview(card.answer ?? '')}</span>
              <Chevron />
            </summary>
            <div className="fold-body">{card.answer}</div>
          </details>
        )}
      </div>
    </div>
  );
}

/** 子智能体卡片：任务 + 状态 + 可折叠输出；失败状态用警示色。 */
export function SubagentCardView({ card, order }: { card: SubagentCard; order: number }) {
  return (
    <div className={`msg-row collab subagent ${card.status}`} data-order={order}>
      <div className={`collab-card subagent ${card.status}`}>
        <div className="collab-head">
          <span className="collab-glyph" aria-hidden="true">◇</span>
          <span className="collab-title">子智能体 · {shortId(card.id)}</span>
          <span className={`collab-status ${card.status}`}>
            {SUBAGENT_STATUS[card.status]}
          </span>
        </div>
        <div className="collab-task">{card.task}</div>
        {card.status === 'running' ? (
          <div className="collab-thinking">
            <span className="collab-pulse" aria-hidden="true" />
            正在执行…
          </div>
        ) : (
          <details className="collab-fold">
            <summary>
              <span className="fold-label">输出</span>
              <span className="fold-preview">{preview(card.output ?? '')}</span>
              <Chevron />
            </summary>
            <div className="fold-body">{card.output}</div>
          </details>
        )}
      </div>
    </div>
  );
}
