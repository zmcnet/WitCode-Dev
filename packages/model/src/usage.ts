/**
 * 用量存储：每次尝试一行 JSONL，读取时跳过坏行、按时间倒序，并提供聚合汇总。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { UsageRecord, UsageSummary } from '@witcode/protocol';
import type { UsageStore } from './types.ts';

export interface UsageStoreOptions {
  /** 直接指定 jsonl 文件；优先于 dataDir。 */
  filePath?: string;
  /** usage.jsonl 所在目录；默认 WITCODE_DATA_DIR 或 ~/.witcode。 */
  dataDir?: string;
  /** 写盘失败时调用；默认 console.warn，不向调用方抛错。 */
  onError?: (error: unknown) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 解析单行；任何结构异常都视为坏行返回 null。 */
function parseLine(line: string): UsageRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (
    typeof parsed.at !== 'number' ||
    !Number.isFinite(parsed.at) ||
    typeof parsed.providerId !== 'string' ||
    typeof parsed.model !== 'string' ||
    typeof parsed.durationMs !== 'number' ||
    !Number.isFinite(parsed.durationMs) ||
    typeof parsed.ok !== 'boolean'
  ) {
    return null;
  }

  const record: UsageRecord = {
    at: parsed.at,
    providerId: parsed.providerId,
    model: parsed.model,
    inputTokens:
      typeof parsed.inputTokens === 'number' && Number.isFinite(parsed.inputTokens)
        ? parsed.inputTokens
        : 0,
    outputTokens:
      typeof parsed.outputTokens === 'number' && Number.isFinite(parsed.outputTokens)
        ? parsed.outputTokens
        : 0,
    durationMs: parsed.durationMs,
    ok: parsed.ok,
  };
  if (typeof parsed.error === 'string') record.error = parsed.error;
  return record;
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const dataDir = options.dataDir || process.env.WITCODE_DATA_DIR || join(homedir(), '.witcode');
  const filePath = options.filePath ?? join(dataDir, 'usage.jsonl');
  const report =
    options.onError ??
    ((error: unknown) => console.warn(`[witcode] 用量写入失败: ${describe(error)}`));

  async function readAll(): Promise<UsageRecord[]> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      report(error);
      return [];
    }

    const records: UsageRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      const record = parseLine(line);
      if (record) records.push(record);
    }
    return records;
  }

  return {
    async append(record: UsageRecord): Promise<void> {
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      } catch (error) {
        report(error);
      }
    },

    async list(limit = 100): Promise<UsageRecord[]> {
      const records = await readAll();
      // 同一毫秒内的多条记录（失败切换很常见）按写入顺序倒序，保证顺序稳定。
      const ordered = records
        .map((record, index) => ({ record, index }))
        .sort((a, b) => b.record.at - a.record.at || b.index - a.index)
        .map((item) => item.record);
      if (!Number.isFinite(limit) || limit <= 0) return [];
      return ordered.slice(0, Math.floor(limit));
    },

    async summary(): Promise<UsageSummary> {
      const records = await readAll();
      const summary: UsageSummary = {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        byProvider: [],
      };
      const byProvider = new Map<
        string,
        { requests: number; inputTokens: number; outputTokens: number }
      >();

      for (const record of records) {
        summary.totalRequests += 1;
        summary.totalInputTokens += record.inputTokens;
        summary.totalOutputTokens += record.outputTokens;

        const current = byProvider.get(record.providerId) ?? {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        current.requests += 1;
        current.inputTokens += record.inputTokens;
        current.outputTokens += record.outputTokens;
        byProvider.set(record.providerId, current);
      }

      // sort 稳定：请求数相同时保留首次出现顺序。
      summary.byProvider = [...byProvider.entries()]
        .map(([providerId, value]) => ({ providerId, ...value }))
        .sort((a, b) => b.requests - a.requests);
      return summary;
    },
  };
}
