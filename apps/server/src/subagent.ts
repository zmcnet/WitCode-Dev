/**
 * 子智能体服务：把一件独立任务交给独立会话执行，前台等待结果后回填。
 *
 * 行为参照 ZCode：独立 session id、独立 system prompt、工具 allowlist、
 * 权限继承不提权、结果回填；当前只做前台等待，不做后台任务。
 */

import { getBrain } from '@witcode/brains';
import type {
  ChatMessage,
  ModelProvider,
  SessionStore,
  SubagentTaskResult,
  ToolCall,
  ToolService,
} from '@witcode/protocol';
import type { Security } from '@witcode/security';

import { runAgentLoop } from './agent-loop.ts';

/** 最多嵌套 3 层：主智能体 depth 0，子智能体 depth 1..3。 */
export const MAX_SUBAGENT_DEPTH = 3;

const DEFAULT_MAX_SUBAGENTS = 3;
const DEFAULT_BRAIN_ID = 'coding';
const MAX_STEPS = 15;

export interface SubagentServiceOptions {
  provider: ModelProvider;
  tools: ToolService;
  sessions: SessionStore;
  security?: Security;
  workspace: string;
  /** 单次会话最多派发的子智能体数，默认 3。 */
  maxSubagents?: number;
}

export interface SubagentSpawnInput {
  task: string;
  brainId?: string;
  parentSessionId?: string;
  /** 当前层；从 ToolContext.depth 透传，默认 0（主智能体）。 */
  depth?: number;
  /** 工具 allowlist；不传则使用传入的 ToolService 全量工具。 */
  tools?: string[];
  signal?: AbortSignal;
  onEvent?: (event: { type: 'text'; text: string }) => void;
}

export interface SubagentService {
  spawn(input: SubagentSpawnInput): Promise<SubagentTaskResult>;
  remaining(): number;
}

/**
 * 只收窄、不放宽：传入的 ToolService 是权限边界，allowlist 只能从中再减。
 */
function scopeTools(base: ToolService, allow?: string[]): ToolService {
  if (!allow) return base;
  const allowed = new Set(allow);
  return {
    register: () => () => {},
    list: () => base.list().filter((tool) => allowed.has(tool.name)),
    run: (name, input, ctx) =>
      allowed.has(name)
        ? base.run(name, input, ctx)
        : Promise.resolve({ ok: false, content: '', error: `工具不在允许列表：${name}` }),
  };
}

/** 从写类工具入参粗提变更文件；提不到就返回空数组。 */
function filesFromToolCall(call: ToolCall): string[] {
  if (!/write|edit|create|save|patch/i.test(call.name)) return [];
  const input = call.input;
  if (input === null || typeof input !== 'object') return [];
  const args = input as { path?: unknown; file?: unknown };
  const value = typeof args.path === 'string' ? args.path : args.file;
  return typeof value === 'string' && value.trim() ? [value] : [];
}

export function createSubagentService(options: SubagentServiceOptions): SubagentService {
  const maxSubagents = options.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
  let spawned = 0;

  return {
    async spawn(input) {
      const task = input.task;
      if (typeof task !== 'string' || task.trim().length === 0) {
        throw new Error('task 不能为空');
      }

      const depth = input.depth ?? 0;
      if (depth >= MAX_SUBAGENT_DEPTH) {
        throw new Error('子智能体最多 3 层');
      }
      if (spawned >= maxSubagents) {
        throw new Error(`子智能体数量已达上限（${maxSubagents}）`);
      }
      spawned += 1;

      let id = '';
      try {
        const session = await options.sessions.create(`子任务[L${depth}]:${task.slice(0, 20)}`);
        id = session.id;

        const brain = getBrain(input.brainId ?? DEFAULT_BRAIN_ID);
        if (!brain) throw new Error(`未知的脑子：${input.brainId ?? DEFAULT_BRAIN_ID}`);

        const rules = brain.rules.length
          ? ['## 硬规则', ...brain.rules.map((rule) => `- ${rule}`)].join('\n')
          : '';
        const system = [
          brain.identity.trim(),
          rules,
          `你是被主智能体派发的子智能体，只做这一件事：${task}`,
        ]
          .filter((part) => part.trim().length > 0)
          .join('\n\n');

        // 独立会话：不继承主对话历史，只落任务本身，再由 loop 落最终回答。
        await options.sessions.append(id, { role: 'user', content: task });

        const changedFiles = new Set<string>();
        const pendingFiles = new Map<string, string>();
        let streamed = '';

        const result = await runAgentLoop(
          [
            { role: 'system', content: system },
            { role: 'user', content: task },
          ],
          {
            provider: options.provider,
            tools: scopeTools(options.tools, input.tools),
            workspace: options.workspace,
            sessionId: id,
            depth: depth + 1,
            brain,
            security: options.security,
            maxSteps: MAX_STEPS,
            signal: input.signal,
            onText: (text) => {
              streamed += text;
              input.onEvent?.({ type: 'text', text });
            },
            onToolCall: (call) => {
              if (input.tools && !input.tools.includes(call.name)) return;
              for (const file of filesFromToolCall(call)) pendingFiles.set(call.id, file);
            },
            onToolResult: (call, result) => {
              const file = pendingFiles.get(call.id);
              if (file && result.ok) changedFiles.add(file);
              pendingFiles.delete(call.id);
            },
          },
        );

        const output =
          [...result.messages]
            .reverse()
            .find((message) => message.role === 'assistant' && message.content)?.content ??
          streamed;
        if (output) {
          await options.sessions.append(id, { role: 'assistant', content: output });
        }

        return { id, status: 'done', output, filesChanged: [...changedFiles] };
      } catch (error) {
        return {
          id,
          status: 'failed',
          output: error instanceof Error ? error.message : String(error),
          filesChanged: [],
        };
      }
    },

    remaining() {
      return Math.max(0, maxSubagents - spawned);
    },
  };
}
