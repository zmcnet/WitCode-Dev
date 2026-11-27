/**
 * 定时任务：落盘到 `<dataDir>/automations.json`（可用 WITCODE_DATA_DIR 覆盖）。
 *
 * 只持久化 lastRun/lastStatus/lastError；nextRun 由 schedule 与运行时锚点按需计算，不写盘。
 * 调度语法：`every 15m` / `every 2h` / `daily 09:30`（大小写不敏感）。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AutomationInput, AutomationPublic } from '@witcode/protocol';

const EVERY_RE = /^every\s+(\d+)\s*([mh])$/i;
const DAILY_RE = /^daily\s+(\d{1,2}):(\d{2})$/i;

type StoredAutomation = Omit<AutomationPublic, 'nextRun'>;

interface InternalAutomation extends StoredAutomation {
  /** nextRun 的计算基准（内存态，不落盘）。 */
  anchor: number;
}

type Schedule =
  | { kind: 'every'; ms: number }
  | { kind: 'daily'; hour: number; minute: number };

function parseSchedule(schedule: string): Schedule | null {
  if (typeof schedule !== 'string') return null;
  const text = schedule.trim();

  const every = EVERY_RE.exec(text);
  if (every !== null) {
    const amount = Number(every[1]);
    const unit = every[2]?.toLowerCase();
    if (!Number.isSafeInteger(amount) || amount < 1) return null;
    if (unit !== 'm' && unit !== 'h') return null;
    return { kind: 'every', ms: amount * (unit === 'm' ? 60_000 : 3_600_000) };
  }

  const daily = DAILY_RE.exec(text);
  if (daily !== null) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour > 23 || minute > 59) return null;
    return { kind: 'daily', hour, minute };
  }

  return null;
}

/** 返回严格晚于 from 的下一次执行时间；非法 schedule 返回 null。 */
export function nextRunAt(schedule: string, from: number): number | null {
  if (!Number.isFinite(from)) return null;
  const parsed = parseSchedule(schedule);
  if (parsed === null) return null;
  if (parsed.kind === 'every') return from + parsed.ms;

  const base = new Date(from);
  const target = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    parsed.hour,
    parsed.minute,
    0,
    0,
  );
  if (target.getTime() <= from) target.setDate(target.getDate() + 1);
  return target.getTime();
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

/** 从磁盘条目恢复；坏条目返回 null，跳过而不影响其它条目。 */
function normalizeStored(raw: unknown): StoredAutomation | null {
  if (!isRecord(raw)) return null;
  try {
    const id = requiredText(raw.id, 'id');
    const name = requiredText(raw.name, 'name');
    const prompt = requiredText(raw.prompt, 'prompt');
    const schedule = requiredText(raw.schedule, 'schedule');
    if (parseSchedule(schedule) === null) return null;
    if (typeof raw.enabled !== 'boolean') return null;

    const lastRun =
      typeof raw.lastRun === 'number' && Number.isFinite(raw.lastRun) ? raw.lastRun : undefined;
    const lastStatus = raw.lastStatus === 'ok' || raw.lastStatus === 'error' ? raw.lastStatus : undefined;
    const lastError = typeof raw.lastError === 'string' ? raw.lastError : undefined;

    return {
      id,
      name,
      prompt,
      schedule,
      enabled: raw.enabled,
      ...(lastRun === undefined ? {} : { lastRun }),
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(lastError === undefined ? {} : { lastError }),
    };
  } catch {
    return null;
  }
}

function normalizeInput(input: AutomationInput, from: number): InternalAutomation {
  if (!isRecord(input)) throw new Error('定时任务必须是对象');

  let id: string;
  if (input.id === undefined || input.id === null || input.id === '') {
    id = `auto-${randomUUID()}`;
  } else if (typeof input.id === 'string') {
    id = input.id.trim();
    if (id === '') throw new Error('id 必须是非空字符串');
  } else {
    throw new Error('id 必须是字符串');
  }

  const name = requiredText(input.name, 'name');
  const prompt = requiredText(input.prompt, 'prompt');
  const schedule = requiredText(input.schedule, 'schedule');
  if (parseSchedule(schedule) === null) throw new Error(`schedule 非法：${schedule}`);
  if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');

  return { id, name, prompt, schedule, enabled: input.enabled, anchor: from };
}

function publicOf(item: InternalAutomation): AutomationPublic {
  const nextRun = nextRunAt(item.schedule, item.anchor) ?? undefined;
  return {
    id: item.id,
    name: item.name,
    prompt: item.prompt,
    schedule: item.schedule,
    enabled: item.enabled,
    ...(item.lastRun === undefined ? {} : { lastRun: item.lastRun }),
    ...(item.lastStatus === undefined ? {} : { lastStatus: item.lastStatus }),
    ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
    ...(nextRun === undefined ? {} : { nextRun }),
  };
}

export interface AutomationStoreOptions {
  dataDir?: string;
  /** 到期执行；返回 ok/error。 */
  run: (automation: AutomationPublic) => Promise<{ ok: boolean; error?: string }>;
  now?: () => number;
  /** 检查间隔，默认 30_000。 */
  tickMs?: number;
}

export interface AutomationStore {
  list(): AutomationPublic[];
  save(input: AutomationInput): Promise<AutomationPublic[]>;
  remove(id: string): Promise<AutomationPublic[]>;
  runNow(id: string): Promise<AutomationPublic[]>;
  start(): void;
  stop(): void;
}

export async function createAutomationStore(
  options: AutomationStoreOptions,
): Promise<AutomationStore> {
  const filePath = path.join(resolveDataDir(options.dataDir), 'automations.json');
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? 30_000;
  const bootAt = now();

  const items: InternalAutomation[] = [];
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(parsed)) {
      const seen = new Set<string>();
      for (const raw of parsed) {
        const stored = normalizeStored(raw);
        if (stored === null || seen.has(stored.id)) continue;
        seen.add(stored.id);
        items.push({ ...stored, anchor: stored.lastRun ?? bootAt });
      }
    }
  } catch {
    // 首次启动或文件损坏：空数组，不阻塞服务。
  }

  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const persist = async (): Promise<void> => {
    const stored: StoredAutomation[] = items.map(({ anchor: _anchor, ...rest }) => rest);
    await writeFileAtomic(filePath, `${JSON.stringify(stored, null, 2)}\n`);
  };
  const snapshot = (): AutomationPublic[] => items.map(publicOf);

  const execute = async (item: InternalAutomation): Promise<void> => {
    if (running.has(item.id)) return;
    running.add(item.id);
    try {
      let result: { ok: boolean; error?: string };
      try {
        result = await options.run(publicOf(item));
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const finishedAt = now();
      item.lastRun = finishedAt;
      item.anchor = finishedAt;
      item.lastStatus = result.ok ? 'ok' : 'error';
      item.lastError = result.ok ? undefined : (result.error ?? '执行失败');
      await persist();
    } catch {
      // 落盘失败不中断调度，下次到期仍会重试。
    } finally {
      running.delete(item.id);
    }
  };

  const tick = (): void => {
    const current = now();
    for (const item of items) {
      if (!item.enabled || running.has(item.id)) continue;
      const due = nextRunAt(item.schedule, item.anchor);
      if (due === null || due > current) continue;
      void execute(item);
    }
  };

  return {
    list: snapshot,

    async save(input) {
      const next = normalizeInput(input, now());
      const index = items.findIndex((item) => item.id === next.id);
      if (index >= 0) {
        const previous = items[index];
        items[index] = {
          ...next,
          ...(previous?.lastRun === undefined ? {} : { lastRun: previous.lastRun }),
          ...(previous?.lastStatus === undefined ? {} : { lastStatus: previous.lastStatus }),
          ...(previous?.lastError === undefined ? {} : { lastError: previous.lastError }),
        };
      } else {
        items.push(next);
      }
      await persist();
      return snapshot();
    },

    async remove(id) {
      const key = typeof id === 'string' ? id.trim() : '';
      const before = items.length;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index]?.id === key) items.splice(index, 1);
      }
      if (items.length !== before) await persist();
      return snapshot();
    },

    async runNow(id) {
      const key = typeof id === 'string' ? id.trim() : '';
      const item = items.find((candidate) => candidate.id === key);
      if (item === undefined || running.has(item.id)) return snapshot();
      await execute(item);
      return snapshot();
    },

    start() {
      if (timer !== undefined) return;
      timer = setInterval(tick, tickMs);
    },

    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
