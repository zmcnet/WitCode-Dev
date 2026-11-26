import type { ChatMessage } from '@witcode/protocol';
import {
  createCore,
  createInitialState,
  defaultConfig,
  defaultCountTokens,
  type CompressionState,
  type CoreMessage,
  type NudgeDecision,
} from 'acp-kernel';
import { fromCoreMessages, toCoreMessages } from './convert.ts';
import type {
  ContextManager,
  ContextManagerOptions,
  ContextState,
  ContextStateStore,
} from './types.ts';

const DEFAULT_CONTEXT_LIMIT = 200_000;

function createMemoryStore(): ContextStateStore {
  const states = new Map<string, ContextState>();
  return {
    async get(sessionId) {
      return states.get(sessionId) ?? null;
    },
    async set(sessionId, state) {
      states.set(sessionId, state);
    },
    async delete(sessionId) {
      states.delete(sessionId);
    },
  };
}

function countCoreTokens(messages: readonly CoreMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum + defaultCountTokens(message.text ?? '') + (message.thinkingTokens ?? 0),
    0,
  );
}

/** 把内核的结构化决策渲染成简短的“建议压缩哪些范围”文本。 */
function renderNudge(nudge: NudgeDecision | undefined): string | undefined {
  if (!nudge?.shouldInject) return undefined;
  const usage = Math.round(nudge.contextUsage * 100);
  const ranges = nudge.compressibleRanges.map((r) => `${r.startRef}..${r.endRef}`);
  if (ranges.length > 0) {
    return `上下文占用约 ${usage}%，建议压缩以下消息范围：${ranges.join('、')}。请调用 compress 工具写入摘要。`;
  }
  return `上下文占用约 ${usage}%，建议压缩较早的消息（先调用 acp_status 查看可压缩范围）。`;
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
  const mode = options.mode;
  const keepRecent = Math.max(1, options.keepRecent ?? 24);
  const store = options.stateStore ?? createMemoryStore();

  // acp 模式专用：applyCompression 只拿到 call，没有消息列表，
  // 因此缓存最近一次 beforeRequest 转换出的内核消息用于解析 ref 边界。
  const lastCoreMessages = new Map<string, CoreMessage[]>();
  const core = mode === 'acp' ? createCore() : undefined;
  const config =
    mode === 'acp' ? defaultConfig(options.modelContextLimit ?? DEFAULT_CONTEXT_LIMIT) : undefined;

  async function loadState(sessionId: string): Promise<CompressionState> {
    return (await store.get(sessionId)) ?? createInitialState();
  }

  return {
    mode,

    async beforeRequest(sessionId, messages) {
      if (mode === 'off') return { messages: [...messages] };

      if (mode === 'summary') {
        if (messages.length <= keepRecent) return { messages: [...messages] };
        const older = messages.slice(0, messages.length - keepRecent);
        const recent = messages.slice(messages.length - keepRecent);
        const summary = options.summarize ? await options.summarize(older) : undefined;
        const placeholder: ChatMessage = {
          role: 'system',
          content: summary
            ? `更早的 ${older.length} 条消息摘要：\n${summary}`
            : `更早的 ${older.length} 条消息已省略。`,
        };
        return { messages: [placeholder, ...recent] };
      }

      // acp 模式
      const state = await loadState(sessionId);
      const coreMessages = toCoreMessages(messages);
      const tokenCount = countCoreTokens(coreMessages);
      const result = core!.processTurn({
        messages: coreMessages,
        state,
        config: config!,
        tokenCount,
      });
      await store.set(sessionId, result.state);
      lastCoreMessages.set(sessionId, coreMessages);
      return {
        messages: fromCoreMessages(result.messages),
        nudge: renderNudge(result.nudge),
      };
    },

    async applyCompression(sessionId, call) {
      if (mode !== 'acp' || !core || !config) {
        return {
          blocksCreated: 0,
          tokensCompressed: 0,
          errors: ['compression is only available in acp mode'],
        };
      }
      const state = await loadState(sessionId);
      const result = core.applyCompression({
        ranges: call.ranges.map((range) => ({ ...range })),
        messages: lastCoreMessages.get(sessionId) ?? [],
        state,
        config,
      });
      await store.set(sessionId, result.state);
      return {
        blocksCreated: result.result.blocksCreated,
        tokensCompressed: result.result.tokensCompressed,
        errors: result.result.errors,
      };
    },

    async decompress(sessionId, blockId) {
      if (mode !== 'acp' || !core) return undefined;
      return core.decompress(blockId, await loadState(sessionId));
    },

    async search(sessionId, query) {
      if (mode !== 'acp' || !core) return [];
      return core.search(query, await loadState(sessionId));
    },

    async status(sessionId) {
      if (mode !== 'acp' || !core || !config) {
        return { mode, activeBlocks: 0, totalBlocks: 0, tokensCompressed: 0 };
      }
      const state = await loadState(sessionId);
      const tokenCount = countCoreTokens(lastCoreMessages.get(sessionId) ?? []);
      return { mode, ...core.status(state, tokenCount, config) };
    },

    async reset(sessionId) {
      await store.delete(sessionId);
      lastCoreMessages.delete(sessionId);
    },
  };
}
