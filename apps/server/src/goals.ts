/**
 * 会话目标：模型用 set_goal 立目标、update_goal 更新完成/受阻状态，get_goal 读回。
 *
 * 每个 session 一个 JSON 文件 `<dataDir>/goals/<safeSessionId>.json`，原子写；
 * 文件不存在就是没有目标。目标只属于模型自己的跟踪记录，不碰用户文件。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';

export type GoalStatus = 'active' | 'completed' | 'blocked' | 'cancelled';

export interface GoalState {
  goal: string;
  status: GoalStatus;
  note?: string;
  updatedAt: number;
}

export interface GoalStore {
  get(sessionId: string): GoalState | null;
  set(sessionId: string, state: GoalState): void;
  clear(sessionId: string): void;
}

const DEFAULT_SESSION_ID = 'default';
const STATUSES: readonly GoalStatus[] = ['active', 'completed', 'blocked', 'cancelled'];

function dataDir(options?: { dataDir?: string }): string {
  return options?.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

/**
 * 把 sessionId 收敛成安全文件名：只保留字母数字、点、下划线、连字符；
 * 其余字符（含 / 和 \）替换为 _，含 `..`、隐藏文件或过长时用哈希兜底。
 */
function safeSessionId(sessionId: string): string {
  const raw = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : DEFAULT_SESSION_ID;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (
    cleaned === '' ||
    cleaned === '.' ||
    cleaned === '..' ||
    cleaned.includes('..') ||
    cleaned.startsWith('.') ||
    cleaned.length > 120
  ) {
    return `s-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
  }
  return cleaned;
}

function sessionIdOf(ctx: ToolContext): string {
  return typeof ctx.sessionId === 'string' && ctx.sessionId.trim() !== ''
    ? ctx.sessionId
    : DEFAULT_SESSION_ID;
}

function goalFile(root: string, sessionId: string): string {
  return path.join(root, `${safeSessionId(sessionId)}.json`);
}

/** 校验并归一化目标状态：goal 非空、status 合法、updatedAt 为数字，可选 note。 */
function normalizeState(value: unknown): GoalState {
  if (typeof value !== 'object' || value === null) throw new Error('目标状态必须是对象');
  const state = value as Record<string, unknown>;
  if (typeof state.goal !== 'string' || state.goal.trim() === '') {
    throw new Error('goal 不能为空');
  }
  if (typeof state.status !== 'string' || !(STATUSES as readonly string[]).includes(state.status)) {
    throw new Error(`status 非法：${String(state.status)}`);
  }
  if (typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) {
    throw new Error('updatedAt 必须是数字');
  }
  const normalized: GoalState = {
    goal: state.goal.trim(),
    status: state.status as GoalStatus,
    updatedAt: state.updatedAt,
  };
  if (state.note !== undefined && state.note !== null) {
    if (typeof state.note !== 'string') throw new Error('note 必须是字符串');
    const note = state.note.trim();
    if (note !== '') normalized.note = note;
  }
  return normalized;
}

function writeJsonAtomic(file: string, state: GoalState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export async function createGoalStore(options?: { dataDir?: string }): Promise<GoalStore> {
  const root = path.join(dataDir(options), 'goals');
  await mkdir(root, { recursive: true });

  return {
    get(sessionId) {
      let text: string;
      try {
        text = readFileSync(goalFile(root, sessionId), 'utf8');
      } catch {
        return null;
      }
      try {
        return normalizeState(JSON.parse(text) as unknown);
      } catch {
        return null;
      }
    },

    set(sessionId, state) {
      writeJsonAtomic(goalFile(root, sessionId), normalizeState(state));
    },

    clear(sessionId) {
      try {
        unlinkSync(goalFile(root, sessionId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/** 把目标渲染成给模型看的文本；没有目标有固定提示。 */
function renderGoal(state: GoalState | null): string {
  if (!state) return '当前没有目标';
  const lines = [`目标：${state.goal}`, `状态：${state.status}`];
  if (state.note) lines.push(`说明：${state.note}`);
  return lines.join('\n');
}

const SET_GOAL_DESCRIPTION = [
  '设置或覆盖当前会话的目标：多轮大任务先立目标，完成/受阻时用 update_goal 更新。',
  '目标只属于模型自己的跟踪记录，不修改用户的文件。',
].join('');

const GET_GOAL_DESCRIPTION = [
  '读取当前会话的目标。多轮大任务先立目标，完成/受阻时更新，可用它确认当前目标与状态。',
].join('');

const UPDATE_GOAL_DESCRIPTION = [
  '多轮大任务先立目标，完成/受阻时及时更新目标状态与说明（也可标记取消）。',
  '当前没有目标会报错，需先用 set_goal 立目标。',
].join('');

const SET_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: '当前会话的目标，不能为空' },
  },
  required: ['goal'],
};

const UPDATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: [...STATUSES],
      description: 'active（进行中）| completed（已完成）| blocked（受阻）| cancelled（已取消）',
    },
    note: { type: 'string', description: '可选说明；不填保留原说明' },
  },
  required: ['status'],
};

export function createGoalTools(store: GoalStore): ToolDefinition[] {
  return [
    {
      name: 'set_goal',
      description: SET_GOAL_DESCRIPTION,
      inputSchema: SET_INPUT_SCHEMA,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: 'low',
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        try {
          const args =
            input !== null && typeof input === 'object' ? (input as { goal?: unknown }) : {};
          if (typeof args.goal !== 'string' || args.goal.trim() === '') {
            throw new Error('goal 不能为空');
          }
          const state: GoalState = {
            goal: args.goal.trim(),
            status: 'active',
            updatedAt: Date.now(),
          };
          store.set(sessionIdOf(ctx), state);
          return { ok: true, content: renderGoal(state) };
        } catch (err) {
          return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'get_goal',
      description: GET_GOAL_DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: 'low',
      async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
        return { ok: true, content: renderGoal(store.get(sessionIdOf(ctx))) };
      },
    },
    {
      name: 'update_goal',
      description: UPDATE_GOAL_DESCRIPTION,
      inputSchema: UPDATE_INPUT_SCHEMA,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: 'low',
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        try {
          const args =
            input !== null && typeof input === 'object'
              ? (input as { status?: unknown; note?: unknown })
              : {};
          if (
            typeof args.status !== 'string' ||
            !(STATUSES as readonly string[]).includes(args.status)
          ) {
            throw new Error(`status 非法：${String(args.status)}`);
          }
          if (args.note !== undefined && args.note !== null && typeof args.note !== 'string') {
            throw new Error('note 必须是字符串');
          }
          const current = store.get(sessionIdOf(ctx));
          if (!current) throw new Error('当前没有目标，无法更新；请先使用 set_goal 设置目标');
          const updated: GoalState = {
            ...current,
            status: args.status as GoalStatus,
            updatedAt: Date.now(),
          };
          if (args.note !== undefined && args.note !== null) updated.note = args.note as string;
          store.set(sessionIdOf(ctx), updated);
          return { ok: true, content: renderGoal(store.get(sessionIdOf(ctx))) };
        } catch (err) {
          return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
