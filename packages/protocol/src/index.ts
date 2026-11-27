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
  /** 是否已归档；主列表不返回归档会话。 */
  archived?: boolean;
}

export interface SessionRecord extends SessionSummary {
  createdAt: number;
  messages: ChatMessage[];
}

export interface SessionStore {
  create(title?: string): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | null>;
  list(): Promise<SessionSummary[]>;
  /** 已归档会话。 */
  listArchived(): Promise<SessionSummary[]>;
  /** 归档/恢复；归档不删除消息。 */
  archive(id: string, archived: boolean): Promise<void>;
  /** 跨会话消息搜索；返回命中的会话与片段。 */
  search(query: string, limit?: number): Promise<SessionSearchHit[]>;
  append(id: string, message: ChatMessage): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  snippet: string;
  updatedAt: number;
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
  /** 单个模型的覆盖配置（显示名/窗口/输出/是否启用）。 */
  modelSettings?: Record<string, ProviderModelSettings>;
  enabled: boolean;
  hasApiKey: boolean;
  /** 只显示尾部，如 sk-…a1b2 */
  apiKeyHint: string;
}

/** 单个模型的覆盖配置；未填的字段回落到 provider 级默认值。 */
export interface ProviderModelSettings {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
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
  /** 单个模型的覆盖配置。 */
  modelSettings?: Record<string, ProviderModelSettings>;
  enabled?: boolean;
}

export interface ModelInfo {
  providerId: string;
  providerName: string;
  id: string;
  displayName?: string;
  /** 模型上下文窗口（tokens）。 */
  contextWindow: number;
  maxOutputTokens?: number;
  enabled: boolean;
}

export type RoutingStrategy = 'order' | 'rotate';

export interface ProviderTestResult {
  providerId: string;
  ok: boolean;
  latencyMs: number;
  modelCount?: number;
  error?: string;
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
  /** 按给定 id 顺序重排 provider；未列出的保持相对顺序排在后面。 */
  reorderProviders(ids: string[]): Promise<ProviderPublic[]>;
  /** 对 provider 发一次轻量请求（列模型）验证连通性。 */
  testProvider(id: string): Promise<ProviderTestResult>;
  listModels(): Promise<ModelInfo[]>;
  listUsage(limit?: number): Promise<UsageRecord[]>;
  summary(): Promise<UsageSummary>;
  getSelection(): ModelSelection | null;
  setSelection(selection: ModelSelection | null): Promise<void>;
  getRoutingStrategy(): Promise<RoutingStrategy>;
  setRoutingStrategy(strategy: RoutingStrategy): Promise<void>;
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
// Todo / 自动化（DSH 内置能力对齐）
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface AutomationInput {
  id?: string;
  name: string;
  prompt: string;
  /** 支持 `every 15m` / `every 2h` / `daily 09:30`。 */
  schedule: string;
  enabled: boolean;
}

export interface AutomationPublic {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  lastRun?: number;
  lastStatus?: 'ok' | 'error' | 'running';
  lastError?: string;
  nextRun?: number;
}

/** 生命周期钩子：PreToolUse 退出码 2 可阻断工具。 */
export interface HookConfig {
  id: string;
  name: string;
  event: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart';
  /** 工具事件匹配：空=全部，支持 `write_*`。 */
  matcher?: string;
  command: string;
  timeoutMs?: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// 工作流（ZCode Dynamic Workflow 的最小对齐）
// ---------------------------------------------------------------------------

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type WorkflowPhaseStatus = 'pending' | 'running' | 'done' | 'failed';
export type WorkflowActorStatus = 'queued' | 'running' | 'done' | 'failed';

export interface WorkflowActorState {
  id: string;
  name: string;
  status: WorkflowActorStatus;
  output?: string;
  error?: string;
}

export interface WorkflowPhaseState {
  id: string;
  name: string;
  status: WorkflowPhaseStatus;
  actors: WorkflowActorState[];
}

export interface WorkflowArtifact {
  id: string;
  title: string;
  kind: 'markdown' | 'text';
  content: string;
  createdAt: number;
}

export interface WorkflowRun {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  phases: WorkflowPhaseState[];
  artifacts: WorkflowArtifact[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 右栏：文件 / Git / 终端
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  /** 相对 workspace 的路径。 */
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export interface GitChange {
  path: string;
  /** M/A/D/R/?? 等 porcelain 状态。 */
  status: string;
  staged: boolean;
}

// ---------------------------------------------------------------------------
// 应用设置（服务端持久化，设置页读写）
// ---------------------------------------------------------------------------

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  /** Enter 发送，或 Ctrl/⌘+Enter 发送。 */
  sendKey: 'enter' | 'ctrl-enter';
  /** 是否显示模型思考过程。 */
  reasoningDisplay: boolean;
  /** 界面字号缩放：0.85–1.3，1=标准 14px。 */
  fontScale: number;
  /** 回复语言偏好；auto 跟随用户。 */
  replyLanguage: 'auto' | 'zh-CN' | 'en';
  /** 单轮最多「模型 + 工具」步数。 */
  maxSteps: number;
  /** 是否把项目记忆注入 system prompt。 */
  projectMemory: boolean;
  /** 子智能体最大嵌套层数（1..3）。 */
  subagentMaxDepth: number;
  /** 每个会话最多派发数（1..10）。 */
  subagentMaxPerSession: number;
  /** 子智能体默认使用的 Brain id。 */
  subagentBrainId: string;
  /** 子智能体默认模型；不填则跟随主会话模型。 */
  subagentModel?: ModelSelection | null;
}

// ---------------------------------------------------------------------------
// 技能 / 命令 / MCP（设置 → Agent 能力）
// ---------------------------------------------------------------------------

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
}

export interface McpServerInput {
  id?: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpServerPublic {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
  status: 'connected' | 'error' | 'disabled';
  toolCount: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// 插件管理（设置 → 插件）
// ---------------------------------------------------------------------------

export interface PluginComponent {
  id: string;
  label: string;
  kind: 'tool' | 'brain' | 'feature';
  enabled: boolean;
  /** 不允许关闭（如兜底模型）。 */
  locked?: boolean;
  /** 锁定原因。 */
  lockReason?: string;
}

/** 插件设置字段（代码插件 manifest.settings）。 */
export interface PluginSettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
  description?: string;
}

/** 一个可管理的能力包；内置包 + 安装的 Brain/代码插件。 */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: 'builtin' | 'brain' | 'code';
  builtin: boolean;
  /** 代码插件的运行状态。 */
  status?: 'running' | 'stopped' | 'error';
  error?: string;
  author?: string;
  main?: string;
  /** 代码插件声明的设置字段。 */
  settings?: PluginSettingField[];
  /** 当前配置值（只读展示）。 */
  config?: Record<string, unknown>;
  /** 代码插件贡献的右侧面板。 */
  panel?: { title: string; entry: string };
  enabled: boolean;
  source: string;
  components: PluginComponent[];
  /** 自定义安装的插件可卸载。 */
  removable?: boolean;
}

// ---------------------------------------------------------------------------
// 浏览器 <-> 服务端
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'prompt'; text: string; sessionId?: string }
  | { type: 'cancel' }
  | { type: 'list-sessions' }
  | { type: 'list-archived-sessions' }
  | { type: 'session:archive'; id: string; archived: boolean }
  | { type: 'session:rename'; id: string; title: string }
  | { type: 'open-session'; sessionId: string }
  | { type: 'providers:list' }
  | { type: 'providers:save'; provider: ProviderInput }
  | { type: 'providers:delete'; id: string }
  | { type: 'providers:test'; id: string }
  | { type: 'providers:reorder'; ids: string[] }
  | { type: 'routing:set'; strategy: RoutingStrategy }
  | { type: 'usage:list' }
  | { type: 'selection:set'; selection: ModelSelection | null }
  | { type: 'brains:list' }
  | { type: 'brain:select'; brainId: string }
  | { type: 'permission:set'; mode: PermissionMode }
  | { type: 'approval:response'; id: string; decision: 'allow' | 'deny' }
  | { type: 'partners:list' }
  | { type: 'partners:set'; partner: PartnerConfig }
  | { type: 'plugins:list' }
  | { type: 'plugins:set'; pluginId: string; enabled: boolean }
  | { type: 'plugins:component'; pluginId: string; componentId: string; enabled: boolean }
  | { type: 'plugins:install'; manifest: string }
  | { type: 'plugins:install-local'; path: string }
  | { type: 'plugins:config'; pluginId: string; patch: Record<string, unknown> }
  | { type: 'plugins:uninstall'; pluginId: string }
  | { type: 'settings:get' }
  | { type: 'settings:set'; patch: Partial<AppSettings> }
  | { type: 'personalization:get' }
  | { type: 'personalization:set'; text: string }
  | { type: 'memory:get' }
  | { type: 'memory:set'; text: string }
  | { type: 'skills:list' }
  | { type: 'skills:save'; skill: SkillSummary }
  | { type: 'skills:delete'; id: string }
  | { type: 'commands:list' }
  | { type: 'commands:save'; command: SlashCommand }
  | { type: 'commands:delete'; name: string }
  | { type: 'mcp:list' }
  | { type: 'mcp:save'; server: McpServerInput }
  | { type: 'mcp:delete'; id: string }
  | { type: 'mcp:reconnect'; id: string }
  | { type: 'automations:list' }
  | { type: 'automations:save'; automation: AutomationInput }
  | { type: 'automations:delete'; id: string }
  | { type: 'automations:run'; id: string }
  | { type: 'hooks:list' }
  | { type: 'hooks:save'; hook: HookConfig }
  | { type: 'hooks:delete'; id: string }
  | { type: 'files:tree'; path?: string }
  | { type: 'files:read'; path: string }
  | { type: 'git:status' }
  | { type: 'git:diff'; path: string }
  | { type: 'terminal:create'; cols: number; rows: number }
  | { type: 'terminal:input'; data: string }
  | { type: 'terminal:resize'; cols: number; rows: number }
  | { type: 'terminal:close' }
  | { type: 'workflows:list' }
  | { type: 'workflow:start'; name: string; script: string }
  | { type: 'workflow:cancel'; id: string };

export type ServerMessage =
  | { type: 'ready'; sessionId: string; model?: string; brain?: string; permission?: PermissionMode }
  | { type: 'sessions'; items: SessionSummary[] }
  | { type: 'archived-sessions'; items: SessionSummary[] }
  | { type: 'history'; sessionId: string; messages: ChatMessage[] }
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; name: string; ok: boolean; content: string }
  | { type: 'done'; text: string; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'providers'; items: ProviderPublic[] }
  | { type: 'provider:test'; result: ProviderTestResult }
  | { type: 'routing'; strategy: RoutingStrategy }
  | { type: 'models'; items: ModelInfo[] }
  | { type: 'usage'; items: UsageRecord[]; summary: UsageSummary }
  | { type: 'selection'; selection: ModelSelection | null }
  | { type: 'brains'; items: BrainSummary[]; active: string; official?: string[] }
  | { type: 'brain'; brain: BrainSummary }
  | { type: 'permission'; mode: PermissionMode }
  | { type: 'approval:request'; request: ApprovalRequest }
  | { type: 'partners'; items: PartnerConfig[] }
  | { type: 'plugins'; items: PluginSummary[] }
  | { type: 'settings'; items: AppSettings }
  | { type: 'personalization'; text: string }
  | { type: 'memory'; text: string; path: string }
  | { type: 'skills'; items: SkillSummary[] }
  | { type: 'commands'; items: SlashCommand[] }
  | { type: 'mcp'; items: McpServerPublic[] }
  | { type: 'todos'; sessionId: string; items: TodoItem[] }
  | { type: 'automations'; items: AutomationPublic[] }
  | { type: 'hooks'; items: HookConfig[] }
  | { type: 'files:tree'; path: string; items: FileEntry[] }
  | { type: 'files:read'; file: FileContent }
  | { type: 'git:status'; branch: string; items: GitChange[] }
  | { type: 'git:diff'; path: string; diff: string }
  | { type: 'terminal:ready'; id: string }
  | { type: 'terminal:data'; data: string }
  | { type: 'terminal:exit'; code: number }
  | { type: 'terminal:error'; message: string }
  | { type: 'workflows'; items: WorkflowRun[] }
  | { type: 'workflow'; run: WorkflowRun }
  | { type: 'partner:start'; brainId: string; question: string }
  | { type: 'partner:done'; brainId: string; answer: string }
  | { type: 'subagent:start'; id: string; task: string }
  | {
      type: 'subagent:done';
      id: string;
      status: 'done' | 'failed' | 'cancelled';
      output: string;
    };
