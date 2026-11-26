/**
 * 剧本模型：不调用任何外部服务，按固定剧本触发工具调用。
 *
 * 用途：没有 API key 时验证链路，也用于 e2e。
 * - `read`：读一次 README 再总结。
 * - `collab`：先问伙伴，再派子智能体，最后总结。
 *
 * 只在 WITCODE_MODEL_MODE=scripted|collab 时启用。
 */

import type { ModelProvider } from '@witcode/protocol';

export type ScriptedMode = 'read' | 'collab';

export function createScriptedProvider(mode: ScriptedMode = 'read'): ModelProvider {
  return mode === 'collab' ? createCollabProvider() : createReadProvider();
}

function createReadProvider(): ModelProvider {
  return {
    id: 'scripted',

    async *stream(request) {
      const hasToolResult = request.messages.some((item) => item.role === 'tool');

      if (!hasToolResult) {
        yield { type: 'text', text: '我先看一眼项目说明。\n' };
        yield {
          type: 'tool-call',
          call: {
            id: 'call_read_readme',
            name: 'read_file',
            input: { path: 'README.md', limit: 40 },
          },
        };
        yield { type: 'done', usage: { input: 1, output: 1 } };
        return;
      }

      const toolMessage = [...request.messages].reverse().find((item) => item.role === 'tool');
      const content = toolMessage?.content ?? '(没有拿到工具结果)';

      yield {
        type: 'text',
        text: `我读到了这些内容：\n\n${content.slice(0, 800)}`,
      };
      yield { type: 'done', usage: { input: 2, output: 2 } };
    },
  };
}

function createCollabProvider(): ModelProvider {
  return {
    id: 'scripted-collab',

    async *stream(request) {
      const system = request.messages.find((item) => item.role === 'system')?.content ?? '';

      // 伙伴：只给意见。
      if (system.includes('作为伙伴')) {
        yield {
          type: 'text',
          text: '伙伴意见：先补测试再改实现；注意旧会话的兼容；风险点在权限边界。',
        };
        yield { type: 'done' };
        return;
      }

      // 子智能体：只做自己的任务。
      if (system.includes('子智能体')) {
        yield {
          type: 'text',
          text: '子任务完成：README 第一行是 `# WitCode`。',
        };
        yield { type: 'done' };
        return;
      }

      const toolMessages = request.messages.filter((item) => item.role === 'tool');
      const toolNames = new Set(toolMessages.map((item) => item.toolName));

      if (toolMessages.length === 0) {
        yield { type: 'text', text: '我先问一下 Profession 的意见。\n' };
        yield {
          type: 'tool-call',
          call: {
            id: 'call_partner',
            name: 'consult_partner',
            input: { brainId: 'profession', question: '这次改动有什么风险？' },
          },
        };
        yield { type: 'done' };
        return;
      }

      if (!toolNames.has('spawn_subagent')) {
        yield { type: 'text', text: '伙伴说完了，我派个子智能体去核对 README。\n' };
        yield {
          type: 'tool-call',
          call: {
            id: 'call_subagent',
            name: 'spawn_subagent',
            input: { task: '检查 README 的第一行是什么' },
          },
        };
        yield { type: 'done' };
        return;
      }

      const partner = [...toolMessages]
        .reverse()
        .find((item) => item.toolName === 'consult_partner');
      const subagent = [...toolMessages]
        .reverse()
        .find((item) => item.toolName === 'spawn_subagent');

      yield {
        type: 'text',
        text: [
          '协作完成。',
          `伙伴：${(partner?.content ?? '').slice(0, 120)}`,
          `子智能体：${(subagent?.content ?? '').slice(0, 120)}`,
        ].join('\n'),
      };
      yield { type: 'done' };
    },
  };
}
