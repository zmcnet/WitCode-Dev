import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Kernel } from '@witcode/kernel';
import type {
  ChatMessage,
  ClientMessage,
  ServerMessage,
  ToolService,
} from '@witcode/protocol';
import { createEchoProvider } from '@witcode/plugin-echo';
import { createSqliteSessionStore } from '@witcode/session';
import { createToolService, registerBuiltinTools } from '@witcode/tools';
import { createModelGateway } from '@witcode/model';
import { defaultBrainId, getBrain, listBrains, officialBrainIds } from '@witcode/brains';
import { contextTools, createContextManager } from '@witcode/context';
import { createSecurity } from '@witcode/security';
import { runAgentLoop } from './agent-loop.js';
import { loadProjectMemory } from './project-memory.js';
import { buildSystemPrompt } from './brain-prompt.js';
import { createScriptedProvider } from './scripted-provider.js';
import { createPartnerService } from './partner.js';
import { createPartnerRegistry } from './partner-registry.js';
import { partnerTool } from './partner-tool.js';
import { createSubagentService } from './subagent.js';
import { subagentTool } from './subagent-tool.js';
import { createSettingsService } from './settings.js';
import { createSkillStore, createSkillTool, createCommandStore } from './skills.js';
import { createTodoStore, createTodoTools } from './todos.js';
import { createGoalStore, createGoalTools } from './goals.js';
import { createJobTools } from './jobs.js';
import { createFileTools } from './file-tools.js';
import { createSessionTools } from './session-tools.js';
import { createWorkspaceFiles } from './workspace-files.js';
import { createTerminal } from './terminal.js';
import { createWorkflowService } from './workflow.js';
import type { TerminalSession } from './terminal.js';
import { createWebTools } from './web-tools.js';
import { createAutomationStore } from './automations.js';
import { createHookStore, createHookRunner } from './hooks.js';
import type { HookRunner } from './hooks.js';
import { createPluginManager } from './plugins.js';
import { createPluginRuntime, pluginAssetPath } from './plugin-runtime.js';
import type { PluginManager } from './plugins.js';
import type { ToolDefinition } from '@witcode/protocol';
import { createMcpManager } from './mcp.js';
import type { McpManager } from './mcp.js';

// 产品端口：同一端口同时提供 Web 页面（apps/web/dist）与 /ws。
// 内网穿透只需要映射这一个端口；开发时 Vite 用 5173 代理回来。
const port = Number(process.env.PORT ?? 21004);
const connections = new Set<(message: ServerMessage) => void>();
const workspace = path.resolve(process.env.WITCODE_WORKSPACE ?? process.cwd());
const modelMode = process.env.WITCODE_MODEL_MODE ?? 'auto';

// 当前使用哪个“脑子”。会话级选择后续再做，先全局。
let activeBrainId = defaultBrainId();

const kernel = new Kernel();
const fallbackLabel = modelMode === 'scripted' ? 'scripted' : 'echo';

// 模型网关：多 provider、路由、失败切换、用量。
// 没有任何可用 provider（或未配置 key）时，回落到剧本模型（测试）或回声，保证链路永远可用。
const gateway = await createModelGateway({
  strategy: (process.env.WITCODE_ROUTE_STRATEGY as 'order' | 'rotate') ?? 'order',
  fallback:
    modelMode === 'scripted' || modelMode === 'collab'
      ? createScriptedProvider(modelMode === 'collab' ? 'collab' : 'read')
      : createEchoProvider(),
});
kernel.provide('model', gateway);
console.log(`[witcode] model gateway ready（无可用 provider 时兜底：${fallbackLabel}）`);

function modelLabel(): string {
  const selection = gateway.getSelection();
  return selection ? `${selection.providerId}/${selection.model}` : fallbackLabel;
}

const sessions = createSqliteSessionStore();
kernel.provide('sessions', sessions);

const tools = createToolService();
registerBuiltinTools(tools);
kernel.provide('tools', tools);

const contextMode = (process.env.WITCODE_CONTEXT_MODE as 'off' | 'summary' | 'acp') ?? 'off';
const contextManager = createContextManager({
  mode: contextMode,
  // 输入窗口 1M：消息预算 800K，system 预算 200K（由 brain-prompt 截断）。
  modelContextLimit: Number(process.env.WITCODE_CONTEXT_LIMIT ?? 800_000),
});
if (contextMode === 'acp') {
  for (const tool of contextTools(contextManager)) {
    tools.register(tool);
  }
}
console.log(`[witcode] context: ${contextMode}`);

/**
 * 插件门闸：设置里的插件开关实时生效。
 * 工具、脑子、记忆、上下文都从这里判断，避免「UI 关了但模型还能用」。
 */
let pluginManager: PluginManager | null = null;
let hookRunnerRef: HookRunner | null = null;
const CONTEXT_TOOL_NAMES = new Set(['compress', 'decompress', 'search_context', 'acp_status']);

const gatedTools: ToolService = {
  register(tool) {
    return tools.register(tool);
  },
  list() {
    return tools.list().filter((tool) => {
      if (pluginManager?.isToolEnabled(tool.name) === false) return false;
      if (CONTEXT_TOOL_NAMES.has(tool.name) && pluginManager?.isFeatureEnabled('context') === false) {
        return false;
      }
      return true;
    });
  },
  async run(name, input, ctx) {
    if (pluginManager?.isToolEnabled(name) === false) {
      return { ok: false, content: '', error: `插件已禁用：${name}` };
    }
    if (CONTEXT_TOOL_NAMES.has(name) && pluginManager?.isFeatureEnabled('context') === false) {
      return { ok: false, content: '', error: '上下文内核插件已禁用' };
    }

    const payload = {
      WITCODE_TOOL_NAME: name,
      WITCODE_TOOL_INPUT: JSON.stringify(input ?? null).slice(0, 8000),
      WITCODE_SESSION_ID: ctx.sessionId ?? '',
    };
    if (hookRunnerRef) {
      const pre = await hookRunnerRef.run('PreToolUse', payload);
      if (pre.blocked) {
        return {
          ok: false,
          content: '',
          error: `钩子阻断：${pre.message ?? pre.logs.at(-1) ?? 'PreToolUse 拒绝'}`,
        };
      }
    }

    const result = await tools.run(name, input, ctx);

    if (hookRunnerRef) {
      await hookRunnerRef.run('PostToolUse', {
        ...payload,
        WITCODE_TOOL_RESULT: (result.ok ? result.content : result.error ?? '').slice(0, 8000),
      });
    }
    return result;
  },
};

/** 过滤掉被停用的脑子；全停时兜底到 native，保证 Harness 永远可用。 */
function visibleBrains() {
  const all = listBrains();
  const enabled = pluginManager ? all.filter((brain) => pluginManager!.isBrainEnabled(brain.id)) : all;
  return enabled.length > 0 ? enabled : all.filter((brain) => brain.id === 'native');
}

function enabledBrain(id: string) {
  const brain = getBrain(id);
  if (brain && pluginManager?.isBrainEnabled(brain.id) !== false) return brain;
  const fallback = getBrain(defaultBrainId());
  if (fallback && pluginManager?.isBrainEnabled(fallback.id) !== false) return fallback;
  return getBrain('native');
}

const security = createSecurity({ workspace, mode: 'normal' });
console.log(`[witcode] permission: ${security.permission.getMode()}`);

const workspaceFiles = createWorkspaceFiles({
  workspace,
  checkRead: (absPath) => security.pathGuard.checkForRead(absPath),
});

// 应用设置：设置页即时保存，服务端每轮读取最新值。
const appSettings = await createSettingsService(workspace);

// 技能与斜杠命令：本地 JSON 存储，设置页可增删改。
const skillStore = await createSkillStore();
const commandStore = await createCommandStore();
tools.register(createSkillTool(skillStore));

const todoStore = await createTodoStore();
for (const tool of createTodoTools(todoStore)) tools.register(tool);

const goalStore = await createGoalStore();
for (const tool of createGoalTools(goalStore)) tools.register(tool);
for (const tool of createJobTools()) tools.register(tool);
for (const tool of createFileTools()) tools.register(tool);
for (const tool of createSessionTools(sessions)) tools.register(tool);
for (const tool of createWebTools()) tools.register(tool);

const hookStore = await createHookStore();
const hookRunner = createHookRunner({ store: hookStore });
hookRunnerRef = hookRunner;

// 伙伴：另一个脑子的视角，只读；主会话历史由这里注入。
// 槽位按会话存储：2 个槽位可独立启用/禁用，各自选脑子与模型。
const partnerRegistry = createPartnerRegistry();
const partner = createPartnerService({
  provider: gateway,
  tools: gatedTools,
  workspace,
  registry: partnerRegistry,
});
const partnerDefinition = partnerTool(partner);
tools.register({
  ...partnerDefinition,
  async execute(input, ctx) {
    const record = ctx.sessionId ? await sessions.get(ctx.sessionId) : null;
    const withHistory =
      typeof input === 'object' && input !== null
        ? { ...input, history: record?.messages ?? [] }
        : input;
    return partnerDefinition.execute(withHistory, ctx);
  },
});

// 子智能体：独立会话、继承权限、最多 3 层；每个主会话最多 3 个。
const subagents = createSubagentService({
  provider: gateway,
  tools: gatedTools,
  sessions,
  security,
  workspace,
  maxSubagents: 999,
  maxDepth: () => appSettings.get().subagentMaxDepth,
  defaultBrainId: () => appSettings.get().subagentBrainId,
  model: () => appSettings.get().subagentModel ?? undefined,
});
const subagentDefinition = subagentTool(subagents);
const subagentCounts = new Map<string, number>();
tools.register({
  ...subagentDefinition,
  async execute(input, ctx) {
    const key = ctx.sessionId ?? 'default';
    const used = subagentCounts.get(key) ?? 0;
    const limit = appSettings.get().subagentMaxPerSession;
    if (used >= limit) {
      return {
        ok: false,
        content: '',
        error: `本会话的子智能体数量已达上限（${limit}）`,
      };
    }
    subagentCounts.set(key, used + 1);
    return subagentDefinition.execute(input, ctx);
  },
});

// 自动化：到期后交给子智能体执行，结果落在独立会话里。
const automationStore = await createAutomationStore({
  run: async (automation) => {
    try {
      const result = await subagents.spawn({ task: automation.prompt });
      return result.status === 'done'
        ? { ok: true }
        : { ok: false, error: result.output || result.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
automationStore.start();

// 生产托管：如果 web 已经构建（apps/web/dist），直接由同一端口提供页面与 /ws。
// 内网穿透只映射一个端口即可，也避开 Vite dev 的 HMR / 依赖优化在穿透下的白屏。
const webDist = path.resolve(
  process.env.WITCODE_WEB_DIST ?? path.join(import.meta.dirname, '..', '..', 'web', 'dist'),
);

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveWeb(urlPath: string, res: import('node:http').ServerResponse): Promise<boolean> {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  // 只允许访问 dist 内的文件
  const filePath = path.join(webDist, clean === '/' ? 'index.html' : clean);
  const relative = path.relative(webDist, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': clean.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    // SPA 回退：无扩展名的路径交给前端路由
    if (path.extname(clean) === '') {
      try {
        const index = await readFile(path.join(webDist, 'index.html'));
        res.writeHead(200, { 'content-type': mimeTypes['.html'], 'cache-control': 'no-cache' });
        res.end(index);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// 插件管理器：内置能力包 + 本地 Brain 插件；开关落盘并即时生效。
// 工作流：模型写 JS 编排脚本，独立子进程执行，ask 交给子智能体。
const workflowService = await createWorkflowService({
  spawn: async (task) => {
    try {
      const result = await subagents.spawn({ task });
      return {
        ok: result.status === 'done',
        output: result.output,
        ...(result.status === 'done' ? {} : { error: result.output || result.status }),
      };
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  onUpdate: (run) => {
    for (const broadcast of connections) broadcast({ type: 'workflow', run });
  },
});

const workflowTool: ToolDefinition = {
  name: 'create_workflow',
  description: [
    '启动一个后台工作流：你写一段 JS 编排脚本，用 agent()/ask() 并发调度子智能体，phase() 标记阶段，artifact() 交付产物。',
    '脚本示例：phase("分析"); const a = agent("架构师"); const out = await a.ask("分析需求"); artifact("分析报告", out);',
    '什么时候用：任务可以拆成多个相互独立或分阶段的子任务、且希望后台并发执行时。',
    '什么时候不用：普通单线程编码/问答，直接用工具即可。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工作流名称' },
      script: { type: 'string', description: 'JS 编排脚本（使用 agent/ask/phase/artifact）' },
    },
    required: ['name', 'script'],
  },
  destructive: true,
  riskLevel: 'high',
  concurrentSafe: false,
  async prepareApproval(input) {
    const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    return {
      title: `运行工作流：${typeof raw.name === 'string' ? raw.name : '未命名'}`,
      detail: typeof raw.script === 'string' ? raw.script.slice(0, 800) : '',
      riskLevel: 'high',
    };
  },
  async execute(input) {
    try {
      const raw = input as { name?: unknown; script?: unknown } | null;
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const script = typeof raw?.script === 'string' ? raw.script : '';
      if (!name || !script) return { ok: false, content: '', error: '需要 name 和 script' };
      const run = await workflowService.start({ name, script });
      return { ok: true, content: `工作流已启动：${run.name}（${run.id}）` };
    } catch (error) {
      return { ok: false, content: '', error: error instanceof Error ? error.message : String(error) };
    }
  },
};
tools.register(workflowTool);

pluginManager = await createPluginManager({
  toolNames: tools.list().map((tool) => tool.name),
  brainIds: listBrains().map((brain) => brain.id),
});
if (pluginManager && !pluginManager.isFeatureEnabled('context') && contextMode === 'acp') {
  console.log('[witcode] context 插件被禁用：acp 工具不会下发');
}

// 代码插件运行时：从 <dataDir>/plugins 加载可信 ESM 插件（同权限运行）。
const pluginRuntime = await createPluginRuntime({
  workspace,
  registerTool: (tool) => gatedTools.register(tool),
  logger: (line) => console.log(line),
});
await pluginRuntime.loadAll();

function allPlugins() {
  return [...(pluginManager?.list() ?? []), ...pluginRuntime.list()];
}

// MCP：按配置启动本机 stdio 服务器，工具注册进同一套工具表。
const mcpManager: McpManager = await createMcpManager({
  registerTool: (tool) => gatedTools.register(tool),
});
await mcpManager.startAll();

const server = createServer((req, res) => {
  // 插件 UI 资源：/plugin-ui/<pluginId>/<file>，只允许插件目录内文件。
  if (req.url?.startsWith('/plugin-ui/')) {
    const rest = decodeURIComponent(req.url.slice('/plugin-ui/'.length));
    const slash = rest.indexOf('/');
    const id = slash > 0 ? rest.slice(0, slash) : '';
    const file = slash > 0 ? rest.slice(slash + 1) : '';
    const target = id && file ? pluginAssetPath(id, file) : null;
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    void readFile(target)
      .then((body) => {
        res.writeHead(200, {
          'content-type': mimeTypes[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  void serveWeb(req.url ?? '/', res).then((served) => {
    if (served) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  let currentSessionId: string | null = null;
  let aborter: AbortController | null = null;
  let terminalSession: TerminalSession | null = null;

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
  connections.add(send);
  socket.on('close', () => connections.delete(send));

  const pendingApprovals = new Map<string, (decision: 'allow' | 'deny') => void>();

  function requestApproval(request: {
    tool: string;
    input: unknown;
    title: string;
    detail: string;
    riskLevel: 'low' | 'medium' | 'high';
    reason: string;
  }): Promise<'allow' | 'deny'> {
    return new Promise((resolve) => {
      const id = randomUUID();
      pendingApprovals.set(id, resolve);
      send({ type: 'approval:request', request: { id, ...request } });
      setTimeout(() => {
        // 没有人应答：fail-closed
        if (pendingApprovals.delete(id)) resolve('deny');
      }, 60_000);
    });
  }

  async function openSession(sessionId?: string): Promise<void> {
    let record = sessionId ? await sessions.get(sessionId) : null;

    if (!record) {
      const list = await sessions.list();
      const latest = list[0];
      if (latest) {
        record = await sessions.get(latest.id);
      }
    }

    if (!record) {
      record = await sessions.create();
    }

    currentSessionId = record.id;
    send({
      type: 'ready',
      sessionId: record.id,
      model: modelLabel(),
      brain: enabledBrain(activeBrainId)?.id ?? activeBrainId,
      permission: security.permission.getMode(),
    });
    send({ type: 'sessions', items: await sessions.list() });
    send({ type: 'archived-sessions', items: await sessions.listArchived() });
    send({ type: 'history', sessionId: record.id, messages: record.messages });
    send({ type: 'providers', items: await gateway.listProviders() });
    send({ type: 'models', items: await gateway.listModels() });
    send({ type: 'selection', selection: gateway.getSelection() });
    send({ type: 'brains', items: visibleBrains(), active: enabledBrain(activeBrainId)?.id ?? activeBrainId });
    send({ type: 'partners', items: partnerRegistry.get(record.id) });
    send({ type: 'settings', items: appSettings.get() });
    send({ type: 'skills', items: skillStore.list() });
    send({ type: 'commands', items: commandStore.list() });
    send({ type: 'mcp', items: mcpManager.list() });
    send({ type: 'todos', sessionId: record.id, items: todoStore.get(record.id) });
    send({ type: 'automations', items: automationStore.list() });
    send({ type: 'hooks', items: hookStore.list() });
    send({ type: 'routing', strategy: await gateway.getRoutingStrategy() });
    void hookRunner.run('SessionStart', { WITCODE_SESSION_ID: record.id });
  }

  void openSession().catch((error: unknown) => {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  socket.on('message', async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    if (message.type === 'cancel') {
      aborter?.abort();
      return;
    }

    if (message.type === 'list-sessions') {
      send({ type: 'sessions', items: await sessions.list() });
      return;
    }

    if (message.type === 'list-archived-sessions') {
      send({ type: 'archived-sessions', items: await sessions.listArchived() });
      return;
    }

    if (message.type === 'session:rename') {
      try {
        const title = message.title.trim();
        if (!title) throw new Error('标题不能为空');
        await sessions.rename(message.id, title);
        send({ type: 'sessions', items: await sessions.list() });
      } catch (error) {
        send({
          type: 'error',
          message: `重命名会话失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'session:archive') {
      try {
        await sessions.archive(message.id, message.archived);
        send({ type: 'sessions', items: await sessions.list() });
        send({ type: 'archived-sessions', items: await sessions.listArchived() });
      } catch (error) {
        send({
          type: 'error',
          message: `归档会话失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'open-session') {
      await openSession(message.sessionId);
      return;
    }

    if (message.type === 'brains:list') {
      send({
        type: 'brains',
        items: visibleBrains(),
        active: enabledBrain(activeBrainId)?.id ?? activeBrainId,
        official: [...officialBrainIds],
      });
      return;
    }

    if (message.type === 'brain:select') {
      const brain = getBrain(message.brainId);
      if (!brain) {
        send({ type: 'error', message: `未知的脑子：${message.brainId}` });
        return;
      }
      if (pluginManager?.isBrainEnabled(brain.id) === false) {
        send({ type: 'error', message: `该脑子已在插件设置中停用：${message.brainId}` });
        return;
      }
      activeBrainId = brain.id;
      send({
        type: 'brain',
        brain: {
          id: brain.id,
          name: brain.name,
          description: brain.description,
          bestFor: brain.bestFor,
        },
      });
      send({
        type: 'brains',
        items: visibleBrains(),
        active: activeBrainId,
        official: [...officialBrainIds],
      });
      return;
    }

    if (message.type === 'partners:list') {
      send({
        type: 'partners',
        items: partnerRegistry.get(currentSessionId ?? 'default'),
      });
      return;
    }

    if (message.type === 'partners:set') {
      try {
        send({
          type: 'partners',
          items: partnerRegistry.set(currentSessionId ?? 'default', message.partner),
        });
      } catch (error) {
        send({
          type: 'error',
          message: `设置伙伴失败：${error instanceof Error ? error.message : String(error)}`,
        });
        // 回滚前端的乐观更新：重新下发服务端真实配置。
        send({
          type: 'partners',
          items: partnerRegistry.get(currentSessionId ?? 'default'),
        });
      }
      return;
    }

    if (message.type === 'settings:get') {
      send({ type: 'settings', items: appSettings.get() });
      return;
    }

    if (message.type === 'settings:set') {
      try {
        send({ type: 'settings', items: await appSettings.update(message.patch) });
      } catch (error) {
        send({
          type: 'error',
          message: `保存设置失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'settings', items: appSettings.get() });
      }
      return;
    }

    if (message.type === 'personalization:get') {
      send({ type: 'personalization', text: await appSettings.readPersonalization() });
      return;
    }

    if (message.type === 'personalization:set') {
      try {
        await appSettings.writePersonalization(message.text);
        send({ type: 'personalization', text: await appSettings.readPersonalization() });
      } catch (error) {
        send({
          type: 'error',
          message: `保存个性化失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'memory:get') {
      send({
        type: 'memory',
        text: await appSettings.readMemory(),
        path: appSettings.memoryPath(),
      });
      return;
    }

    if (message.type === 'memory:set') {
      try {
        await appSettings.writeMemory(message.text);
        send({
          type: 'memory',
          text: await appSettings.readMemory(),
          path: appSettings.memoryPath(),
        });
      } catch (error) {
        send({
          type: 'error',
          message: `保存记忆失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'skills:list') {
      send({ type: 'skills', items: skillStore.list() });
      return;
    }

    if (message.type === 'skills:save') {
      try {
        send({ type: 'skills', items: await skillStore.save(message.skill) });
      } catch (error) {
        send({
          type: 'error',
          message: `保存技能失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'skills', items: skillStore.list() });
      }
      return;
    }

    if (message.type === 'skills:delete') {
      try {
        send({ type: 'skills', items: await skillStore.remove(message.id) });
      } catch (error) {
        send({
          type: 'error',
          message: `删除技能失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'commands:list') {
      send({ type: 'commands', items: commandStore.list() });
      return;
    }

    if (message.type === 'commands:save') {
      try {
        send({ type: 'commands', items: await commandStore.save(message.command) });
      } catch (error) {
        send({
          type: 'error',
          message: `保存命令失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'commands', items: commandStore.list() });
      }
      return;
    }

    if (message.type === 'commands:delete') {
      try {
        send({ type: 'commands', items: await commandStore.remove(message.name) });
      } catch (error) {
        send({
          type: 'error',
          message: `删除命令失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'mcp:list') {
      send({ type: 'mcp', items: mcpManager.list() });
      return;
    }

    if (message.type === 'mcp:save') {
      try {
        send({ type: 'mcp', items: await mcpManager.save(message.server) });
      } catch (error) {
        send({
          type: 'error',
          message: `保存 MCP 服务器失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'mcp', items: mcpManager.list() });
      }
      return;
    }

    if (message.type === 'mcp:delete') {
      try {
        send({ type: 'mcp', items: await mcpManager.remove(message.id) });
      } catch (error) {
        send({
          type: 'error',
          message: `删除 MCP 服务器失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'mcp:reconnect') {
      try {
        send({ type: 'mcp', items: await mcpManager.reconnect(message.id) });
      } catch (error) {
        send({
          type: 'error',
          message: `重连 MCP 服务器失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'mcp', items: mcpManager.list() });
      }
      return;
    }

    if (message.type === 'terminal:create') {
      try {
        terminalSession?.kill();
        const session = createTerminal({
          cwd: workspace,
          cols: message.cols,
          rows: message.rows,
        });
        terminalSession = session;
        session.onData((data) => send({ type: 'terminal:data', data }));
        session.onExit((code) => {
          send({ type: 'terminal:exit', code });
          if (terminalSession === session) terminalSession = null;
        });
        send({ type: 'terminal:ready', id: session.id });
      } catch (error) {
        send({
          type: 'terminal:error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message.type === 'terminal:input') {
      terminalSession?.write(message.data);
      return;
    }

    if (message.type === 'terminal:resize') {
      terminalSession?.resize(message.cols, message.rows);
      return;
    }

    if (message.type === 'terminal:close') {
      terminalSession?.kill();
      terminalSession = null;
      return;
    }

    if (message.type === 'files:tree') {
      try {
        const rel = message.path?.trim() ?? '';
        send({ type: 'files:tree', path: rel, items: await workspaceFiles.tree(rel) });
      } catch (error) {
        send({
          type: 'error',
          message: `读取目录失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'files:read') {
      try {
        send({ type: 'files:read', file: await workspaceFiles.read(message.path) });
      } catch (error) {
        send({
          type: 'error',
          message: `读取文件失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'git:status') {
      try {
        const status = await workspaceFiles.gitStatus();
        send({ type: 'git:status', branch: status.branch, items: status.items });
      } catch (error) {
        send({
          type: 'error',
          message: `读取 Git 状态失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'git:diff') {
      try {
        send({ type: 'git:diff', path: message.path, diff: await workspaceFiles.gitDiff(message.path) });
      } catch (error) {
        send({
          type: 'error',
          message: `读取 Git diff 失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'automations:list') {
      send({ type: 'automations', items: automationStore.list() });
      return;
    }

    if (message.type === 'automations:save') {
      try {
        send({ type: 'automations', items: await automationStore.save(message.automation) });
      } catch (error) {
        send({
          type: 'error',
          message: `保存自动化失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'automations', items: automationStore.list() });
      }
      return;
    }

    if (message.type === 'automations:delete') {
      try {
        send({ type: 'automations', items: await automationStore.remove(message.id) });
      } catch (error) {
        send({
          type: 'error',
          message: `删除自动化失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'automations:run') {
      try {
        send({ type: 'automations', items: await automationStore.runNow(message.id) });
      } catch (error) {
        send({
          type: 'error',
          message: `运行自动化失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'automations', items: automationStore.list() });
      }
      return;
    }

    if (message.type === 'hooks:list') {
      send({ type: 'hooks', items: hookStore.list() });
      return;
    }

    if (message.type === 'hooks:save') {
      try {
        send({ type: 'hooks', items: await hookStore.save(message.hook) });
      } catch (error) {
        send({
          type: 'error',
          message: `保存钩子失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'hooks', items: hookStore.list() });
      }
      return;
    }

    if (message.type === 'hooks:delete') {
      try {
        send({ type: 'hooks', items: await hookStore.remove(message.id) });
      } catch (error) {
        send({
          type: 'error',
          message: `删除钩子失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'workflows:list') {
      send({ type: 'workflows', items: workflowService.list() });
      return;
    }

    if (message.type === 'workflow:start') {
      try {
        const run = await workflowService.start({ name: message.name, script: message.script });
        send({ type: 'workflow', run });
        send({ type: 'workflows', items: workflowService.list() });
      } catch (error) {
        send({
          type: 'error',
          message: `启动工作流失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'workflow:cancel') {
      try {
        const run = await workflowService.cancel(message.id);
        if (run) send({ type: 'workflow', run });
        send({ type: 'workflows', items: workflowService.list() });
      } catch (error) {
        send({
          type: 'error',
          message: `取消工作流失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'plugins:list') {
      send({ type: 'plugins', items: allPlugins() });
      return;
    }

    if (message.type === 'plugins:set') {
      try {
        const isCode = pluginRuntime.list().some((item) => item.id === message.pluginId);
        if (isCode) {
          await pluginRuntime.setEnabled(message.pluginId, message.enabled);
        } else {
          if (!pluginManager) throw new Error('插件管理器未初始化');
          await pluginManager.setPluginEnabled(message.pluginId, message.enabled);
        }
        send({ type: 'plugins', items: allPlugins() });
      } catch (error) {
        send({
          type: 'error',
          message: `切换插件失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'plugins', items: allPlugins() });
      }
      return;
    }

    if (message.type === 'plugins:component') {
      try {
        if (!pluginManager) throw new Error('插件管理器未初始化');
        await pluginManager.setComponentEnabled(
          message.pluginId,
          message.componentId,
          message.enabled,
        );
        send({ type: 'plugins', items: allPlugins() });
      } catch (error) {
        send({
          type: 'error',
          message: `切换插件组件失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'plugins', items: allPlugins() });
      }
      return;
    }

    if (message.type === 'plugins:install') {
      try {
        if (!pluginManager) throw new Error('插件管理器未初始化');
        await pluginManager.installBrain(message.manifest);
        send({ type: 'plugins', items: allPlugins() });
      } catch (error) {
        send({
          type: 'error',
          message: `安装插件失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'plugins', items: allPlugins() });
      }
      return;
    }

    if (message.type === 'plugins:config') {
      try {
        await pluginRuntime.setConfig(message.pluginId, message.patch);
        send({ type: 'plugins', items: allPlugins() });
      } catch (error) {
        send({
          type: 'error',
          message: `保存插件配置失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'plugins', items: allPlugins() });
      }
      return;
    }

    if (message.type === 'plugins:install-local') {
      try {
        await pluginRuntime.installLocal(message.path);
        send({ type: 'plugins', items: allPlugins() });
      } catch (error) {
        send({
          type: 'error',
          message: `安装本地插件失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'plugins', items: allPlugins() });
      }
      return;
    }

    if (message.type === 'plugins:uninstall') {
      try {
        const isCode = pluginRuntime.list().some((item) => item.id === message.pluginId);
        if (isCode) {
          await pluginRuntime.uninstall(message.pluginId);
        } else {
          if (!pluginManager) throw new Error('插件管理器未初始化');
          await pluginManager.uninstall(message.pluginId);
        }
        send({ type: 'plugins', items: allPlugins() });
      } catch (error) {
        send({
          type: 'error',
          message: `卸载插件失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'plugins', items: allPlugins() });
      }
      return;
    }

    if (message.type === 'permission:set') {
      security.permission.setMode(message.mode);
      send({ type: 'permission', mode: security.permission.getMode() });
      return;
    }

    if (message.type === 'approval:response') {
      const resolve = pendingApprovals.get(message.id);
      if (resolve) {
        pendingApprovals.delete(message.id);
        resolve(message.decision);
      }
      return;
    }

    if (message.type === 'providers:list') {
      send({ type: 'providers', items: await gateway.listProviders() });
      send({ type: 'models', items: await gateway.listModels() });
      send({ type: 'selection', selection: gateway.getSelection() });
      send({ type: 'routing', strategy: await gateway.getRoutingStrategy() });
      return;
    }

    if (message.type === 'providers:save') {
      try {
        await gateway.saveProvider(message.provider);
        send({ type: 'providers', items: await gateway.listProviders() });
        send({ type: 'models', items: await gateway.listModels() });
        send({ type: 'selection', selection: gateway.getSelection() });
      } catch (error) {
        send({
          type: 'error',
          message: `保存提供商失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'providers:delete') {
      try {
        await gateway.deleteProvider(message.id);
        send({ type: 'providers', items: await gateway.listProviders() });
        send({ type: 'models', items: await gateway.listModels() });
        send({ type: 'selection', selection: gateway.getSelection() });
      } catch (error) {
        send({
          type: 'error',
          message: `删除提供商失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'providers:test') {
      try {
        send({ type: 'provider:test', result: await gateway.testProvider(message.id) });
      } catch (error) {
        send({
          type: 'provider:test',
          result: {
            providerId: message.id,
            ok: false,
            latencyMs: 0,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (message.type === 'providers:reorder') {
      try {
        await gateway.reorderProviders(message.ids);
        send({ type: 'providers', items: await gateway.listProviders() });
        send({ type: 'models', items: await gateway.listModels() });
        send({ type: 'selection', selection: gateway.getSelection() });
      } catch (error) {
        send({
          type: 'error',
          message: `调整提供商顺序失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type === 'routing:set') {
      try {
        await gateway.setRoutingStrategy(message.strategy);
        send({ type: 'routing', strategy: await gateway.getRoutingStrategy() });
      } catch (error) {
        send({
          type: 'error',
          message: `切换路由策略失败：${error instanceof Error ? error.message : String(error)}`,
        });
        send({ type: 'routing', strategy: await gateway.getRoutingStrategy() });
      }
      return;
    }

    if (message.type === 'usage:list') {
      send({
        type: 'usage',
        items: await gateway.listUsage(50),
        summary: await gateway.summary(),
      });
      return;
    }

    if (message.type === 'selection:set') {
      try {
        await gateway.setSelection(message.selection);
        send({ type: 'selection', selection: gateway.getSelection() });
      } catch (error) {
        send({
          type: 'error',
          message: `切换模型失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    if (message.type !== 'prompt') return;

    // 先建立取消作用域，再进入任何 await：否则紧接着到达的 cancel 会落空。
    aborter?.abort();
    aborter = new AbortController();
    const signal = aborter.signal;

    const targetId = message.sessionId ?? currentSessionId;
    let record = targetId ? await sessions.get(targetId) : null;
    if (!record) {
      record = await sessions.create();
    }
    currentSessionId = record.id;

    const expanded = commandStore.expand(message.text);
    const userText = expanded?.text ?? message.text;
    const userMessage: ChatMessage = { role: 'user', content: userText };
    const isFirstMessage = record.messages.length === 0;

    await sessions.append(record.id, userMessage);
    if (isFirstMessage) {
      await sessions.rename(record.id, userText.slice(0, 24) || '新会话');
    }

    const prefs = appSettings.get();
    const brain = enabledBrain(activeBrainId);
    // 记忆注入同时受「应用设置」「插件开关」和「Brain 自身策略」约束。
    const memory =
      prefs.projectMemory &&
      pluginManager?.isFeatureEnabled('projectMemory') !== false &&
      brain?.context?.projectMemory !== false
        ? await loadProjectMemory(workspace)
        : null;
    const personalization = await appSettings.readPersonalization();
    const history: ChatMessage[] = [
      ...(brain
        ? [
            {
              role: 'system' as const,
              content: buildSystemPrompt(brain, memory, {
                personalization,
                replyLanguage: prefs.replyLanguage,
                skillsSection: skillStore.enabledPromptSection(),
              }),
            },
          ]
        : []),
      ...record.messages,
      userMessage,
    ];

    const prepared = await contextManager.beforeRequest(record.id, history);
    const modelHistory: ChatMessage[] = [...prepared.messages];
    if (prepared.nudge) {
      modelHistory.push({ role: 'system', content: prepared.nudge });
    }

    const provider = gateway;
    let streamed = '';
    // 设置里的步数上限是硬帽；Brain 可以更保守，但不能更放开。
    const maxSteps = brain?.loop?.maxSteps
      ? Math.min(prefs.maxSteps, brain.loop.maxSteps)
      : prefs.maxSteps;

    try {
      const result = await runAgentLoop(modelHistory, {
        provider,
        tools: gatedTools,
        workspace,
        brain,
        maxSteps,
        sessionId: record.id,
        signal,
        security,
        requestApproval,
        onText: (text) => {
          // 取消后不再向客户端推送（provider 可能在 abort 边界多吐一个字符）。
          if (signal.aborted) return;
          streamed += text;
          send({ type: 'delta', text });
        },
        onToolCall: (call) => {
          send({ type: 'tool-call', name: call.name, input: call.input });
          if (call.name === 'consult_partner') {
            const input = call.input as { brainId?: unknown; question?: unknown } | null;
            send({
              type: 'partner:start',
              brainId: typeof input?.brainId === 'string' ? input.brainId : '',
              question: typeof input?.question === 'string' ? input.question : '',
            });
          }
          if (call.name === 'spawn_subagent') {
            const input = call.input as { task?: unknown } | null;
            send({
              type: 'subagent:start',
              id: call.id,
              task: typeof input?.task === 'string' ? input.task : '',
            });
          }
        },
        onToolResult: (call, toolResult) => {
          send({
            type: 'tool-result',
            name: call.name,
            ok: toolResult.ok,
            content: toolResult.ok ? toolResult.content : (toolResult.error ?? ''),
          });
          if (call.name.startsWith('todo_')) {
            send({
              type: 'todos',
              sessionId: record.id,
              items: todoStore.get(record.id),
            });
          }
          if (call.name === 'consult_partner') {
            const input = call.input as { brainId?: unknown } | null;
            send({
              type: 'partner:done',
              brainId: typeof input?.brainId === 'string' ? input.brainId : '',
              answer: toolResult.ok ? toolResult.content : (toolResult.error ?? ''),
            });
          }
          if (call.name === 'spawn_subagent') {
            send({
              type: 'subagent:done',
              id: call.id,
              status: toolResult.ok ? 'done' : 'failed',
              output: toolResult.ok ? toolResult.content : (toolResult.error ?? ''),
            });
          }
        },
      });

      await hookRunner.run('Stop', { WITCODE_SESSION_ID: record.id });

      const added = result.messages.slice(modelHistory.length);
      for (const item of added) {
        await sessions.append(record.id, item);
      }

      const finalText =
        [...result.messages].reverse().find((item) => item.role === 'assistant' && item.content)
          ?.content ?? streamed;

      send({ type: 'done', text: finalText, sessionId: record.id });
      send({ type: 'sessions', items: await sessions.list() });
    } catch (error) {
      send({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on('close', () => {
    aborter?.abort();
    terminalSession?.kill();
    terminalSession = null;
  });
});

server.listen(port, () => {
  console.log(`[witcode] server ready: http://localhost:${port}`);
  console.log(`[witcode] workspace: ${workspace}`);
  console.log(`[witcode] plugins: ${kernel.list().join(', ') || '(none)'}`);
  console.log(`[witcode] tools: ${tools.list().map((tool) => tool.name).join(', ') || '(none)'}`);
});
