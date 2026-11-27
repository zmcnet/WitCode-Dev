/**
 * 模型路由：order / rotate 挑选 provider，首个非 error chunk 之前失败才切换；
 * 每次尝试都写一条 UsageRecord。selection 由调用方在 request 上给出，并单独持久化。
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  ModelChunk,
  ModelRequest,
  ModelSelection,
  ModelService,
  RoutingStrategy,
  UsageRecord,
} from '@witcode/protocol';
import { isModelEnabled, modelContextWindow } from './model-settings.ts';
import { MIN_CONTEXT_WINDOW } from './registry.ts';
import type { ModelRouter, RouterOptions, StoredProvider } from './types.ts';

const ROUTER_ID = 'model-router';

interface Candidate {
  /** null 表示使用 options.fallback。 */
  provider: StoredProvider | null;
  model: string;
}

interface AttemptOutcome {
  ok: boolean;
  aborted: boolean;
  /** 是否已经产出过非 error chunk；一旦产出就不再切换。 */
  produced: boolean;
  error?: string;
  usage?: { input: number; output: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSelection(value: unknown): value is ModelSelection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerId === 'string' &&
    candidate.providerId.length > 0 &&
    typeof candidate.model === 'string' &&
    candidate.model.length > 0
  );
}

function loadSelection(file: string | undefined): ModelSelection | null {
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isSelection(parsed)) return { providerId: parsed.providerId, model: parsed.model };
  } catch {
    // 文件不存在或内容损坏都视为未设置。
  }
  return null;
}

function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  return value === 'order' || value === 'rotate';
}

/** 同时兼容纯字符串与 { strategy } 两种历史/手写格式。 */
function loadStrategy(file: string | undefined, fallback: RoutingStrategy): RoutingStrategy {
  if (!file) return fallback;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRoutingStrategy(parsed)) return parsed;
    if (typeof parsed === 'object' && parsed !== null && 'strategy' in parsed) {
      const inner = (parsed as { strategy?: unknown }).strategy;
      if (isRoutingStrategy(inner)) return inner;
    }
  } catch {
    // 文件不存在或内容损坏都使用传入的默认策略。
  }
  return fallback;
}

async function writeJsonAtomic(file: string, payload: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, payload, 'utf8');
  try {
    await rename(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows 上 rename 偶尔因目标仍被占用而失败，退一步先删除再替换。
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
      await rm(file, { force: true });
      await rename(tmp, file);
      return;
    }
    throw error;
  }
}

/**
 * 消费单个 provider 的流：
 * - 非 error chunk 原样产出，并标记 produced；
 * - 产出前的 error 只记录，不产出，交给 router 决定切换；
 * - 产出后的 error 原样透传，且不标记成功。
 */
async function* consumeAttempt(
  service: ModelService,
  request: ModelRequest,
  signal: AbortSignal | undefined,
  outcome: AttemptOutcome,
): AsyncGenerator<ModelChunk> {
  if (signal?.aborted) {
    outcome.aborted = true;
    return;
  }

  let errorAfterOutput = false;
  try {
    for await (const chunk of service.stream(request, signal)) {
      if (signal?.aborted) {
        outcome.aborted = true;
        return;
      }

      if (chunk.type === 'error') {
        if (!outcome.error) outcome.error = chunk.message;
        if (!outcome.produced) return;
        errorAfterOutput = true;
        yield chunk;
        continue;
      }

      outcome.produced = true;
      if (chunk.type === 'done') {
        outcome.usage = chunk.usage;
        if (!errorAfterOutput) outcome.ok = true;
      }
      yield chunk;
    }
  } catch (error) {
    if (signal?.aborted) {
      outcome.aborted = true;
      return;
    }
    const message = errorMessage(error);
    if (!outcome.error) outcome.error = message;
    if (outcome.produced) yield { type: 'error', message };
  }
}

export function createModelRouter(options: RouterOptions): ModelRouter {
  const now = options.now ?? (() => Date.now());
  let selection = loadSelection(options.selectionFile);
  /** 运行时可切换；切换后仍按同一套 order/rotate 逻辑挑选候选。 */
  let strategy = loadStrategy(options.strategyFile, options.strategy ?? 'order');
  let rotateIndex = 0;
  /** 本轮 rotate 候选列表在原 enabled 列表中的起点。 */
  let rotationStart = 0;

  async function candidatesFor(request: ModelRequest): Promise<Candidate[]> {
    if (request.selection) {
      const provider = await options.registry.get(request.selection.providerId);
      return provider ? [{ provider, model: request.selection.model }] : [];
    }

    // 自动路由只考虑启用的 provider 中未禁用的模型；禁用的模型仍会由 gateway 返回给 UI 展示。
    const available = (await options.registry.list())
      .map((provider) => ({
        provider,
        models: provider.modelIds.filter((model) => isModelEnabled(provider, model)),
      }))
      .filter((item) => item.provider.enabled && item.models.length > 0);

    if (strategy === 'rotate' && available.length > 0) {
      const start = ((rotateIndex % available.length) + available.length) % available.length;
      rotationStart = start;
      const ordered: Array<(typeof available)[number]> = [];
      for (let offset = 0; offset < available.length; offset += 1) {
        ordered.push(available[(start + offset) % available.length]!);
      }
      return ordered.map((item) => ({ provider: item.provider, model: item.models[0]! }));
    }
    return available.map((item) => ({ provider: item.provider, model: item.models[0]! }));
  }

  async function writeUsage(
    providerId: string,
    model: string,
    startedAt: number,
    outcome: AttemptOutcome,
  ): Promise<void> {
    const record: UsageRecord = {
      at: startedAt,
      providerId,
      model,
      inputTokens: outcome.usage?.input ?? 0,
      outputTokens: outcome.usage?.output ?? 0,
      durationMs: Math.max(0, now() - startedAt),
      ok: outcome.ok,
    };
    if (outcome.error) record.error = outcome.error;
    try {
      await options.usage.append(record);
    } catch {
      // 用量写入不应影响主流程（实现约定本身也不抛错）。
    }
  }

  const router: ModelRouter = {
    id: ROUTER_ID,

    getSelection(): ModelSelection | null {
      return selection ? { ...selection } : null;
    },

    async setSelection(next: ModelSelection | null): Promise<void> {
      if (next) {
        // 硬约束在选型处再守一遍：未知 provider、窗口不足 1M 都拒绝。
        // 模型名不强制在 modelIds 里：允许临时指定同 provider 下的其它模型。
        const provider = await options.registry.get(next.providerId);
        if (!provider) {
          throw new Error(`未知的提供商：${next.providerId}`);
        }
        const window = modelContextWindow(provider, next.model);
        if (window < MIN_CONTEXT_WINDOW) {
          throw new Error(
            `上下文窗口不足 ${MIN_CONTEXT_WINDOW} tokens：${next.providerId}/${next.model}（${window}）`,
          );
        }
        if (!isModelEnabled(provider, next.model)) {
          throw new Error(`模型已禁用：${next.providerId}/${next.model}`);
        }
      }
      selection = next ? { providerId: next.providerId, model: next.model } : null;
      const file = options.selectionFile;
      if (!file) return;

      try {
        if (next === null) {
          await rm(file, { force: true });
          return;
        }
        await writeJsonAtomic(file, `${JSON.stringify(selection)}\n`);
      } catch (error) {
        console.warn(`[witcode] selection 写入失败: ${errorMessage(error)}`);
      }
    },

    getStrategy(): RoutingStrategy {
      return strategy;
    },

    async setStrategy(next: RoutingStrategy): Promise<void> {
      if (!isRoutingStrategy(next)) {
        throw new Error(`未知的路由策略：${String(next)}`);
      }
      strategy = next;
      const file = options.strategyFile;
      if (!file) return;

      try {
        await writeJsonAtomic(file, `${JSON.stringify(strategy)}\n`);
      } catch (error) {
        console.warn(`[witcode] 路由策略写入失败: ${errorMessage(error)}`);
      }
    },

    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelChunk> {
      if (signal?.aborted) return;

      let candidates = await candidatesFor(request);
      const explicit = request.selection != null;
      if (candidates.length === 0) {
        if (!options.fallback) {
          yield { type: 'error', message: '没有可用的模型服务' };
          return;
        }
        candidates = [{ provider: null, model: request.selection?.model ?? 'fallback' }];
      }

      let lastError: string | undefined;

      for (let index = 0; index < candidates.length; index += 1) {
        if (signal?.aborted) return;

        const candidate = candidates[index]!;
        const startedAt = now();
        const outcome: AttemptOutcome = { ok: false, aborted: false, produced: false };
        const providerId = candidate.provider?.id ?? options.fallback?.id ?? 'fallback';
        const canFailover =
          !explicit && candidate.provider !== null && index < candidates.length - 1;

        let service: ModelService;
        try {
          service = candidate.provider
            ? options.createProvider(candidate.provider, candidate.model)
            : options.fallback!;
        } catch (error) {
          if (signal?.aborted) return;
          outcome.error = errorMessage(error);
          await writeUsage(providerId, candidate.model, startedAt, outcome);
          if (!canFailover) {
            yield { type: 'error', message: outcome.error };
            return;
          }
          lastError = outcome.error;
          continue;
        }

        yield* consumeAttempt(service, request, signal, outcome);

        if (outcome.aborted || signal?.aborted) return;

        await writeUsage(providerId, candidate.model, startedAt, outcome);

        if (outcome.ok) {
          if (!explicit && strategy === 'rotate' && candidate.provider) {
            rotateIndex = (rotationStart + index + 1) % candidates.length;
          }
          return;
        }
        // 已经产生输出就不能再切换，否则会重复输出；错误已由 consumeAttempt 透传。
        if (outcome.produced) return;

        if (!canFailover) {
          if (outcome.error) yield { type: 'error', message: outcome.error };
          return;
        }
        if (outcome.error) lastError = outcome.error;
      }

      yield { type: 'error', message: lastError ?? '所有模型服务均不可用' };
    },
  };

  return router;
}
