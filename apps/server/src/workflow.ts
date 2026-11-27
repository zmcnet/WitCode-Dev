/**
 * ZCode 风格 Dynamic Workflow 的最小可用后端。
 *
 * 模型写的 JS 脚本在独立子进程 `workflow-runner.mjs` 中执行，父子通过 NDJSON 通信。
 * Run 元数据（不含脚本源码）原子落盘到 `<dataDir>/workflow-runs.json`。
 *
 * 接线点（当前未改 index.ts）：导入 createWorkflowService，spawn 回调接子代理服务，
 * onUpdate 推送 `{type:'workflow',run}`，消息 `workflow:start`/`workflow:cancel`/`workflow:list`
 * 分别接 start/cancel/list，并把 `{type:'workflows',items}` 推给前端。
 */

import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  WorkflowActorState,
  WorkflowActorStatus,
  WorkflowArtifact,
  WorkflowPhaseState,
  WorkflowPhaseStatus,
  WorkflowRun,
  WorkflowRunStatus,
} from '@witcode/protocol';

const MAX_SCRIPT_CHARS = 20_000;
const DEFAULT_MAX_RUNS = 20;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const RUNS_FILE = 'workflow-runs.json';
const RUNNER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workflow-runner.mjs');

const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
];
const ACTOR_STATUSES: readonly WorkflowActorStatus[] = ['queued', 'running', 'done', 'failed'];
const PHASE_STATUSES: readonly WorkflowPhaseStatus[] = ['pending', 'running', 'done', 'failed'];

export interface WorkflowSpawnResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface WorkflowServiceOptions {
  dataDir?: string;
  spawn: (task: string, actorName: string) => Promise<WorkflowSpawnResult>;
  onUpdate?: (run: WorkflowRun) => void;
  /** 最多保留的 run 数，默认 20。 */
  maxRuns?: number;
}

export interface WorkflowService {
  list(): WorkflowRun[];
  get(id: string): WorkflowRun | undefined;
  start(input: { name: string; script: string }): Promise<WorkflowRun>;
  cancel(id: string): Promise<WorkflowRun | undefined>;
  /** 等待 run 进入终态；不存在返回 undefined。 */
  wait(id: string): Promise<WorkflowRun | undefined>;
}

type RunnerEventType = 'phase' | 'agent' | 'ask' | 'artifact' | 'log' | 'done' | 'error';

interface ActiveRun {
  child: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  currentPhaseId?: string;
  waiters: Array<(run: WorkflowRun) => void>;
  settled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function runStatusOf(value: unknown): WorkflowRunStatus {
  const candidate = text(value);
  return RUN_STATUSES.find((status) => status === candidate) ?? 'failed';
}

function actorStatusOf(value: unknown): WorkflowActorStatus {
  const candidate = text(value);
  return ACTOR_STATUSES.find((status) => status === candidate) ?? 'queued';
}

function phaseStatusOf(value: unknown): WorkflowPhaseStatus {
  const candidate = text(value);
  return PHASE_STATUSES.find((status) => status === candidate) ?? 'pending';
}

function isTerminal(status: WorkflowRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    phases: run.phases.map((phase) => ({
      ...phase,
      actors: phase.actors.map((actor) => ({ ...actor })),
    })),
    artifacts: run.artifacts.map((artifact) => ({ ...artifact })),
  };
}

function normalizeActor(raw: unknown): WorkflowActorState | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id).trim();
  if (id === '') return null;
  const actor: WorkflowActorState = {
    id,
    name: text(raw.name).trim() || '未命名角色',
    status: actorStatusOf(raw.status),
  };
  const output = text(raw.output);
  const error = text(raw.error);
  if (output !== '') actor.output = output;
  if (error !== '') actor.error = error;
  return actor;
}

function normalizePhase(raw: unknown): WorkflowPhaseState | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id).trim();
  const name = text(raw.name).trim();
  if (id === '' || name === '') return null;
  const actors = Array.isArray(raw.actors)
    ? raw.actors
        .map(normalizeActor)
        .filter((actor): actor is WorkflowActorState => actor !== null)
    : [];
  return { id, name, status: phaseStatusOf(raw.status), actors };
}

function normalizeArtifact(raw: unknown): WorkflowArtifact | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id).trim();
  if (id === '') return null;
  return {
    id,
    title: text(raw.title).trim() || '未命名产物',
    kind: text(raw.kind) === 'text' ? 'text' : 'markdown',
    content: text(raw.content),
    createdAt: finiteNumber(raw.createdAt) ?? 0,
  };
}

/** 重启后不再有 runner 子进程：pending/running 一律转为 failed。 */
function normalizeRun(raw: unknown, nowAt: number): WorkflowRun | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id).trim();
  const name = text(raw.name).trim();
  if (id === '' || name === '') return null;

  const createdAt = finiteNumber(raw.createdAt) ?? nowAt;
  const updatedAt = finiteNumber(raw.updatedAt) ?? createdAt;
  let status = runStatusOf(raw.status);
  let error = text(raw.error);
  if (status === 'running' || status === 'pending') {
    status = 'failed';
    if (error === '') error = '服务重启，运行中断';
  }

  const run: WorkflowRun = {
    id,
    name,
    status,
    phases: Array.isArray(raw.phases)
      ? raw.phases
          .map(normalizePhase)
          .filter((phase): phase is WorkflowPhaseState => phase !== null)
      : [],
    artifacts: Array.isArray(raw.artifacts)
      ? raw.artifacts
          .map(normalizeArtifact)
          .filter((artifact): artifact is WorkflowArtifact => artifact !== null)
      : [],
    createdAt,
    updatedAt,
  };
  if (error !== '') run.error = error;
  return run;
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

/** 与 terminal.ts 一致：Windows 用 taskkill /T 杀进程树，POSIX 用进程组。 */
function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

export async function createWorkflowService(
  options: WorkflowServiceOptions,
): Promise<WorkflowService> {
  if (!isRecord(options) || typeof options.spawn !== 'function') {
    throw new TypeError('createWorkflowService 需要 spawn 回调');
  }

  const filePath = path.join(resolveDataDir(options.dataDir), RUNS_FILE);
  const workspace = path.resolve(process.env.WITCODE_WORKSPACE ?? process.cwd());
  const configured = options.maxRuns;
  const maxRuns =
    typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_RUNS;

  const runs: WorkflowRun[] = [];
  const activeRuns = new Map<string, ActiveRun>();

  // 单调时钟：保证同一毫秒内的多次更新也能稳定按 updatedAt 倒序排列。
  let lastAt = 0;
  const clock = (): number => {
    const now = Date.now();
    lastAt = now > lastAt ? now : lastAt + 1;
    return lastAt;
  };

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(parsed)) {
      const seen = new Set<string>();
      for (const raw of parsed) {
        const run = normalizeRun(raw, clock());
        if (run === null || seen.has(run.id)) continue;
        seen.add(run.id);
        runs.push(run);
      }
    }
  } catch {
    // 首次启动或文件损坏：空列表，不阻塞服务。
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt);
  runs.length = Math.min(runs.length, maxRuns);

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain
      .then(async () => {
        const ordered = [...runs]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, maxRuns);
        for (const [id, active] of activeRuns) {
          if (ordered.some((run) => run.id === id)) continue;
          activeRuns.delete(id);
          killProcessTree(active.child);
        }
        runs.splice(0, runs.length, ...ordered);
        await writeFileAtomic(filePath, `${JSON.stringify(ordered, null, 2)}\n`);
      })
      .catch(() => {
        // 落盘失败不中断运行；下一次更新会重试。
      });
    return writeChain;
  };

  const touch = (run: WorkflowRun): void => {
    run.updatedAt = clock();
    options.onUpdate?.(cloneRun(run));
    void persist();
  };

  const settle = async (id: string, status: WorkflowRunStatus, error?: string): Promise<void> => {
    const run = runs.find((candidate) => candidate.id === id);
    const active = activeRuns.get(id);
    if (run === undefined || active?.settled === true || isTerminal(run.status)) return;
    if (active !== undefined) active.settled = true;
    if (active?.timer !== undefined) clearTimeout(active.timer);

    run.status = status;
    if (error !== undefined && error !== '') run.error = error;
    touch(run);
    await persist();

    if (active !== undefined) {
      const snapshot = cloneRun(run);
      for (const waiter of active.waiters) waiter(snapshot);
      active.waiters.length = 0;
      activeRuns.delete(id);
    }
  };

  const writeToChild = (active: ActiveRun, payload: Record<string, unknown>): void => {
    if (active.settled || active.child.exitCode !== null || active.child.signalCode !== null) return;
    try {
      active.child.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* ignore */
    }
  };

  const findPhase = (run: WorkflowRun, active: ActiveRun): WorkflowPhaseState => {
    const current = run.phases.find((phase) => phase.id === active.currentPhaseId);
    if (current !== undefined) return current;
    const implicit: WorkflowPhaseState = {
      id: `phase-${randomUUID()}`,
      name: '默认阶段',
      status: 'running',
      actors: [],
    };
    run.phases.push(implicit);
    active.currentPhaseId = implicit.id;
    return implicit;
  };

  const findActor = (run: WorkflowRun, actorId: string): WorkflowActorState | undefined => {
    for (const phase of run.phases) {
      const actor = phase.actors.find((candidate) => candidate.id === actorId);
      if (actor !== undefined) return actor;
    }
    return undefined;
  };

  const handleEvent = (
    run: WorkflowRun,
    active: ActiveRun,
    event: Record<string, unknown>,
  ): void => {
    const type = text(event.type) as RunnerEventType;
    if (type === 'phase') {
      const name = text(event.name).trim() || '未命名阶段';
      let phase = run.phases.find((candidate) => candidate.name === name);
      if (phase === undefined) {
        phase = {
          id: `phase-${randomUUID()}`,
          name,
          status: 'running',
          actors: [],
        };
        run.phases.push(phase);
      } else {
        phase.status = 'running';
      }
      active.currentPhaseId = phase.id;
      touch(run);
      return;
    }

    if (type === 'agent') {
      const actorId = text(event.id).trim() || `actor-${randomUUID()}`;
      const name = text(event.name).trim() || '未命名角色';
      const phase = findPhase(run, active);
      if (!phase.actors.some((actor) => actor.id === actorId)) {
        phase.actors.push({ id: actorId, name, status: 'queued' });
      }
      touch(run);
      return;
    }

    if (type === 'ask') {
      const requestId = text(event.requestId);
      const actorId = text(event.actorId);
      const prompt = text(event.prompt);
      const actor = findActor(run, actorId);
      if (actor?.status === 'queued') actor.status = 'running';
      touch(run);

      const actorName = actor?.name ?? '未命名角色';
      void (async () => {
        try {
          if (active.settled) return;
          let result: WorkflowSpawnResult;
          try {
            result = await options.spawn(prompt, actorName);
          } catch (error) {
            result = { ok: false, output: '', error: messageOf(error) };
          }
          if (active.settled) return;
          if (result.ok) {
            writeToChild(active, { type: 'ask-result', requestId, result: result.output });
            if (actor !== undefined) {
              actor.status = 'done';
              actor.output = result.output;
            }
          } else {
            const reason = result.error || '子代理执行失败';
            writeToChild(active, { type: 'ask-result', requestId, error: reason });
            if (actor !== undefined) {
              actor.status = 'failed';
              actor.error = reason;
            }
          }
          touch(run);
        } catch (error) {
          // spawn 回调之外的异常不应让 run 卡死。
          void settle(run.id, 'failed', messageOf(error));
        }
      })();
      return;
    }

    if (type === 'artifact') {
      const artifact: WorkflowArtifact = {
        id: `art-${randomUUID()}`,
        title: text(event.title).trim() || '未命名产物',
        kind: 'markdown',
        content: text(event.content),
        createdAt: clock(),
      };
      run.artifacts.push(artifact);
      touch(run);
      return;
    }

    if (type === 'done') {
      for (const actor of run.phases.flatMap((phase) => phase.actors)) {
        if (actor.status === 'queued' || actor.status === 'running') actor.status = 'done';
      }
      for (const phase of run.phases) {
        if (phase.status === 'pending' || phase.status === 'running') phase.status = 'done';
      }
      void settle(run.id, 'completed');
      return;
    }

    if (type === 'error') {
      for (const actor of run.phases.flatMap((phase) => phase.actors)) {
        if (actor.status === 'queued' || actor.status === 'running') actor.status = 'failed';
      }
      for (const phase of run.phases) {
        if (phase.status === 'running') phase.status = 'failed';
      }
      void settle(run.id, 'failed', text(event.message).trim() || '工作流执行失败');
      return;
    }

    // log 以及未知事件不参与状态机，stdout 的非 JSON 行在解析处已忽略。
  };

  return {
    list() {
      return runs.map(cloneRun);
    },

    get(id) {
      const run = runs.find((candidate) => candidate.id === id);
      return run === undefined ? undefined : cloneRun(run);
    },

    async start(input) {
      if (!isRecord(input)) throw new TypeError('start(input) 需要对象');
      const name = text(input.name).trim();
      if (name === '') throw new Error('name 不能为空');
      const script = text(input.script);
      if (script.trim() === '') throw new Error('script 不能为空');
      if (script.length > MAX_SCRIPT_CHARS) {
        throw new Error(`script 不能超过 ${MAX_SCRIPT_CHARS} 字符`);
      }

      const at = clock();
      const run: WorkflowRun = {
        id: `wf-${randomUUID()}`,
        name,
        status: 'running',
        phases: [],
        artifacts: [],
        createdAt: at,
        updatedAt: at,
      };
      runs.unshift(run);
      options.onUpdate?.(cloneRun(run));

      let child: ChildProcess;
      try {
        child = spawnChild(process.execPath, [RUNNER_PATH], {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        run.status = 'failed';
        run.error = messageOf(error);
        touch(run);
        await persist();
        return cloneRun(run);
      }

      const active: ActiveRun = {
        child,
        waiters: [],
        settled: false,
      };
      activeRuns.set(run.id, active);

      let buffer = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line !== '') {
            try {
              const parsed: unknown = JSON.parse(line);
              if (isRecord(parsed)) handleEvent(run, active, parsed);
            } catch {
              // stdout 非 JSON 行：忽略。
            }
          }
          index = buffer.indexOf('\n');
        }
      });
      child.stderr?.resume();
      child.on('error', (error) => {
        void settle(run.id, 'failed', messageOf(error));
      });
      child.on('close', (code) => {
        if (active.settled || isTerminal(run.status)) return;
        void settle(
          run.id,
          'failed',
          code === 0 ? '工作流进程提前退出' : `工作流进程退出（code=${code}）`,
        );
      });

      active.timer = setTimeout(() => {
        if (active.settled) return;
        killProcessTree(child);
        void settle(run.id, 'failed', `执行超时（${DEFAULT_TIMEOUT_MS}ms）`);
      }, DEFAULT_TIMEOUT_MS);
      active.timer.unref?.();

      writeToChild(active, { type: 'start', script });
      await persist();
      return cloneRun(run);
    },

    async cancel(id) {
      const run = runs.find((candidate) => candidate.id === id);
      if (run === undefined) return undefined;
      if (isTerminal(run.status)) return cloneRun(run);
      const active = activeRuns.get(id);
      if (active !== undefined) killProcessTree(active.child);
      await settle(id, 'cancelled');
      return cloneRun(run);
    },

    async wait(id) {
      const run = runs.find((candidate) => candidate.id === id);
      if (run === undefined) return undefined;
      if (isTerminal(run.status)) return cloneRun(run);
      const active = activeRuns.get(id);
      if (active === undefined) return cloneRun(run);
      return new Promise<WorkflowRun>((resolve) => {
        active.waiters.push(resolve);
      });
    },
  };
}
