import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIProvider } from '../src/index.ts';

/**
 * SSE 行解析的纯测试：用内存里的 ReadableStream 伪造响应体，不启服务器、不发网络请求。
 * model 目前没有导出单独的 parseSSELine，所以通过 provider.stream() 观察解析结果。
 */
async function collect(chunks: string[]): Promise<unknown[]> {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    const provider = createOpenAIProvider({
      baseUrl: 'http://model.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const output: unknown[] = [];
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      output.push(chunk);
    }
    return output;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

test('SSE 行解析：只认 data: 行，[DONE] 终止，其他行忽略', async () => {
  const output = await collect([
    ': keep-alive\n\n',
    'event: message\n\n',
    data({ choices: [{ delta: { content: 'hi' } }] }),
    'data: [DONE]\n\n',
    data({ choices: [{ delta: { content: 'after-done' } }] }),
  ]);

  assert.deepEqual(output, [{ type: 'text', text: 'hi' }, { type: 'done', usage: undefined }]);
});

test('SSE 行解析：跨 chunk 的半行会缓冲合并后再解析', async () => {
  const payload = data({ choices: [{ delta: { content: '跨行' } }] });
  const cut = 12; // 落在 JSON 中间
  const output = await collect([payload.slice(0, cut), payload.slice(cut)]);

  assert.deepEqual(output, [
    { type: 'text', text: '跨行' },
    { type: 'done', usage: undefined },
  ]);
});

test('SSE 行解析：末尾没有换行的 data 行也会被解析', async () => {
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`;
  const output = await collect([payload]);

  assert.deepEqual(output, [
    { type: 'text', text: 'tail' },
    { type: 'done', usage: undefined },
  ]);
});

test('SSE 行解析：usage 帧映射为 done.usage', async () => {
  const output = await collect([
    data({ usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    'data: [DONE]\n\n',
  ]);

  assert.deepEqual(output, [{ type: 'done', usage: { input: 3, output: 4 } }]);
});

test('SSE 行解析：非法 JSON 产生 error 且不产生 done', async () => {
  const output = await collect(['data: {not json}\n\n']);

  assert.equal(output.length, 1);
  assert.equal((output[0] as { type: string }).type, 'error');
});
