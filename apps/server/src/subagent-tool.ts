/**
 * 把子智能体服务包装成主智能体可调用的 spawn_subagent 工具。
 *
 * depth 从 ToolContext.depth 透传：主智能体调用时是 0，子智能体调用 layer+1，
 * 由 SubagentService 在 depth >= 3 时拒绝，防止无限套娃。
 */

import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';
import type { createSubagentService } from './subagent.ts';

export function subagentTool(
  service: ReturnType<typeof createSubagentService>,
): ToolDefinition {
  return {
    name: 'spawn_subagent',
    description: [
      '把一件独立、可并行、需要独立上下文的任务派给子智能体执行，前台等待并拿回结论。',
      '适合边界清楚、能单独验收的工作；不要用它做一句话就能完成的事。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给子智能体独立完成的任务，需写清目标与验收标准',
        },
        brainId: {
          type: 'string',
          description: '执行任务的脑子 id；不传默认 coding',
        },
      },
      required: ['task'],
    },
    // 派发本身不碰文件；子智能体内部的读写/命令仍逐个走权限与确认。
    readOnly: true,
    destructive: false,
    riskLevel: 'low',
    concurrentSafe: false,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args =
        input !== null && typeof input === 'object'
          ? (input as { task?: unknown; brainId?: unknown })
          : {};
      if (typeof args.task !== 'string' || args.task.trim().length === 0) {
        return { ok: false, content: '', error: 'task 不能为空' };
      }

      const brainId =
        typeof args.brainId === 'string' && args.brainId.trim().length > 0
          ? args.brainId
          : undefined;

      const result = await service.spawn({
        task: args.task,
        brainId,
        depth: ctx.depth ?? 0,
        signal: ctx.signal,
      });

      return { ok: result.status === 'done', content: result.output };
    },
  };
}
