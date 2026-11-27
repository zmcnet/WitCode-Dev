/**
 * 待办清单：模型用 todo_write 整表替换自己的计划，todo_read 读回当前进度。
 *
 * 每个 session 一个 JSON 文件 `<dataDir>/todos/<safeSessionId>.json`，原子写；
 * 文件不存在就是空清单。清单只属于模型自己的计划，不碰用户文件。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  TodoItem,
  TodoStatus,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@witcode/protocol';

const DEFAULT_SESSION_ID = 'default';
const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_TODOS = 50;
const MARKS: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

function dataDir(options?: { dataDir?: string }): string {
  return options?.dataDir ?? process.env.WITCODE_DATA_DIR ?? path.join(os.homedir(), '.witcode');
}

/**
 * 把 sessionId 收敛成安全文件名：只保留字母数字、点、下划线、连字符；
 * 其余字符（含 / 和 \）替换为 _，含 `..`、隐藏文件或过长时用哈希兜底。
 */
export function safeSessionId(sessionId: string): string {
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

function todoFile(root: string, sessionId?: string): string {
  return path.join(root, `${safeSessionId(sessionId ?? DEFAULT_SESSION_ID)}.json`);
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.content === 'string' &&
    typeof item.status === 'string' &&
    (STATUSES as readonly string[]).includes(item.status)
  );
}

/** 校验并归一化模型提交的整张清单：补 id、去重 id、默认状态、条数上限。 */
function normalizeItems(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) throw new Error('items 必须是数组');
  if (input.length > MAX_TODOS) throw new Error(`待办最多 ${MAX_TODOS} 条`);

  const items: TodoItem[] = [];
  const usedIds = new Set<string>();

  for (const [index, raw] of input.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`第 ${index + 1} 项必须是对象`);
    }
    const item = raw as { id?: unknown; content?: unknown; status?: unknown };
    if (typeof item.content !== 'string' || item.content.trim() === '') {
      throw new Error(`第 ${index + 1} 项 content 不能为空`);
    }

    let status: TodoStatus = 'pending';
    if (item.status !== undefined && item.status !== null && item.status !== '') {
      if (
        typeof item.status !== 'string' ||
        !(STATUSES as readonly string[]).includes(item.status)
      ) {
        throw new Error(`第 ${index + 1} 项 status 非法：${String(item.status)}`);
      }
      status = item.status as TodoStatus;
    }

    let id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id === '' || usedIds.has(id)) id = randomUUID();
    while (usedIds.has(id)) id = randomUUID();
    usedIds.add(id);

    items.push({ id, content: item.content.trim(), status });
  }

  return items;
}

function writeJsonAtomic(file: string, items: TodoItem[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export interface TodoStore {
  get(sessionId: string): TodoItem[];
  replace(sessionId: string, items: TodoItem[]): TodoItem[];
  clear(sessionId: string): void;
}

export async function createTodoStore(options?: { dataDir?: string }): Promise<TodoStore> {
  const root = path.join(dataDir(options), 'todos');
  await mkdir(root, { recursive: true });

  return {
    get(sessionId) {
      let text: string;
      try {
        text = readFileSync(todoFile(root, sessionId), 'utf8');
      } catch {
        return [];
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTodoItem).map((item) => ({ ...item }));
      } catch {
        return [];
      }
    },

    replace(sessionId, items) {
      const normalized = normalizeItems(items);
      writeJsonAtomic(todoFile(root, sessionId), normalized);
      return normalized;
    },

    clear(sessionId) {
      try {
        unlinkSync(todoFile(root, sessionId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/** 把清单渲染成给模型看的文本；空清单有固定提示。 */
export function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return '当前没有待办';
  const pending = items.filter((item) => item.status === 'pending').length;
  const inProgress = items.filter((item) => item.status === 'in_progress').length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const lines = items.map(
    (item, index) => `${index + 1}. ${MARKS[item.status] ?? '[ ]'} ${item.content}`,
  );
  return [
    `待办清单（${pending} 待办 / ${inProgress} 进行中 / ${completed} 已完成）：`,
    ...lines,
  ].join('\n');
}

const TODO_WRITE_DESCRIPTION = [
  '记录并更新多步任务的待办清单：开始前先列出每一步，完成一项立即更新为 completed。',
  '每次调用提交整份清单，替换旧清单；一句话能做完的单步任务可不用。',
  '清单是模型自己的计划，不修改用户的文件。',
].join('');

const TODO_READ_DESCRIPTION = [
  '读取当前会话的待办清单。多步任务先列计划、完成一项就更新，可用它确认当前进度。',
].join('');

const WRITE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_TODOS,
      description: '完整的待办清单；本次调用整表替换之前的清单',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '可选；不填自动生成，重复时自动去重' },
          content: { type: 'string', description: '一个具体步骤，不能为空' },
          status: {
            type: 'string',
            enum: [...STATUSES],
            description: 'pending（默认）| in_progress（正在做）| completed（已完成）',
          },
        },
        required: ['content'],
      },
    },
  },
  required: ['items'],
};

export function createTodoTools(store: TodoStore): ToolDefinition[] {
  return [
    {
      name: 'todo_write',
      description: TODO_WRITE_DESCRIPTION,
      inputSchema: WRITE_INPUT_SCHEMA,
      readOnly: true,
      destructive: false,
      riskLevel: 'low',
      concurrentSafe: true,
      async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        try {
          const args =
            input !== null && typeof input === 'object'
              ? (input as { items?: unknown })
              : {};
          const items = normalizeItems(args.items);
          return { ok: true, content: renderTodos(store.replace(sessionIdOf(ctx), items)) };
        } catch (err) {
          return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'todo_read',
      description: TODO_READ_DESCRIPTION,
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      destructive: false,
      riskLevel: 'low',
      concurrentSafe: true,
      async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
        return { ok: true, content: renderTodos(store.get(sessionIdOf(ctx))) };
      },
    },
  ];
}
