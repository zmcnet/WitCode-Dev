import type { ChatMessage } from '@witcode/protocol';
import type { Message, ToolCallEntry } from './ui-types';

interface ToolResultData {
  ok: boolean;
  content: string;
}

function parseToolResult(content: string): ToolResultData {
  const prefix = 'ERROR: ';
  return content.startsWith(prefix)
    ? { ok: false, content: content.slice(prefix.length) }
    : { ok: true, content };
}

/**
 * 把服务端持久化的会话历史转成界面消息。
 * 工具结果不会单独成为气泡，而是按 toolCallId 优先、toolName 兜底
 * 归到对应工具卡片上。
 */
export function historyToMessages(history: ChatMessage[]): Message[] {
  const byId = new Map<string, ToolResultData>();
  const byName = new Map<string, ToolResultData[]>();

  for (const item of history) {
    if (item.role !== 'tool') continue;
    const result = parseToolResult(item.content);
    if (item.toolCallId) {
      byId.set(item.toolCallId, result);
    } else if (item.toolName) {
      const list = byName.get(item.toolName) ?? [];
      list.push(result);
      byName.set(item.toolName, list);
    }
  }

  const takeByName = (name: string): ToolResultData | undefined => {
    const list = byName.get(name);
    const first = list?.[0];
    if (!list || !first) return undefined;
    list.shift();
    if (list.length === 0) byName.delete(name);
    return first;
  };

  const messages: Message[] = [];

  history.forEach((item, index) => {
    if (item.role === 'system' || item.role === 'tool') return;

    if (item.role === 'user') {
      messages.push({
        id: `history-${index}`,
        role: 'user',
        text: item.content,
        streaming: false,
        toolCalls: [],
      });
      return;
    }

    const toolCalls: ToolCallEntry[] = (item.toolCalls ?? []).map((call, callIndex) => {
      const result = (call.id ? byId.get(call.id) : undefined) ?? takeByName(call.name);
      return {
        id: `history-${index}-${callIndex}-${call.id}`,
        name: call.name,
        input: call.input,
        ...(result ? { result } : {}),
      };
    });

    messages.push({
      id: `history-${index}`,
      role: 'assistant',
      text: item.content,
      streaming: false,
      toolCalls,
    });
  });

  return messages;
}
