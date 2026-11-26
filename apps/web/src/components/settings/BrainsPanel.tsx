import type { BrainSummary } from '@witcode/protocol';
import { brainDescription, splitBrains } from '../../brain-modes';

interface Props {
  brains: BrainSummary[];
  officialIds: string[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function BrainsPanel({ brains, officialIds, activeId, onSelect }: Props) {
  const groups = splitBrains(brains, officialIds);
  const grouped = groups.official.length > 0;

  const renderCard = (brain: BrainSummary, official = false) => {
    const current = brain.id === activeId;
    const className = [
      'brain-card',
      official ? 'brain-card-official' : '',
      current ? 'active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <button
        key={brain.id}
        type="button"
        className={className}
        aria-pressed={current}
        onClick={() => onSelect(brain.id)}
      >
        <span className="brain-card-head">
          <span className="brain-card-name">{brain.name}</span>
          {current ? <span className="brain-current-badge">当前</span> : null}
        </span>
        <span className="brain-card-desc">{brainDescription(brain, officialIds)}</span>
        <span className="brain-card-tags">
          {brain.bestFor.map((tag, index) => (
            <span className="brain-tag" key={`${tag}-${index}`}>
              {tag}
            </span>
          ))}
        </span>
      </button>
    );
  };

  return (
    <section className="settings-panel">
      <div className="panel-head">
        <div>
          <h2>Brains</h2>
          <p className="panel-desc">
            换脑子不换身体：工具、会话、模型都保留，只改变工作方式
          </p>
        </div>
      </div>

      {brains.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">正在加载脑子…</div>
          <div className="empty-state-hint">连接服务端后会显示可用脑子。</div>
        </div>
      ) : grouped ? (
        <>
          <h3 className="brain-group-title">官方模式</h3>
          <div className="brain-official-grid">
            {groups.official.map((brain) => renderCard(brain, true))}
          </div>
          <h3 className="brain-group-title">参照大脑</h3>
          {groups.custom.length > 0 ? (
            <div className="brain-list">{groups.custom.map((brain) => renderCard(brain))}</div>
          ) : (
            <div className="brain-section-empty">暂无参照大脑</div>
          )}
        </>
      ) : (
        <div className="brain-list">{brains.map((brain) => renderCard(brain))}</div>
      )}
    </section>
  );
}
