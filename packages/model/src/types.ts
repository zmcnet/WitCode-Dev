/**
 * 模型管家内部接口（服务端使用，不暴露给浏览器）。
 *
 * 分工：
 * - registry：把 provider 配置落盘（providers.json），负责原子写与 key 脱敏。
 * - usage：把每次请求的用量落盘（usage.jsonl），负责汇总。
 * - router：按顺序/轮换挑选 provider，失败切换，并把用量写进 usage。
 * - gateway：把三者组合起来，对上层暴露统一的 ModelService。
 */

import type {
  ModelRequest,
  ModelSelection,
  ModelService,
  ProviderModelSettings,
  ProviderPublic,
  RoutingStrategy,
  UsageRecord,
  UsageSummary,
} from '@witcode/protocol';

/** 落盘的 provider，含明文 key，只在服务端出现。 */
export interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  /** 模型上下文窗口（tokens）；产品硬约束 ≥1M。 */
  contextWindow: number;
  /** 单模型覆盖配置；空对象表示全部回落到 provider 级默认值。 */
  modelSettings: Record<string, ProviderModelSettings>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderRegistry {
  list(): Promise<StoredProvider[]>;
  get(id: string): Promise<StoredProvider | null>;
  save(provider: StoredProvider): Promise<void>;
  remove(id: string): Promise<void>;
  /** 按给定 id 顺序重排并原子落盘；未列出的保持原相对顺序排在后面。 */
  reorder(ids: string[]): Promise<StoredProvider[]>;
}

export interface UsageStore {
  append(record: UsageRecord): Promise<void>;
  list(limit?: number): Promise<UsageRecord[]>;
  summary(): Promise<UsageSummary>;
}

export type { RoutingStrategy };

export interface RouterOptions {
  registry: ProviderRegistry;
  usage: UsageStore;
  /** 根据落盘配置 + 指定模型创建一个可用的 provider 实例。 */
  createProvider(provider: StoredProvider, model: string): ModelService;
  strategy?: RoutingStrategy;
  /** 路由策略持久化文件；不传则只存内存。 */
  strategyFile?: string;
  /** 没有任何可用 provider 时的兜底（环境变量或回声）。 */
  fallback?: ModelService;
  /** selection 持久化文件；不传则只存内存。 */
  selectionFile?: string;
  now?: () => number;
}

export interface ModelRouter extends ModelService {
  getSelection(): ModelSelection | null;
  setSelection(selection: ModelSelection | null): Promise<void>;
  getStrategy(): RoutingStrategy;
  setStrategy(strategy: RoutingStrategy): Promise<void>;
}

export interface GatewayOptions {
  dataDir?: string;
  strategy?: RoutingStrategy;
  /** 直接指定 routing.json 路径；优先于 dataDir。 */
  routingFile?: string;
  fallback?: ModelService;
  /** 测试用：替换默认的 OpenAI 适配器工厂。 */
  createProvider?: (provider: StoredProvider, model: string) => ModelService;
  /** 测试用：替换 testProvider 使用的 fetch（默认使用全局 fetch）。 */
  fetchImpl?: typeof fetch;
}

/** 内部使用的公开视图转换，便于 registry 与 gateway 共用。 */
export interface ProviderView {
  toPublic(provider: StoredProvider): ProviderPublic;
}

export type { ModelRequest, UsageRecord, UsageSummary };
