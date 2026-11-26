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

// 产品端口：同一端口同时提供 Web 页面（apps/web/dist）与 /ws。
// 内网穿透只需要映射这一个端口；开发时 Vite 用 5173 代理回来。
const port = Number(process.env.PORT ?? 21004);
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

const security = createSecurity({ workspace, mode: 'normal' });
console.log(`[witcode] permission: ${security.permission.getMode()}`);

// 伙伴：另一个脑子的视角，只读；主会话历史由这里注入。
// 槽位按会话存储：2 个槽位可独立启用/禁用，各自选脑子与模型。
const partnerRegistry = createPartnerRegistry();
const partner = createPartnerService({
  provider: gateway,
  tools,
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
  tools,
  sessions,
  security,
  workspace,
  maxSubagents: 999,
});
const subagentDefinition = subagentTool(subagents);
const subagentCounts = new Map<string, number>();
tools.register({
  ...subagentDefinition,
  async execute(input, ctx) {
    const key = ctx.sessionId ?? 'default';
    const used = subagentCounts.get(key) ?? 0;
    if (used >= 3) {
      return {
        ok: false,
        content: '',
        error: '本会话的子智能体数量已达上限（3）',
      };
    }
    subagentCounts.set(key, used + 1);
    return subagentDefinition.execute(input, ctx);
  },
});

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

const server = createServer((req, res) => {
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

  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

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
      brain: activeBrainId,
      permission: security.permission.getMode(),
    });
    send({ type: 'sessions', items: await sessions.list() });
    send({ type: 'history', sessionId: record.id, messages: record.messages });
    send({ type: 'providers', items: await gateway.listProviders() });
    send({ type: 'models', items: await gateway.listModels() });
    send({ type: 'selection', selection: gateway.getSelection() });
    send({ type: 'brains', items: listBrains(), active: activeBrainId });
    send({ type: 'partners', items: partnerRegistry.get(record.id) });
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

    if (message.type === 'open-session') {
      await openSession(message.sessionId);
      return;
    }

    if (message.type === 'brains:list') {
      send({
        type: 'brains',
        items: listBrains(),
        active: activeBrainId,
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
        items: listBrains(),
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

    const userMessage: ChatMessage = { role: 'user', content: message.text };
    const isFirstMessage = record.messages.length === 0;

    await sessions.append(record.id, userMessage);
    if (isFirstMessage) {
      await sessions.rename(record.id, message.text.slice(0, 24) || '新会话');
    }

    const brain = getBrain(activeBrainId) ?? getBrain(defaultBrainId());
    const memory = await loadProjectMemory(workspace);
    const history: ChatMessage[] = [
      ...(brain
        ? [{ role: 'system' as const, content: buildSystemPrompt(brain, memory) }]
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

    try {
      const result = await runAgentLoop(modelHistory, {
        provider,
        tools,
        workspace,
        brain,
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
  });
});

server.listen(port, () => {
  console.log(`[witcode] server ready: http://localhost:${port}`);
  console.log(`[witcode] workspace: ${workspace}`);
  console.log(`[witcode] plugins: ${kernel.list().join(', ') || '(none)'}`);
  console.log(`[witcode] tools: ${tools.list().map((tool) => tool.name).join(', ') || '(none)'}`);
});
