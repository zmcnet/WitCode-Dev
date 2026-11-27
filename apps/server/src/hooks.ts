/**
 * 生命周期钩子：配置落盘到 `<dataDir>/hooks.json`，按事件派发外部命令。
 *
 * - PreToolUse 退出码 2 阻断工具调用，其它非零只记录；
 * - PostToolUse / Stop / SessionStart 的非零退出只记录，不阻断；
 * - 命令通过 shell 执行，超时杀进程树，stdout/stderr 各保留最多 10KB。
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HookConfig } from '@witcode/protocol';

type HookEvent = HookConfig['event'];

const TOOL_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse'];
const ALL_EVENTS: readonly HookEvent[] = [...TOOL_EVENTS, 'Stop', 'SessionStart'];
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024;

function resolveDataDir(options?: { dataDir?: string }): string {
  return options?.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

async function loadArray(filePath: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 首次启动或文件损坏：空数组，不阻塞服务。
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return value.trim();
}

function clampTimeout(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(number)));
}

/** 补全 id/name，校验 event 与 command，timeout 收敛到 100..60000。 */
function normalizeHook(input: unknown): HookConfig {
  if (!isRecord(input)) throw new Error('钩子必须是对象');
  const event = input.event;
  if (typeof event !== 'string' || !ALL_EVENTS.includes(event as HookEvent)) {
    throw new Error(`event 非法：${String(event)}`);
  }
  const command = requiredText(input.command, 'command');
  const id =
    typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : randomUUID();
  const name =
    typeof input.name === 'string' && input.name.trim() !== ''
      ? input.name.trim()
      : `Hook ${id.slice(0, 8)}`;
  const matcher = typeof input.matcher === 'string' ? input.matcher.trim() : '';
  return {
    id,
    name,
    event: event as HookEvent,
    matcher,
    command,
    timeoutMs: clampTimeout(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
  };
}

export interface HookStore {
  list(): HookConfig[];
  save(hook: HookConfig): Promise<HookConfig[]>;
  remove(id: string): Promise<HookConfig[]>;
}

export async function createHookStore(options?: { dataDir?: string }): Promise<HookStore> {
  const filePath = path.join(resolveDataDir(options), 'hooks.json');
  const items: HookConfig[] = [];
  for (const raw of await loadArray(filePath)) {
    try {
      items.push(normalizeHook(raw));
    } catch {
      // 损坏条目跳过，不影响其它钩子。
    }
  }

  const persist = async (): Promise<void> => {
    await writeFileAtomic(filePath, `${JSON.stringify(items, null, 2)}\n`);
  };
  const snapshot = (): HookConfig[] => items.map((hook) => ({ ...hook }));

  return {
    list: snapshot,

    async save(hook) {
      const next = normalizeHook(hook);
      const index = items.findIndex((item) => item.id === next.id);
      if (index >= 0) items[index] = next;
      else items.push(next);
      await persist();
      return snapshot();
    },

    async remove(id) {
      const key = typeof id === 'string' ? id.trim() : '';
      const before = items.length;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index]?.id === key) items.splice(index, 1);
      }
      if (items.length !== before) await persist();
      return snapshot();
    },
  };
}

/** 只支持 `*` 与 `?` 通配，其余字符按字面量匹配。 */
function wildcardMatch(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(value);
}

function readText(
  payload: Record<string, string>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function matchesEvent(hook: HookConfig, event: HookEvent, toolName: string): boolean {
  if (!TOOL_EVENTS.includes(event)) return true; // Stop / SessionStart 忽略 matcher
  const matcher = hook.matcher?.trim() ?? '';
  if (matcher === '') return true;
  return wildcardMatch(matcher, toolName);
}

interface Execution {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function appendCapped(
  buffers: Buffer[],
  used: { bytes: number },
  chunk: Buffer,
): void {
  if (used.bytes >= MAX_OUTPUT_BYTES) return;
  const remaining = MAX_OUTPUT_BYTES - used.bytes;
  const piece = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  buffers.push(piece);
  used.bytes += piece.byteLength;
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 2000,
        });
      } catch {
        // 进程可能已退出。
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // 进程可能已退出。
      }
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 进程可能已退出。
  }
}

function executeHook(
  hook: HookConfig,
  event: HookEvent,
  payload: Record<string, string>,
  timeoutMs: number,
): Promise<Execution> {
  const timeout = clampTimeout(hook.timeoutMs, timeoutMs);
  const env: Record<string, string | undefined> = {
    ...process.env,
    WITCODE_EVENT: event,
    WITCODE_SESSION_ID: readText(payload, ['WITCODE_SESSION_ID', 'sessionId']),
    WITCODE_TOOL_NAME: readText(payload, ['WITCODE_TOOL_NAME', 'toolName', 'tool', 'name']),
    WITCODE_TOOL_INPUT: readText(payload, ['WITCODE_TOOL_INPUT', 'toolInput', 'input']),
    WITCODE_TOOL_RESULT: readText(payload, ['WITCODE_TOOL_RESULT', 'toolResult', 'result']),
    WITCODE_HOOK_ID: hook.id,
  };

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(hook.command, {
        shell: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: String(error),
      });
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const outUsed = { bytes: 0 };
    const errUsed = { bytes: 0 };
    child.stdout?.on('data', (chunk: Buffer) => appendCapped(outChunks, outUsed, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendCapped(errChunks, errUsed, chunk));

    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        error,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeout);
    // 兜底：即使杀进程树后管道未及时关闭，也不让调用方永久挂起。
    hardTimer = setTimeout(() => finish(null), timeout + 3000);

    child.on('error', (error) => finish(null, String(error)));
    child.on('close', (code) => finish(code));
  });
}

export interface HookRunResult {
  blocked: boolean;
  message?: string;
  logs: string[];
}

export interface HookRunner {
  run(event: HookConfig['event'], payload: Record<string, string>): Promise<HookRunResult>;
}

export function createHookRunner(options: {
  store: HookStore;
  timeoutMs?: number;
}): HookRunner {
  const defaultTimeout = clampTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  return {
    async run(event, payload) {
      const logs: string[] = [];
      const data: Record<string, string> = isRecord(payload) ? (payload as Record<string, string>) : {};
      const toolName = readText(data, ['WITCODE_TOOL_NAME', 'toolName', 'tool', 'name']);

      for (const hook of options.store.list()) {
        const label = `[${hook.id}] ${hook.name}`;
        if (!hook.enabled) {
          logs.push(`${label}: skipped (disabled)`);
          continue;
        }
        if (!matchesEvent(hook, event, toolName)) {
          logs.push(`${label}: skipped (matcher '${hook.matcher ?? ''}' 不匹配 '${toolName}')`);
          continue;
        }

        const execution = await executeHook(hook, event, data, defaultTimeout);
        const exit = execution.code === null ? 'null' : String(execution.code);
        logs.push(`${label}: exit=${exit}${execution.timedOut ? ' (timeout)' : ''}`);
        if (execution.stdout !== '') logs.push(`${label}: stdout: ${execution.stdout}`);
        if (execution.stderr !== '') logs.push(`${label}: stderr: ${execution.stderr}`);
        if (execution.error) logs.push(`${label}: error: ${execution.error}`);
        if (execution.timedOut) logs.push(`${label}: 超时 ${clampTimeout(hook.timeoutMs, defaultTimeout)}ms，已杀进程树`);
        if (execution.code === 2 && event === 'PreToolUse') {
          logs.push(`${label}: 退出码 2，阻断工具调用`);
        } else if (execution.code !== null && execution.code !== 0) {
          logs.push(`${label}: 非零退出码 ${exit}（只记录，不阻断）`);
        }

        if (event === 'PreToolUse' && execution.code === 2) {
          const message =
            [execution.stderr.trim(), execution.stdout.trim()].filter(Boolean).join('\n') ||
            `${hook.name} 阻断了该工具调用（exit 2）`;
          return { blocked: true, message, logs };
        }
      }

      return { blocked: false, logs };
    },
  };
}
