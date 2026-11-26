/**
 * 前后端共享的协议类型。
 *
 * 约定：浏览器、服务端、插件只通过这里的类型通信，不跨层 import 实现。
 * P1 起加入工具、会话、模型三组契约。
 */

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息可以带工具调用（OpenAI 格式需要） */
  toolCalls?: ToolCall[];
  /** role=tool 时，对应哪次工具调用 */
  toolCallId?: string;
  /** role=tool 时，工具名 */
  toolName?: string;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** 当前工作目录（绝对路径） */
  workspace: string;
  signal?: AbortSignal;
  /** 当前会话 id；上下文工具需要。 */
  sessionId?: string;
  /** 当前子智能体深度：0=主智能体，1..3=子智能体。 */
  depth?: number;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  error?: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';

/** 确认弹窗需要展示的内容；由工具提供，执行时使用同一份入参。 */
export interface ApprovalPreview {
  title: string;
  detail: string;
  riskLevel: RiskLevel;
}

/** 一次待确认的工具调用。 */
export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  riskLevel: RiskLevel;
  reason: string;
}

// ---------------------------------------------------------------------------
// 协作：伙伴 / 子智能体 / 工作流
// ---------------------------------------------------------------------------

/** 一个伙伴槽位：可单独启用/禁用，可单独选脑子与模型。 */
export interface PartnerConfig {
  slot: 1 | 2;
  enabled: boolean;
  brainId: string;
  /** 不填则用主会话当前模型。 */
  model?: ModelSelection;
}

export interface PartnerConsultResult {
  brainId: string;
  answer: string;
}

export interface SubagentTaskResult {
  id: string;
  status: 'done' | 'failed' | 'cancelled';
  output: string;
  filesChanged?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema，描述输入；模型和界面都靠它 */
  inputSchema: Record<string, unknown>;
  /** 只读工具可并行、通常不需要确认。 */
  readOnly?: boolean;
  /** 破坏性工具必须串行，且默认需要确认。 */
  destructive?: boolean;
  /** 是否允许与其他工具并行。 */
  concurrentSafe?: boolean;
  riskLevel?: RiskLevel;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** 权限判定前把模型入参归一化为执行事实；防止“批准 A 执行 B”。 */
  resolveInput?(input: unknown, ctx: ToolContext): Promise<unknown>;
  /** 生成确认预览；失败按 fail-closed 处理。 */
  prepareApproval?(input: unknown, ctx: ToolContext): Promise<ApprovalPreview>;
}

export interface ToolService {
  register(tool: ToolDefinition): () => void;
  list(): ToolDefinition[];
  run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface SessionRecord extends SessionSummary {
  createdAt: number;
  messages: ChatMessage[];
}

export interface SessionStore {
  create(title?: string): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  list(): Promise<SessionSummary[]>;
  append(id: string, message: ChatMessage): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'done'; usage?: { input: number; output: number } }
  | { type: 'error'; message: string };

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>>;
  /** 指定用哪个 provider/model；不填则由网关路由决定。 */
  selection?: ModelSelection;
}

export interface ModelService {
  readonly id: string;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>;
}

/** 单个模型适配器（如 OpenAI 兼容）。 */
export type ModelProvider = ModelService;

// ---------------------------------------------------------------------------
// 模型管家（P2）
// ---------------------------------------------------------------------------

export interface ModelSelection {
  providerId: string;
  model: string;
}

/** 返回给界面的提供商信息；不包含明文 key。 */
export interface ProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  modelIds: string[];
  /** 模型上下文窗口（tokens）；产品硬约束 ≥1M。 */
  contextWindow: number;
  enabled: boolean;
  hasApiKey: boolean;
  /** 只显示尾部，如 sk-…a1b2 */
  apiKeyHint: string;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  /** 留空表示保留原 key。 */
  apiKey?: string;
  modelIds: string[];
  /** 模型上下文窗口（tokens）；低于 1M 拒绝保存，不填默认 1M。 */
  contextWindow?: number;
  enabled?: boolean;
}

export interface ModelInfo {
  providerId: string;
  providerName: string;
  id: string;
  /** 模型上下文窗口（tokens）。 */
  contextWindow: number;
}

export interface UsageRecord {
  at: number;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Array<{
    providerId: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/** 服务端内部的模型网关；前端不直接使用。 */
export interface ModelGateway extends ModelService {
  listProviders(): Promise<ProviderPublic[]>;
  saveProvider(input: ProviderInput): Promise<ProviderPublic>;
  deleteProvider(id: string): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  listUsage(limit?: number): Promise<UsageRecord[]>;
  summary(): Promise<UsageSummary>;
  getSelection(): ModelSelection | null;
  setSelection(selection: ModelSelection | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Brain（可插拔的“脑子”）
// ---------------------------------------------------------------------------

/** 展示用的脑子摘要。 */
export interface BrainSummary {
  id: string;
  name: string;
  description: string;
  /** 这个脑子适合什么任务 */
  bestFor: string[];
}

export interface BrainMode {
  id: string;
  name: string;
  prompt: string;
  /** 该模式下是否禁止写操作（由权限层保证，不只靠提示词） */
  readOnly?: boolean;
}

export interface BrainToolPolicy {
  /** 只启用这些工具；不填=全部 */
  enabled?: string[];
  disabled?: string[];
  /** 覆盖工具描述（何时用/何时不用） */
  descriptions?: Record<string, string>;
}

export interface BrainContextPolicy {
  projectMemory?: boolean;
  git?: boolean;
  environment?: boolean;
  /** 额外固定段落，按顺序拼进 system prompt */
  sections?: Array<{ title: string; content: string; stable?: boolean }>;
}

export interface BrainPrompts {
  compact?: string;
  plan?: string;
  review?: string;
  subagent?: string;
}

export interface BrainLoopPolicy {
  maxSteps?: number;
  verifyAfterWrite?: 'none' | 'typecheck' | 'test';
  askBeforeWrite?: boolean;
}

export interface BrainFlowPolicy {
  tool?: {
    /** 执行前先把入参归一化，再判权限（ZCode 式） */
    resolveBeforePermission?: boolean;
    parallel?: boolean;
    maxConcurrent?: number;
  };
  compaction?: {
    strategy?: 'summary' | 'acp';
    failureLimit?: number;
  };
  approval?: 'fail-closed' | 'ask' | 'yolo';
}

export interface BrainModelProfile {
  preferredModels?: string[];
  reasoning?: 'separate' | 'inline' | 'none';
  toolCallFormat?: 'openai' | 'anthropic' | 'glm' | 'deepseek';
  cache?: 'prefix' | 'none';
  emptyResponseRetry?: boolean;
}

/** 用户级权限模式：模式本身是总开关，Brain 只能建议。 */
export type PermissionMode = 'read-only' | 'normal' | 'autonomous' | 'full';

export interface PermissionRule {
  id: string;
  match: {
    tool?: string;
    pathPrefix?: string;
    commandPrefix?: string;
  };
  decision: 'allow' | 'ask' | 'deny';
  reason?: string;
}

/**
 * Brain 自带的执行框架配置。
 * 切换 Brain = 换整套执行配置；Harness 提供策略库，Brain 选组合。
 */
export interface BrainExecution {
  /** 适配过的执行框架标识，如 native / zcode / dsh / codex。 */
  profile?: string;
  permission?: {
    preferredMode?: PermissionMode;
    rules?: PermissionRule[];
  };
  tool?: {
    contract?: 'simple' | 'zcode' | 'dsh';
    enabled?: string[];
    disabled?: string[];
    descriptions?: Record<string, string>;
  };
  scheduler?: {
    parallel?: boolean;
    maxConcurrent?: number;
  };
  verify?: {
    afterWrite?: 'none' | 'typecheck' | 'test';
  };
  compaction?: {
    strategy?: 'off' | 'summary' | 'acp';
  };
  approval?: 'fail-closed' | 'ask' | 'auto';
}

/** 一个“脑子”的完整定义。L1 提示词 / L2 模型适配 / L3 流程策略。 */
export interface BrainDefinition extends BrainSummary {
  /** 人格与工作法（system prompt 稳定段） */
  identity: string;
  /** 硬规则 */
  rules: string[];
  tools: BrainToolPolicy;
  modes?: BrainMode[];
  context?: BrainContextPolicy;
  prompts?: BrainPrompts;
  loop?: BrainLoopPolicy;
  flow?: BrainFlowPolicy;
  modelProfile?: BrainModelProfile;
  /** 执行框架；存在时优先于 flow/tool。 */
  execution?: BrainExecution;
}

// ---------------------------------------------------------------------------
// 浏览器 <-> 服务端
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'prompt'; text: string; sessionId?: string }
  | { type: 'cancel' }
  | { type: 'list-sessions' }
  | { type: 'open-session'; sessionId: string }
  | { type: 'providers:list' }
  | { type: 'providers:save'; provider: ProviderInput }
  | { type: 'providers:delete'; id: string }
  | { type: 'usage:list' }
  | { type: 'selection:set'; selection: ModelSelection | null }
  | { type: 'brains:list' }
  | { type: 'brain:select'; brainId: string }
  | { type: 'permission:set'; mode: PermissionMode }
  | { type: 'approval:response'; id: string; decision: 'allow' | 'deny' }
  | { type: 'partners:list' }
  | { type: 'partners:set'; partner: PartnerConfig };

export type ServerMessage =
  | { type: 'ready'; sessionId: string; model?: string; brain?: string; permission?: PermissionMode }
  | { type: 'sessions'; items: SessionSummary[] }
  | { type: 'history'; sessionId: string; messages: ChatMessage[] }
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; name: string; ok: boolean; content: string }
  | { type: 'done'; text: string; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'providers'; items: ProviderPublic[] }
  | { type: 'models'; items: ModelInfo[] }
  | { type: 'usage'; items: UsageRecord[]; summary: UsageSummary }
  | { type: 'selection'; selection: ModelSelection | null }
  | { type: 'brains'; items: BrainSummary[]; active: string; official?: string[] }
  | { type: 'brain'; brain: BrainSummary }
  | { type: 'permission'; mode: PermissionMode }
  | { type: 'approval:request'; request: ApprovalRequest }
  | { type: 'partners'; items: PartnerConfig[] }
  | { type: 'partner:start'; brainId: string; question: string }
  | { type: 'partner:done'; brainId: string; answer: string }
  | { type: 'subagent:start'; id: string; task: string }
  | {
      type: 'subagent:done';
      id: string;
      status: 'done' | 'failed' | 'cancelled';
      output: string;
    };
