import { useEffect, useRef } from 'react';
import type { BrainSummary, PartnerConfig } from '@witcode/protocol';
import type { Message, PartnerCard, SubagentCard } from '../ui-types';
import { PartnerCardView, SubagentCardView } from './CollabCards';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <details className="thinking">
      <summary>
        <span className="thinking-glyph" aria-hidden="true">◌</span>
        <span>思考过程</span>
        {streaming ? <span className="thinking-live">· 进行中</span> : null}
        <span className="thinking-chevron" aria-hidden="true">▾</span>
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

type FeedItem =
  | { kind: 'message'; order: number; message: Message }
  | { kind: 'partner'; order: number; card: PartnerCard }
  | { kind: 'subagent'; order: number; card: SubagentCard };

function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 9) return '早上好';
  if (hour >= 9 && hour < 12) return '上午好';
  if (hour >= 12 && hour < 14) return '中午好';
  if (hour >= 14 && hour < 18) return '下午好';
  if (hour >= 18 && hour < 23) return '晚上好';
  return '夜深了';
}

interface MessageListProps {
  messages: Message[];
  partnerCards: PartnerCard[];
  subagentCards: SubagentCard[];
  partners: PartnerConfig[];
  brains: BrainSummary[];
  /** 设置里可关闭思考过程展示。 */
  showReasoning?: boolean;
}

export function MessageList({
  messages,
  partnerCards,
  subagentCards,
  partners,
  brains,
  showReasoning = true,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // 消息和协作卡片共用到达序号，按同一条时间线并列渲染。
  const feed: FeedItem[] = [
    ...messages.map((message) => ({
      kind: 'message' as const,
      order: message.order ?? 0,
      message,
    })),
    ...partnerCards.map((card) => ({
      kind: 'partner' as const,
      order: card.order,
      card,
    })),
    ...subagentCards.map((card) => ({
      kind: 'subagent' as const,
      order: card.order,
      card,
    })),
  ].sort((a, b) => a.order - b.order);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, partnerCards, subagentCards]);

  if (feed.length === 0) {
    return (
      <div className="empty draft-empty">
        <div className="empty-watermark" aria-hidden="true">W</div>
        <p className="empty-greeting">{greeting()}</p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {feed.map((item) => {
        if (item.kind === 'partner') {
          return (
            <PartnerCardView
              key={`partner-${item.card.id}`}
              card={item.card}
              order={item.order}
              partners={partners}
              brains={brains}
            />
          );
        }
        if (item.kind === 'subagent') {
          return <SubagentCardView key={`subagent-${item.card.id}`} card={item.card} order={item.order} />;
        }

        const message = item.message;
        if (message.role === 'user') {
          return (
            <div className="msg-row user" key={message.id} data-order={item.order}>
              <div className="bubble user">
                <div className="msg-text">{message.text}</div>
              </div>
            </div>
          );
        }

        return (
          <div className="msg-row assistant" key={message.id} data-order={item.order}>
            {showReasoning && message.reasoning ? (
              <Thinking text={message.reasoning} streaming={message.streaming} />
            ) : null}
            {message.text || message.streaming ? (
              <div className="assistant-text">
                <Markdown text={message.text} />
                {message.streaming ? <span className="caret" /> : null}
              </div>
            ) : null}
            {message.toolCalls.length > 0 ? (
              <div className="tool-list">
                {message.toolCalls.map((call) => (
                  <ToolCallCard key={call.id} call={call} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
