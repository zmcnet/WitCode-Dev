/**
 * MCP（Model Context Protocol）服务器管理器。
 *
 * 配置落盘到 `<dataDir>/mcp.json`（env 明文只在服务端保存，对外只暴露 envKeys）。
 * 通过 stdio 启动第三方 MCP server，把它的 tools 注册为 WitCode 工具；断开、删除、
 * 重连时都会先注销已注册的工具，再关闭子进程，避免工具表里留下指向已死 client 的条目。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  McpServerInput,
  McpServerPublic,
  RiskLevel,
  ToolDefinition,
  ToolResult,
} from '@witcode/protocol';

/** 连接（含 tools/list）最长等待时间。 */
const CONNECT_TIMEOUT_MS = 15_000;

export interface McpManagerOptions {
  dataDir?: string;
  /** 注册 MCP 工具；返回 disposer，断开/删除时调用。 */
  registerTool(tool: ToolDefinition): () => void;
}

export interface McpManager {
  list(): McpServerPublic[];
  save(input: McpServerInput): Promise<McpServerPublic[]>;
  remove(id: string): Promise<McpServerPublic[]>;
  reconnect(id: string): Promise<McpServerPublic[]>;
  startAll(): Promise<void>;
  close(): Promise<void>;
}

interface PersistedState {
  servers: McpServerConfig[];
}

type McpServerConfig = McpServerInput & {
  id: string;
  env?: Record<string, string>;
};

type ServerStatus = 'connected' | 'error' | 'disabled';

interface RuntimeStatus {
  status: ServerStatus;
  toolCount: number;
  error?: string;
}

interface LiveConnection {
  client: Client;
  transport: StdioClientTransport;
  disposeTools: Array<() => void>;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

function resolveDataDir(options: McpManagerOptions): string {
  return options.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

/** 清洗为 [a-zA-Z0-9_-]，供 MCP 工具名前缀/工具名使用。 */
function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned === '' ? '_' : cleaned;
}

/** MCP 工具在 WitCode 工具表中的名字：mcp__<server>__<tool>。 */
export function toolNameFor(serverName: string, toolName: string): string {
  return `mcp__${sanitizeName(serverName)}__${sanitizeName(toolName)}`;
}

/** 校验并归一化一条服务器配置；抛错信息面向设置界面展示。 */
function parseServer(input: unknown): McpServerConfig {
  if (!isRecord(input)) throw new Error('MCP 服务器配置必须是对象');

  const name = requireText(input.name, 'name');
  const command = requireText(input.command, 'command');

  let args: string[];
  if (input.args === undefined) {
    args = [];
  } else if (Array.isArray(input.args) && input.args.every((item) => typeof item === 'string')) {
    args = [...(input.args as string[])];
  } else {
    throw new Error('args 必须是字符串数组');
  }

  let env: Record<string, string> | undefined;
  if (input.env !== undefined) {
    if (!isRecord(input.env)) throw new Error('env 必须是对象');
    env = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value !== 'string') throw new Error(`env.${key} 必须是字符串`);
      env[key] = value;
    }
  }

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');

  let id: string;
  if (input.id === undefined || input.id === '') {
    id = `mcp-${randomUUID()}`;
  } else if (typeof input.id === 'string') {
    id = input.id;
  } else {
    throw new Error('id 必须是字符串');
  }

  return {
    id,
    name,
    command,
    args,
    enabled,
    ...(env === undefined ? {} : { env }),
  };
}

async function loadState(filePath: string): Promise<McpServerConfig[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.servers)) return [];
    const result: McpServerConfig[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const raw of parsed.servers) {
      try {
        const server = parseServer(raw);
        // 损坏数据（重复 id / 重名）直接跳过，不让整份配置失效。
        if (ids.has(server.id) || names.has(server.name)) continue;
        ids.add(server.id);
        names.add(server.name);
        result.push(server);
      } catch {
        // 忽略坏条目。
      }
    }
    return result;
  } catch {
    // 首次启动或文件损坏：空配置。
    return [];
  }
}

function defaultStatus(server: McpServerConfig): RuntimeStatus {
  if (!server.enabled) return { status: 'disabled', toolCount: 0 };
  return { status: 'error', toolCount: 0, error: '未连接（需调用 startAll）' };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function safeDispose(dispose: () => void): void {
  try {
    dispose();
  } catch {
    // disposer 失败不应阻断断开流程。
  }
}

/** 把 MCP content 块中的文本拼成工具结果文本；非文本块以 JSON 形式保留。 */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else {
      try {
        parts.push(JSON.stringify(block));
      } catch {
        parts.push(String(block));
      }
    }
  }
  return parts.join('\n');
}

function mergedEnv(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(env ?? {})) result[key] = value;
  return result;
}

export async function createMcpManager(
  options: McpManagerOptions,
): Promise<McpManager> {
  const filePath = path.join(resolveDataDir(options), 'mcp.json');
  const servers = await loadState(filePath);
  const runtime = new Map<string, RuntimeStatus>(
    servers.map((server) => [server.id, defaultStatus(server)]),
  );
  const connections = new Map<string, LiveConnection>();

  const persist = async (state: McpServerConfig[] = servers): Promise<void> => {
    const payload: PersistedState = { servers: state };
    await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  };

  /** 用新快照替换内存配置，保持数组引用不变（闭包共享）。 */
  const commit = (next: McpServerConfig[]): void => {
    servers.splice(0, servers.length, ...next);
  };

  const list = (): McpServerPublic[] =>
    servers.map((server) => {
      const state = runtime.get(server.id) ?? defaultStatus(server);
      return {
        id: server.id,
        name: server.name,
        command: server.command,
        args: [...server.args],
        envKeys: Object.keys(server.env ?? {}),
        enabled: server.enabled,
        status: state.status,
        toolCount: state.toolCount,
        ...(state.error === undefined ? {} : { error: state.error }),
      };
    });

  /** 注销工具并关闭子进程；不修改配置。 */
  const disconnect = async (id: string): Promise<void> => {
    const live = connections.get(id);
    if (live === undefined) return;
    connections.delete(id);
    for (const undo of [...live.disposeTools].reverse()) safeDispose(undo);
    try {
      await live.client.close();
    } catch {
      // 进程已退出等情况忽略。
    }
    try {
      await live.transport.close();
    } catch {
      // 同上，保证子进程被回收。
    }
    const server = servers.find((item) => item.id === id);
    runtime.set(
      id,
      server?.enabled === true
        ? { status: 'error', toolCount: 0, error: '已断开' }
        : { status: 'disabled', toolCount: 0 },
    );
  };

  const makeToolDefinition = (
    server: McpServerConfig,
    tool: RemoteTool,
    client: Client,
  ): ToolDefinition => ({
    name: toolNameFor(server.name, tool.name),
    description: `[MCP:${server.name}] ${
      tool.description?.trim() || `调用 MCP 工具 ${tool.name}`
    }`,
    inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    readOnly: false,
    riskLevel: 'medium' as RiskLevel,
    execute: async (input): Promise<ToolResult> => {
      try {
        const result = await client.callTool({
          name: tool.name,
          arguments: isRecord(input) ? input : {},
        });
        const content = contentToText(result.content);
        if (result.isError === true) {
          return { ok: false, content, error: content || 'MCP 工具执行失败' };
        }
        return { ok: true, content };
      } catch (error) {
        return {
          ok: false,
          content: '',
          error: `MCP 工具调用失败：${errorMessage(error)}`,
        };
      }
    },
  });

  /** 重连单个 server：先注销旧工具、关闭旧 client，再按当前配置建立连接。 */
  const connect = async (server: McpServerConfig): Promise<void> => {
    await disconnect(server.id);
    if (!server.enabled) {
      runtime.set(server.id, { status: 'disabled', toolCount: 0 });
      return;
    }

    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    const disposeTools: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒）：${server.name}`)),
        CONNECT_TIMEOUT_MS,
      );
    });
    // 连接先完成时不让 deadline 的 reject 变成未处理的拒绝。
    void deadline.catch(() => {});

    try {
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: mergedEnv(server.env),
        stderr: 'ignore',
      });
      client = new Client({ name: 'witcode', version: '0.0.1' });

      await Promise.race([client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }), deadline]);
      const listed = await Promise.race([
        client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }),
        deadline,
      ]);
      const tools: RemoteTool[] = listed.tools ?? [];

      for (const tool of tools) {
        const dispose = options.registerTool(makeToolDefinition(server, tool, client!));
        if (typeof dispose === 'function') disposeTools.push(dispose);
      }

      connections.set(server.id, { client, transport, disposeTools });
      runtime.set(server.id, { status: 'connected', toolCount: tools.length });
    } catch (error) {
      for (const undo of [...disposeTools].reverse()) safeDispose(undo);
      // client.close() 会一并关闭 transport；再兜底关一次以回收子进程。
      if (client !== undefined) {
        try {
          await client.close();
        } catch {
          // 忽略清理失败。
        }
      }
      if (transport !== undefined) {
        try {
          await transport.close();
        } catch {
          // 忽略清理失败。
        }
      }
      runtime.set(server.id, {
        status: 'error',
        toolCount: 0,
        error: errorMessage(error),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    list,

    async save(input) {
      const next = parseServer(input);
      if (servers.some((server) => server.name === next.name && server.id !== next.id)) {
        throw new Error(`服务器名称已存在：${next.name}`);
      }
      const index = servers.findIndex((server) => server.id === next.id);
      const updated = [...servers];
      if (index >= 0) updated[index] = next;
      else updated.push(next);
      // 先落盘成功再改内存，避免写失败时内存与文件不一致。
      await persist(updated);
      commit(updated);
      await connect(next);
      return list();
    },

    async remove(id) {
      if (!servers.some((server) => server.id === id)) {
        throw new Error(`未知的 MCP 服务器：${id}`);
      }
      await disconnect(id);
      const updated = servers.filter((server) => server.id !== id);
      await persist(updated);
      commit(updated);
      runtime.delete(id);
      return list();
    },

    async reconnect(id) {
      const server = servers.find((item) => item.id === id);
      if (server === undefined) throw new Error(`未知的 MCP 服务器：${id}`);
      await connect(server);
      return list();
    },

    async startAll() {
      for (const server of [...servers]) {
        if (server.enabled) await connect(server);
      }
    },

    async close() {
      for (const id of [...connections.keys()]) await disconnect(id);
    },
  };
}
