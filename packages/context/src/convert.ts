import type { ChatMessage, ToolCall } from '@witcode/protocol';
import type { CoreMessage } from 'acp-kernel';

/**
 * ChatMessage 没有 reasoning 字段；在适配层用可选字段承载内核的 reasoning
 * 载荷，等协议补齐后可直接把该字段移入 @witcode/protocol。
 */
export interface ContextChatMessage extends ChatMessage {
  reasoning?: string;
}

/** 内核用 `#` 后缀表示同一条原始消息拆分出的多个 core。 */
function baseId(id: string): string {
  const hash = id.indexOf('#');
  return hash > 0 ? id.slice(0, hash) : id;
}

function stringifyInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

function parseInput(text: string | undefined): unknown {
  if (!text) return '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** 纯函数：协议消息 → 内核消息。id 基于数组下标，稳定且可预测。 */
export function toCoreMessages(messages: readonly ChatMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];

  messages.forEach((msg, index) => {
    const id = `msg-${index}`;
    const parts: CoreMessage[] = [];
    const reasoning = (msg as ContextChatMessage).reasoning;

    if (typeof reasoning === 'string' && reasoning.length > 0) {
      parts.push({
        id: `${id}#reasoning`,
        role: msg.role,
        contentType: 'reasoning',
        text: reasoning,
      });
    }

    if (msg.role === 'tool') {
      parts.push({
        id: `${id}#tool-result`,
        role: 'tool',
        contentType: 'tool-result',
        text: msg.content,
        toolName: msg.toolName,
        toolCallId: msg.toolCallId,
      });
    } else {
      if (msg.content.length > 0) {
        parts.push({
          id: `${id}#text`,
          role: msg.role,
          contentType: 'text',
          text: msg.content,
        });
      }
      (msg.toolCalls ?? []).forEach((call: ToolCall, callIndex) => {
        parts.push({
          id: `${id}#tool-call-${callIndex}`,
          role: 'assistant',
          contentType: 'tool-call',
          text: stringifyInput(call.input),
          toolName: call.name,
          toolCallId: call.id,
        });
      });
    }

    // 一条协议消息只产生一个 core 时直接使用基础 id，便于内核识别。
    if (parts.length === 0) {
      parts.push({ id, role: msg.role, contentType: 'text', text: msg.content });
    } else if (parts.length === 1) {
      parts[0]!.id = id;
    }
    out.push(...parts);
  });

  return out;
}

/** 纯函数：内核消息 → 协议消息；同一个 base id 的 core 合并回一条。 */
export function fromCoreMessages(messages: readonly CoreMessage[]): ChatMessage[] {
  const groups = new Map<string, CoreMessage[]>();
  for (const core of messages) {
    const key = baseId(core.id);
    const group = groups.get(key);
    if (group) group.push(core);
    else groups.set(key, [core]);
  }

  const out: ChatMessage[] = [];
  for (const group of groups.values()) {
    const textCore = group.find((m) => m.contentType === 'text');
    const reasoningCore = group.find((m) => m.contentType === 'reasoning');
    const toolCallCores = group.filter((m) => m.contentType === 'tool-call');
    const toolResultCore = group.find((m) => m.contentType === 'tool-result');
    const first = group[0]!;

    const chat: ContextChatMessage = {
      role: toolResultCore
        ? 'tool'
        : toolCallCores.length > 0
          ? 'assistant'
          : first.role,
      content: toolResultCore
        ? (toolResultCore.text ?? '')
        : (textCore?.text ?? ''),
    };

    if (reasoningCore?.text !== undefined) chat.reasoning = reasoningCore.text;

    if (toolCallCores.length > 0) {
      chat.toolCalls = toolCallCores.map((core) => ({
        id: core.toolCallId ?? core.id,
        name: core.toolName ?? '',
        input: parseInput(core.text),
      }));
    }

    if (toolResultCore) {
      if (toolResultCore.toolCallId !== undefined) {
        chat.toolCallId = toolResultCore.toolCallId;
      }
      if (toolResultCore.toolName !== undefined) {
        chat.toolName = toolResultCore.toolName;
      }
    }

    out.push(chat);
  }
  return out;
}
