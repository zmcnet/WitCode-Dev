/**
 * 模型网关：把 registry / usage / router 组合成对上层统一的 ModelService。
 *
 * 设计要点：
 * - 上层（agent loop / server）只看到 ModelService，不关心 provider 怎么选。
 * - 当前 selection 在这里注入到每个请求；router 自身不隐式使用它。
 * - 所有落盘路径默认在 `${WITCODE_DATA_DIR ?? ~/.witcode}` 下。
 */

import os from 'node:os';
import path from 'node:path';
import type {
  ModelGateway,
  ModelInfo,
  ModelRequest,
  ProviderInput,
  ProviderPublic,
  ProviderTestResult,
  RoutingStrategy,
  UsageRecord,
  UsageSummary,
} from '@witcode/protocol';
import {
  modelContextWindow,
  modelMaxOutputTokens,
  modelSettingsFor,
} from './model-settings.ts';
import { createOpenAIProvider, createProviderFromEnv } from './openai.ts';
import { testProviderConnection } from './provider-test.ts';
import {
  applyProviderInput,
  createProviderRegistry,
  MAX_OUTPUT_TOKENS,
  providerToPublic,
} from './registry.ts';
import { createModelRouter } from './router.ts';
import { createUsageStore } from './usage.ts';
import type { GatewayOptions } from './types.ts';

export async function createModelGateway(options: GatewayOptions = {}): Promise<ModelGateway> {
  const dataDir =
    options.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
  const routingFile = options.routingFile ?? path.join(dataDir, 'routing.json');

  const registry = createProviderRegistry({ dataDir });
  const usage = createUsageStore({ dataDir });

  const createProvider =
    options.createProvider ??
    ((provider, model) =>
      createOpenAIProvider({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model,
        // 强制 128K 输出，不跟随模型默认值（很多模型默认只有 4K）。
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }));

  const router = createModelRouter({
    registry,
    usage,
    createProvider,
    strategy: options.strategy ?? 'order',
    strategyFile: routingFile,
    selectionFile: path.join(dataDir, 'selection.json'),
    fallback: options.fallback ?? createProviderFromEnv() ?? undefined,
  });

  return {
    id: 'model-gateway',

    stream(request: ModelRequest, signal?: AbortSignal) {
      const selection = router.getSelection();
      const effective =
        selection && !request.selection ? { ...request, selection } : request;
      return router.stream(effective, signal);
    },

    getSelection: () => router.getSelection(),
    setSelection: (selection) => router.setSelection(selection),

    async getRoutingStrategy(): Promise<RoutingStrategy> {
      return router.getStrategy();
    },
    setRoutingStrategy: (strategy) => router.setStrategy(strategy),

    async listProviders(): Promise<ProviderPublic[]> {
      return (await registry.list()).map(providerToPublic);
    },

    async saveProvider(input: ProviderInput): Promise<ProviderPublic> {
      const existing = input.id ? await registry.get(input.id) : null;
      const provider = applyProviderInput(input, existing ?? undefined);
      await registry.save(provider);
      return providerToPublic(provider);
    },

    async deleteProvider(id: string): Promise<void> {
      await registry.remove(id);

      // 删掉的正好是当前选择时，清空选择，避免下一次请求指向不存在的 provider。
      const selection = router.getSelection();
      if (selection?.providerId === id) {
        await router.setSelection(null);
      }
    },

    async reorderProviders(ids: string[]): Promise<ProviderPublic[]> {
      const reordered = await registry.reorder(ids);
      return reordered.map(providerToPublic);
    },

    async testProvider(id: string): Promise<ProviderTestResult> {
      const provider = await registry.get(id);
      if (!provider) {
        return { providerId: id, ok: false, latencyMs: 0, error: `未知的提供商：${id}` };
      }
      return testProviderConnection(provider, options.fetchImpl);
    },

    async listModels(): Promise<ModelInfo[]> {
      const providers = await registry.list();
      // 禁用模型也要返回供 UI 展示；是否参与自动路由由 router 决定。
      return providers.flatMap((provider) =>
        provider.modelIds.map((id): ModelInfo => {
          const settings = modelSettingsFor(provider, id);
          return {
            providerId: provider.id,
            providerName: provider.name,
            id,
            displayName: settings.displayName,
            contextWindow: modelContextWindow(provider, id),
            maxOutputTokens: modelMaxOutputTokens(provider, id),
            enabled: settings.enabled ?? provider.enabled,
          };
        }),
      );
    },

    listUsage: (limit?: number): Promise<UsageRecord[]> => usage.list(limit),
    summary: (): Promise<UsageSummary> => usage.summary(),
  };
}
