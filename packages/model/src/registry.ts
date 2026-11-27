/**
 * Provider 注册表：把 provider 配置落盘为 providers.json。
 *
 * 只在服务端使用：落盘内容含明文 apiKey，对外必须走 providerToPublic 脱敏。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderInput, ProviderPublic } from '@witcode/protocol';
import {
  cleanModelSettings,
  MAX_OUTPUT_TOKENS,
  MIN_CONTEXT_WINDOW,
  normalizeModelSettings,
} from './model-settings.ts';
import type { ProviderRegistry, StoredProvider } from './types.ts';

export { MAX_OUTPUT_TOKENS, MIN_CONTEXT_WINDOW } from './model-settings.ts';

interface RegistryOptions {
  filePath?: string;
  dataDir?: string;
}

/** 数据目录下 providers.json 的默认位置。 */
export function defaultProvidersPath(dataDir?: string): string {
  const base = dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
  return path.join(base, 'providers.json');
}

/** 转成可返回给界面的视图，绝不暴露明文 key。 */
export function providerToPublic(provider: StoredProvider): ProviderPublic {
  const apiKey = provider.apiKey ?? '';
  let apiKeyHint = '未设置';
  if (apiKey.length > 0) {
    apiKeyHint = apiKey.length >= 12 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '已设置';
  }

  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    modelIds: [...provider.modelIds],
    contextWindow: provider.contextWindow,
    modelSettings: { ...provider.modelSettings },
    enabled: provider.enabled,
    hasApiKey: apiKey.length > 0,
    apiKeyHint,
  };
}

/** 把用户输入合并成落盘记录；空 key 表示保留原值。 */
export function applyProviderInput(input: ProviderInput, existing?: StoredProvider): StoredProvider {
  const now = Date.now();
  const id = input.id && input.id.trim() !== '' ? input.id : randomUUID();
  const apiKey = input.apiKey !== undefined && input.apiKey !== ''
    ? input.apiKey
    : (existing?.apiKey ?? '');
  const rawModelIds: string[] = Array.isArray(input.modelIds) ? input.modelIds : [];
  const modelIds = [...new Set(rawModelIds.map((item) => item.trim()).filter((item) => item !== ''))];

  const rawWindow = input.contextWindow ?? existing?.contextWindow ?? MIN_CONTEXT_WINDOW;
  if (!Number.isFinite(rawWindow) || rawWindow < MIN_CONTEXT_WINDOW) {
    throw new Error(
      `上下文窗口必须 ≥ ${MIN_CONTEXT_WINDOW} tokens（当前 ${String(rawWindow)}）`,
    );
  }
  const contextWindow = Math.floor(rawWindow);
  const modelSettings = cleanModelSettings(input.modelSettings, modelIds, existing?.modelSettings);

  return {
    id,
    name: (input.name ?? '').trim(),
    baseUrl: (input.baseUrl ?? '').trim(),
    apiKey,
    modelIds,
    contextWindow,
    modelSettings,
    enabled: input.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isStoredProvider(value: unknown): value is StoredProvider {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string'
    && typeof item.baseUrl === 'string'
    && typeof item.apiKey === 'string'
    && Array.isArray(item.modelIds) && item.modelIds.every((entry) => typeof entry === 'string')
    && (item.contextWindow === undefined
      || (typeof item.contextWindow === 'number' && Number.isFinite(item.contextWindow)))
    && (item.modelSettings === undefined
      || (typeof item.modelSettings === 'object'
        && item.modelSettings !== null
        && !Array.isArray(item.modelSettings)))
    && typeof item.enabled === 'boolean'
    && typeof item.createdAt === 'number'
    && typeof item.updatedAt === 'number';
}

class FileProviderRegistry implements ProviderRegistry {
  private readonly filePath: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(): Promise<StoredProvider[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.backupCorruptFile();
      return [];
    }
    if (!Array.isArray(parsed)) {
      await this.backupCorruptFile();
      return [];
    }
    return parsed.filter(isStoredProvider).map((provider) => ({
      ...provider,
      // 旧版 providers.json 没有该字段：按产品底线补 1M，避免历史数据被丢弃。
      contextWindow: provider.contextWindow ?? MIN_CONTEXT_WINDOW,
      // 旧版数据没有模型级覆盖配置：补空对象，全部回落到 provider 默认值。
      modelSettings: normalizeModelSettings(provider.modelSettings),
    }));
  }

  async get(id: string): Promise<StoredProvider | null> {
    const found = (await this.list()).find((provider) => provider.id === id);
    return found ?? null;
  }

  save(provider: StoredProvider): Promise<void> {
    return this.enqueue(async () => {
      const providers = await this.list();
      const index = providers.findIndex((item) => item.id === provider.id);
      if (index === -1) providers.push(provider);
      else providers[index] = provider;
      await this.writeAll(providers);
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const providers = await this.list();
      await this.writeAll(providers.filter((item) => item.id !== id));
    });
  }

  reorder(ids: string[]): Promise<StoredProvider[]> {
    return this.enqueue(async () => {
      const providers = await this.list();
      const byId = new Map(providers.map((provider) => [provider.id, provider]));
      const seen = new Set<string>();
      const ordered: StoredProvider[] = [];

      for (const id of ids) {
        if (seen.has(id)) continue;
        const provider = byId.get(id);
        if (!provider) continue;
        seen.add(id);
        ordered.push(provider);
      }
      // 未列出的保持原相对顺序，排在指定 id 之后。
      for (const provider of providers) {
        if (!seen.has(provider.id)) ordered.push(provider);
      }

      await this.writeAll(ordered);
      return ordered;
    });
  }

  /** 同一实例内串行执行读-改-写，避免并发写坏文件。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async writeAll(providers: StoredProvider[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempFile = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(tempFile, JSON.stringify(providers, null, 2), { mode: 0o600 });
      try {
        await fs.chmod(tempFile, 0o600);
      } catch {
        // Windows 上 chmod 可能失败，权限要求以 POSIX 为准。
      }
      await fs.rename(tempFile, this.filePath);
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async backupCorruptFile(): Promise<void> {
    try {
      await fs.rename(this.filePath, `${this.filePath}.bad-${Date.now()}`);
    } catch {
      // 备份失败也要保证读操作返回空数组而不是崩溃。
    }
  }
}

export function createProviderRegistry(options: RegistryOptions = {}): ProviderRegistry {
  return new FileProviderRegistry(options.filePath ?? defaultProvidersPath(options.dataDir));
}
