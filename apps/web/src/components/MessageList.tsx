import { useEffect, useRef } from 'react';
import type { BrainSummary, PartnerConfig } from '@witcode/protocol';
import type { Message, PartnerCard, SubagentCard } from '../ui-types';
import { PartnerCardView, SubagentCardView } from './CollabCards';
import { ToolCallCard } from './ToolCallCard';

/** 只处理围栏代码块，不引入 Markdown 库；其余内容按纯文本换行渲染。 */
function renderBody(text: string) {
  return text.split('```').map((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf('\n');
      const code = (newline >= 0 ? part.slice(newline + 1) : part).replace(/^\n/, '');
      return (
        <pre className="md-pre" key={index}>
          <code>{code}</code>
        </pre>
      );
    }
    return part ? (
      <span className="md-text" key={index}>
        {part}
      </span>
    ) : null;
  });
}

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

interface MessageListProps {
  messages: Message[];
  partnerCards: PartnerCard[];
  subagentCards: SubagentCard[];
  partners: PartnerConfig[];
  brains: BrainSummary[];
}

export function MessageList({
  messages,
  partnerCards,
  subagentCards,
  partners,
  brains,
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
      <div className="empty">
        <div className="empty-mark" aria-hidden="true">W</div>
        <h1>WitCode</h1>
        <p>一个 Web 优先的 Coding Harness。</p>
        <p className="hint">在下面输入一句话，开始一段会话。</p>
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
            {message.reasoning ? (
              <Thinking text={message.reasoning} streaming={message.streaming} />
            ) : null}
            {message.text || message.streaming ? (
              <div className="assistant-text">
                {renderBody(message.text)}
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
