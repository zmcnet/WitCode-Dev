/**
 * Provider 连通性探测：向 {baseUrl}/models 发一次轻量 GET，验证 key 与可达性。
 * 任何失败都返回 ok:false 的结果，不向调用方抛错。
 */

import type { ProviderTestResult } from '@witcode/protocol';
import type { StoredProvider } from './types.ts';

/** 探测超时：8 秒。 */
export const PROVIDER_TEST_TIMEOUT_MS = 8_000;

/** baseUrl 结尾可以是 /v1、/models 或裸地址；统一拼出列模型地址。 */
export function modelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (normalized.endsWith('/models')) return normalized;
  return `${normalized}/models`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function testProviderConnection(
  provider: StoredProvider,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  const latency = (): number => Math.max(0, Date.now() - startedAt);

  try {
    const response = await fetchImpl(modelsUrl(provider.baseUrl), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        providerId: provider.id,
        ok: false,
        latencyMs: latency(),
        error: `模型服务返回 ${response.status}`,
      };
    }

    const payload: unknown = await response.json();
    const data = typeof payload === 'object' && payload !== null
      ? (payload as { data?: unknown }).data
      : undefined;
    if (!Array.isArray(data)) {
      return {
        providerId: provider.id,
        ok: false,
        latencyMs: latency(),
        error: '响应缺少 data 数组',
      };
    }

    const modelCount = data.filter((item) =>
      typeof item === 'object' && item !== null
      && typeof (item as { id?: unknown }).id === 'string',
    ).length;
    return { providerId: provider.id, ok: true, latencyMs: latency(), modelCount };
  } catch (error) {
    return { providerId: provider.id, ok: false, latencyMs: latency(), error: errorMessage(error) };
  }
}
