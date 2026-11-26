import { useState } from 'react';
import type { ToolCallEntry } from '../ui-types';

function preview(input: unknown): string {
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  } catch {
    text = String(input);
  }
  return text.length > 72 ? `${text.slice(0, 72)}…` : text || '(无参数)';
}

function detail(input: unknown): string {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

/** 工具调用是一行内联摘要，点击后展开参数与结果，不用大卡片。 */
export function ToolCallCard({ call }: { call: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(false);
  const state = call.result ? (call.result.ok ? 'ok' : 'failed') : 'pending';
  const stateLabel = state === 'ok' ? '成功' : state === 'failed' ? '失败' : '执行中';

  return (
    <div className={`tool-row ${state}`}>
      <button
        type="button"
        className="tool-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="tool-icon" aria-hidden="true">
          {state === 'ok' ? '✓' : state === 'failed' ? '!' : '◌'}
        </span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-args">{preview(call.input)}</span>
        <span className="tool-state">{stateLabel}</span>
        <span className="tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded ? (
        <div className="tool-detail">
          <div className="tool-section">
            <div className="tool-label">参数</div>
            <pre>{detail(call.input)}</pre>
          </div>
          {call.result ? (
            <div className="tool-section">
              <div className="tool-label">{call.result.ok ? '结果 · 成功' : '结果 · 失败'}</div>
              <pre>{call.result.content}</pre>
            </div>
          ) : (
            <div className="tool-pending">执行中…</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
