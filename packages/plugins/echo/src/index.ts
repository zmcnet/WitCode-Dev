import type { Plugin } from '@witcode/kernel';
import type { ModelProvider } from '@witcode/protocol';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 回声模型：不调用任何外部服务，只把用户输入重复一遍。
 *
 * 它有两个用途：
 * - P0 时期证明链路通；
 * - 现在作为模型网关的兜底，保证「一个 provider 都没配」时依然能对话。
 */
export function createEchoProvider(): ModelProvider {
  return {
    id: 'echo',

    async *stream(request, signal) {
      const lastUser = [...request.messages].reverse().find((item) => item.role === 'user');
      const text = lastUser?.content ?? '';
      const reply =
        `我是回声模型。你说的是：「${text}」。\n\n` +
        `在「设置 → Providers」里添加一个 OpenAI 兼容的提供商，WitCode 就能开始干活了。`;

      for (const char of reply) {
        if (signal?.aborted) return;
        await sleep(18);
        if (signal?.aborted) return;
        yield { type: 'text', text: char };
      }

      yield { type: 'done' };
    },
  };
}

export const echoPlugin: Plugin = {
  name: 'echo-model',

  apply(ctx) {
    ctx.provide('model', createEchoProvider());
  },
};

export default echoPlugin;
