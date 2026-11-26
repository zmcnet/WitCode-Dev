import { useEffect, useRef } from 'react';
import type { ApprovalRequest } from '@witcode/protocol';

interface Props {
  request: ApprovalRequest;
  onDecide: (decision: 'allow' | 'deny') => void;
}

const RISK_LABEL: Record<ApprovalRequest['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

/**
 * 工具执行确认弹窗。默认焦点与 Esc 都落在「拒绝」上，
 * 保证用户无意识操作时不会放行高风险工具。
 */
export function ApprovalDialog({ request, onDecide }: Props) {
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    denyRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 弹窗打开时独占 Esc，避免同时关闭底层的下拉/抽屉。
        event.preventDefault();
        event.stopImmediatePropagation();
        onDecide('deny');
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onDecide]);

  const highRisk = request.riskLevel === 'high';

  return (
    <div
      className="approval-backdrop"
      onClick={(event) => {
        // 点击遮罩视为拒绝；点击卡片内部不关闭。
        if (event.target === event.currentTarget) onDecide('deny');
      }}
    >
      <div
        className="approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-reason"
      >
        <div className="approval-head">
          <div className="approval-meta">
            <span className="approval-tool">{request.tool}</span>
            <span className={`approval-risk risk-${request.riskLevel}`}>
              {RISK_LABEL[request.riskLevel]}
            </span>
          </div>
          <h2 id="approval-title" className="approval-title">{request.title}</h2>
        </div>

        <div className="approval-body">
          <div className="approval-label">即将执行</div>
          <pre className="approval-detail">{request.detail}</pre>
          <div className="approval-label">为什么需要确认</div>
          <p id="approval-reason" className="approval-reason">{request.reason}</p>
        </div>

        <div className="approval-actions">
          <button
            ref={denyRef}
            type="button"
            className="btn approval-btn approval-deny"
            aria-label="拒绝执行此工具"
            onClick={() => onDecide('deny')}
          >
            拒绝
          </button>
          <button
            type="button"
            className={`btn approval-btn approval-allow${highRisk ? ' approval-allow-secondary' : ' primary'}`}
            aria-label="允许执行此工具"
            onClick={() => onDecide('allow')}
          >
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
