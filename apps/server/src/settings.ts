/**
 * 应用设置：落盘到 `~/.witcode/settings.json`（可用 WITCODE_DATA_DIR 覆盖）。
 *
 * 设置页的开关/下拉即时保存；服务端在每轮请求前读取最新值，无需重启。
 * 个性化与项目记忆是文本文件，单独读写。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, ModelSelection } from '@witcode/protocol';

const DEFAULTS: AppSettings = {
  theme: 'dark',
  sendKey: 'enter',
  reasoningDisplay: true,
  fontScale: 1,
  replyLanguage: 'auto',
  maxSteps: 20,
  projectMemory: true,
  subagentMaxDepth: 3,
  subagentMaxPerSession: 3,
  subagentBrainId: 'coding',
};

function dataDir(): string {
  return process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 只接受已知字段与合法枚举；未知字段丢弃。 */
export function normalizeSettings(input: unknown, base: AppSettings = DEFAULTS): AppSettings {
  if (typeof input !== 'object' || input === null) return { ...base };
  const raw = input as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;

  return {
    theme: pick(raw.theme, ['dark', 'light', 'system'] as const, base.theme),
    sendKey: pick(raw.sendKey, ['enter', 'ctrl-enter'] as const, base.sendKey),
    reasoningDisplay:
      typeof raw.reasoningDisplay === 'boolean' ? raw.reasoningDisplay : base.reasoningDisplay,
    fontScale: Math.min(1.3, Math.max(0.85, Number.isFinite(Number(raw.fontScale)) ? Number(raw.fontScale) : base.fontScale)),
    replyLanguage: pick(raw.replyLanguage, ['auto', 'zh-CN', 'en'] as const, base.replyLanguage),
    maxSteps: clampInt(raw.maxSteps, 1, 100, base.maxSteps),
    projectMemory:
      typeof raw.projectMemory === 'boolean' ? raw.projectMemory : base.projectMemory,
    subagentMaxDepth: clampInt(raw.subagentMaxDepth, 1, 3, base.subagentMaxDepth),
    subagentMaxPerSession: clampInt(
      raw.subagentMaxPerSession,
      1,
      10,
      base.subagentMaxPerSession,
    ),
    subagentBrainId:
      typeof raw.subagentBrainId === 'string' && raw.subagentBrainId.trim() !== ''
        ? raw.subagentBrainId.trim()
        : base.subagentBrainId,
    ...('subagentModel' in raw ? { subagentModel: normalizeSelection(raw.subagentModel) } : {}),
  };
}

/** 子智能体模型：null/空串表示回到主模型。 */
function normalizeSelection(value: unknown): ModelSelection | undefined {
  if (value === null || value === '') return undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerId !== 'string' || typeof raw.model !== 'string') return undefined;
  if (!raw.providerId.trim() || !raw.model.trim()) return undefined;
  return { providerId: raw.providerId.trim(), model: raw.model.trim() };
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

export interface SettingsService {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
  personalizationPath(): string;
  readPersonalization(): Promise<string>;
  writePersonalization(text: string): Promise<void>;
  memoryPath(): string;
  readMemory(): Promise<string>;
  writeMemory(text: string): Promise<void>;
}

export async function createSettingsService(workspace: string): Promise<SettingsService> {
  const filePath = path.join(dataDir(), 'settings.json');
  let current = { ...DEFAULTS };

  try {
    const text = await fs.readFile(filePath, 'utf8');
    current = normalizeSettings(JSON.parse(text));
  } catch {
    // 首次启动或文件损坏：使用默认值，不阻塞服务。
  }

  const personalizationFile = path.join(dataDir(), 'personalization.md');
  const memoryFile = path.join(workspace, '.witcode', 'memory.md');

  return {
    get() {
      return { ...current };
    },

    async update(patch) {
      current = normalizeSettings({ ...current, ...patch }, current);
      await writeFileAtomic(filePath, `${JSON.stringify(current, null, 2)}\n`);
      return { ...current };
    },

    personalizationPath() {
      return personalizationFile;
    },

    async readPersonalization() {
      try {
        return await fs.readFile(personalizationFile, 'utf8');
      } catch {
        return '';
      }
    },

    async writePersonalization(text) {
      await writeFileAtomic(personalizationFile, text);
    },

    memoryPath() {
      return memoryFile;
    },

    async readMemory() {
      try {
        return await fs.readFile(memoryFile, 'utf8');
      } catch {
        return '';
      }
    },

    async writeMemory(text) {
      await writeFileAtomic(memoryFile, text);
    },
  };
}
