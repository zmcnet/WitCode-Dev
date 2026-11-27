/**
 * 后台任务（jobs）工具集。
 *
 * 与 DSH 内置 jobs 对齐：run_background 立即返回，输出留在内存环形缓冲里，
 * 由 job_output / job_list / job_kill 轮询和收尾。全部状态只在进程内存中，
 * 服务重启即丢失，不做持久化。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';

const DEFAULT_MAX_JOBS = 10;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024;
const DEFAULT_TAIL_CHARS = 8000;
const DEFAULT_SESSION_ID = 'default';

type JobStatus = 'running' | 'exited' | 'killed';

export interface JobToolsOptions {
  /** 每个会话允许同时运行的 job 数，默认 10。 */
  maxJobs?: number;
  /** 每路（stdout/stderr）环形缓冲保留的字节数，默认 100KB。 */
  maxBufferBytes?: number;
}

/**
 * 保留最近 N 字节的输出缓冲：超出容量时丢弃最早的数据，并标记 truncated。
 * 以块为单位的 deque 实现，等价于按字节滚动的环形缓冲。
 */
class RingBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    // 复制，避免过大的父 Buffer 被子视图长期引用。
    if (chunk.length > this.capacity) this.truncated = true;
    const data = chunk.length > this.capacity
      ? Buffer.from(chunk.subarray(chunk.length - this.capacity))
      : Buffer.from(chunk);
    this.chunks.push(data);
    this.bytes += data.length;
    while (this.bytes > this.capacity) {
      const first = this.chunks[0]!;
      const excess = this.bytes - this.capacity;
      if (excess >= first.length) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = Buffer.from(first.subarray(excess));
        this.bytes -= excess;
      }
      this.truncated = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8');
  }
}

interface JobRecord {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  stdout: RingBuffer;
  stderr: RingBuffer;
  child: ChildProcess;
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error };
}

function asInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid input: expected an object');
  }
  return input as Record<string, unknown>;
}

function readString(input: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = input[key];
  if (value === undefined) {
    if (required) throw new Error(`invalid input: missing "${key}"`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`invalid input: "${key}" must be a string`);
  return value;
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid input: "${key}" must be a finite number`);
  }
  return value;
}

function sessionIdOf(ctx: ToolContext): string {
  return typeof ctx.sessionId === 'string' && ctx.sessionId.trim() !== ''
    ? ctx.sessionId
    : DEFAULT_SESSION_ID;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把 cwd 限制在 workspace 内，并确认它已经是一个目录。 */
function resolveCwd(workspace: string, cwd: unknown): string {
  const root = path.resolve(workspace);
  if (cwd === undefined) return root;
  if (typeof cwd !== 'string') throw new Error('invalid input: "cwd" must be a string');
  const target = path.resolve(root, cwd);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('path escapes workspace');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  return target;
}

/** 按 Unicode 码点取末尾 N 个字符，不切断代理对。 */
function tailChars(text: string, count: number): string {
  if (count <= 0) return '';
  const chars = Array.from(text);
  return chars.length <= count ? text : chars.slice(chars.length - count).join('');
}

/** 强制结束 shell 及其子进程树。 */
function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    // Windows 上 detached 会破坏管道 stdio，因此用 taskkill /t 递归杀掉整个树。
    return new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const fallback = (): void => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      };
      killer.once('error', fallback);
      killer.once('close', () => resolve());
    });
  }
  // POSIX：detached 使 shell 成为进程组组长，负 pid 一次杀掉整组。
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}

function finalize(job: JobRecord, code: number | null, signal: NodeJS.Signals | null, error?: string): void {
  if (job.status === 'killed') return;
  job.status = 'exited';
  job.endedAt = Date.now();
  if (error !== undefined) {
    job.error = error;
    job.exitCode = null;
    job.signal = signal;
  } else if (job.error === null) {
    job.exitCode = code;
    job.signal = signal;
  }
}

/** 输入校验与执行异常统一转成 ok:false，不向调用方抛出。 */
function guard(
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>,
): (input: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async (input, ctx) => {
    try {
      return await execute(input, ctx);
    } catch (error) {
      return fail(describe(error));
    }
  };
}

/** 创建四个后台任务工具；状态仅限该实例的内存，不落盘。 */
export function createJobTools(options: JobToolsOptions = {}): ToolDefinition[] {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  if (!Number.isFinite(maxJobs) || maxJobs < 1) {
    throw new Error('maxJobs must be a positive number');
  }
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  if (!Number.isFinite(maxBufferBytes) || maxBufferBytes < 1) {
    throw new Error('maxBufferBytes must be a positive number');
  }

  const jobs = new Map<string, JobRecord>();
  let nextId = 1;

  function findJob(id: string, sessionId: string): JobRecord {
    const job = jobs.get(id);
    if (!job || job.sessionId !== sessionId) throw new Error(`unknown job id: ${id}`);
    return job;
  }

  const runBackground: ToolDefinition = {
    name: 'run_background',
    description:
      '在 workspace 后台启动长任务并立即返回 job id / pid，不等待结束。适合构建、测试等耗时命令；启动后必须用 job_output 轮询输出，需要中止时用 job_kill 停止。每个会话最多 10 个活跃任务，输出按 stdout/stderr 各保留最近 100KB。',
    destructive: true,
    concurrentSafe: false,
    riskLevel: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '交给 shell 执行的命令行，不能为空' },
        cwd: { type: 'string', description: '相对 workspace 的工作目录，默认 workspace 根目录；不允许逃逸' },
      },
      required: ['command'],
    },
    execute: guard(async (input, ctx) => {
      const args = asInput(input);
      const command = readString(args, 'command', true)!.trim();
      if (command === '') throw new Error('invalid input: "command" must not be empty');
      const cwd = resolveCwd(ctx.workspace, args.cwd);
      const sessionId = sessionIdOf(ctx);

      const active = [...jobs.values()].filter(
        (job) => job.sessionId === sessionId && job.status === 'running',
      ).length;
      if (active >= maxJobs) {
        throw new Error(`job limit reached: at most ${maxJobs} active jobs per session`);
      }

      const id = `job-${nextId}`;
      const job: JobRecord = {
        id,
        sessionId,
        command,
        cwd,
        status: 'running',
        exitCode: null,
        signal: null,
        pid: null,
        startedAt: Date.now(),
        endedAt: null,
        error: null,
        stdout: new RingBuffer(maxBufferBytes),
        stderr: new RingBuffer(maxBufferBytes),
        child: null as unknown as ChildProcess,
      };

      // 只透传 command / cwd / stdio；调用方的 env 字段不会进入子进程。
      let child: ChildProcess;
      try {
        child = spawn(command, {
          shell: true,
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        throw new Error(`failed to start job: ${describe(error)}`);
      }
      nextId += 1;
      job.child = child;
      job.pid = child.pid ?? null;
      jobs.set(id, job);

      child.stdout?.on('data', (chunk: Buffer) => job.stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => job.stderr.push(chunk));
      child.on('error', (error) => finalize(job, null, null, describe(error)));
      child.on('close', (code, signal) => finalize(job, code, signal));

      return ok(JSON.stringify({
        id,
        pid: job.pid,
        status: job.status,
        command,
        cwd,
        startedAt: job.startedAt,
      }));
    }),
  };

  const jobOutput: ToolDefinition = {
    name: 'job_output',
    description:
      '轮询后台任务：按 id 返回 running/exited/killed 状态、退出码以及最近的 stdout/stderr。tail 为每路返回的末尾字符数，默认 8000。',
    readOnly: true,
    concurrentSafe: true,
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'run_background 返回的 job id' },
        tail: { type: 'number', description: '每路输出取末尾多少字符，默认 8000' },
      },
      required: ['id'],
    },
    execute: guard(async (input, ctx) => {
      const args = asInput(input);
      const id = readString(args, 'id', true)!;
      const tail = readNumber(args, 'tail', DEFAULT_TAIL_CHARS);
      if (tail < 0) throw new Error('invalid input: "tail" must not be negative');
      const job = findJob(id, sessionIdOf(ctx));
      return ok(JSON.stringify({
        id: job.id,
        status: job.status,
        exitCode: job.exitCode,
        pid: job.pid,
        stdout: tailChars(job.stdout.toString(), Math.floor(tail)),
        stderr: tailChars(job.stderr.toString(), Math.floor(tail)),
        truncated: { stdout: job.stdout.truncated, stderr: job.stderr.truncated },
        error: job.error,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
      }));
    }),
  };

  const jobList: ToolDefinition = {
    name: 'job_list',
    description: '列出当前会话的全部后台任务：id、命令、状态、pid、开始时间与退出码。',
    readOnly: true,
    concurrentSafe: true,
    riskLevel: 'low',
    inputSchema: { type: 'object', properties: {} },
    execute: guard(async (_input, ctx) => {
      const sessionId = sessionIdOf(ctx);
      const list = [...jobs.values()]
        .filter((job) => job.sessionId === sessionId)
        .map((job) => ({
          id: job.id,
          command: job.command,
          status: job.status,
          pid: job.pid,
          startedAt: job.startedAt,
          exitCode: job.exitCode,
        }));
      return ok(JSON.stringify({ jobs: list }));
    }),
  };

  const jobKill: ToolDefinition = {
    name: 'job_kill',
    description:
      '按 id 强制终止后台任务及其整个进程树（Windows: taskkill /T /F；Unix: 杀死负 pid 进程组），返回终止后的状态。',
    destructive: true,
    concurrentSafe: false,
    riskLevel: 'high',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要终止的 job id' },
      },
      required: ['id'],
    },
    execute: guard(async (input, ctx) => {
      const args = asInput(input);
      const id = readString(args, 'id', true)!;
      const job = findJob(id, sessionIdOf(ctx));
      if (job.status === 'running') {
        job.status = 'killed';
        job.endedAt = Date.now();
        await killTree(job.child);
      }
      return ok(JSON.stringify({ id: job.id, status: job.status, exitCode: job.exitCode }));
    }),
  };

  return [runBackground, jobOutput, jobList, jobKill];
}
