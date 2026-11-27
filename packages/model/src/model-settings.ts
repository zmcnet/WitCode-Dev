/**
 * 模型级覆盖配置（Magpie 风格）：清洗输入、兼容旧落盘数据、解析单个模型的最终设置。
 *
 * 约定：未填写的字段一律回落到 provider 级默认值，因此清洗后只保留真正指定的字段。
 */

import type { ProviderModelSettings } from '@witcode/protocol';
import type { StoredProvider } from './types.ts';

/** 产品硬约束：模型上下文窗口不得低于 1M tokens。 */
export const MIN_CONTEXT_WINDOW = 1_000_000;

/** 统一最大输出：所有模型强制 128K，防止模型默认值太小。 */
export const MAX_OUTPUT_TOKENS = 128_000;

type SettingsMap = Record<string, ProviderModelSettings>;

function cleanSetting(
  model: string,
  raw: ProviderModelSettings,
  base: ProviderModelSettings,
): ProviderModelSettings {
  const result: ProviderModelSettings = { ...base };

  if ('displayName' in raw) {
    const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    if (name) result.displayName = name;
    else delete result.displayName;
  }

  if ('contextWindow' in raw) {
    const window = raw.contextWindow;
    if (window === undefined) {
      delete result.contextWindow;
    } else if (typeof window !== 'number' || !Number.isFinite(window) || window < MIN_CONTEXT_WINDOW) {
      throw new Error(
        `模型 ${model} 的上下文窗口必须 ≥ ${MIN_CONTEXT_WINDOW} tokens（当前 ${String(window)}）`,
      );
    } else {
      result.contextWindow = Math.floor(window);
    }
  }

  if ('maxOutputTokens' in raw) {
    const tokens = raw.maxOutputTokens;
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      result.maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS, Math.floor(tokens));
    } else {
      delete result.maxOutputTokens;
    }
  }

  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') result.enabled = raw.enabled;
    else delete result.enabled;
  }

  return result;
}

/**
 * 合并并清洗用户输入的模型覆盖配置。
 * - 只保留仍在 modelIds 中的模型；
 * - 输入未提及的字段沿用旧值（编辑 provider 时无需重传全部模型设置）；
 * - 上下文窗口不足 1M 的输入直接拒绝并报错；
 * - 空对象不落盘。
 */
export function cleanModelSettings(
  input: SettingsMap | undefined,
  modelIds: string[],
  existing?: SettingsMap,
): SettingsMap {
  const merged: SettingsMap = {};
  for (const model of modelIds) {
    const base = existing?.[model] ?? {};
    const raw = input?.[model];
    const setting = raw ? cleanSetting(model, raw, base) : { ...base };
    if (Object.keys(setting).length > 0) merged[model] = setting;
  }
  return merged;
}

/** 读取旧数据时容忍缺失/脏字段：能恢复的保留，不能恢复的直接丢弃。 */
export function normalizeModelSettings(value: unknown): SettingsMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const result: SettingsMap = {};
  for (const [model, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const setting: ProviderModelSettings = {};

    if (typeof item.displayName === 'string' && item.displayName.trim()) {
      setting.displayName = item.displayName.trim();
    }
    if (
      typeof item.contextWindow === 'number' &&
      Number.isFinite(item.contextWindow) &&
      item.contextWindow >= MIN_CONTEXT_WINDOW
    ) {
      setting.contextWindow = Math.floor(item.contextWindow);
    }
    if (
      typeof item.maxOutputTokens === 'number' &&
      Number.isFinite(item.maxOutputTokens) &&
      item.maxOutputTokens > 0
    ) {
      setting.maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS, Math.floor(item.maxOutputTokens));
    }
    if (typeof item.enabled === 'boolean') setting.enabled = item.enabled;

    if (Object.keys(setting).length > 0) result[model] = setting;
  }
  return result;
}

/** 单个模型最终生效的覆盖配置；未配置时为空对象。 */
export function modelSettingsFor(provider: StoredProvider, model: string): ProviderModelSettings {
  return provider.modelSettings?.[model] ?? {};
}

export function isModelEnabled(provider: StoredProvider, model: string): boolean {
  return modelSettingsFor(provider, model).enabled ?? provider.enabled;
}

export function modelContextWindow(provider: StoredProvider, model: string): number {
  return modelSettingsFor(provider, model).contextWindow ?? provider.contextWindow;
}

export function modelMaxOutputTokens(provider: StoredProvider, model: string): number {
  return modelSettingsFor(provider, model).maxOutputTokens ?? MAX_OUTPUT_TOKENS;
}
