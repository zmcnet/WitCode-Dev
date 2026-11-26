import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { ModelChunk } from '@witcode/protocol';
import { createOpenAIProvider, createProviderFromEnv } from '../src/index.ts';

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string', 'server should listen on a TCP port');

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('streams text, aggregates tool calls, and reports usage', async () => {
  await withServer(
    (req, res) => {
      req.resume();
      assert.equal(req.url, '/v1/chat/completions', 'baseUrl trailing slashes must be normalized');

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });

      const events = [
        { choices: [{ index: 0, delta: { content: '正在查询天气' }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"北' } }] },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '京"}' } }] },
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        },
      ];

      // 第一行完整发送，第二行故意拆成两段，验证 SSE 的跨 chunk 缓冲。
      res.write(`data: ${JSON.stringify(events[0])}\n\n`);
      const second = `data: ${JSON.stringify(events[1])}\n\n`;
      res.write(second.slice(0, 15));
      setTimeout(() => {
        res.write(second.slice(15));
        for (const event of events.slice(2)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }, 5);
    },
    async (url) => {
      const provider = createOpenAIProvider({
        baseUrl: `${url}/v1///`,
        apiKey: 'test-key',
        model: 'test-model',
      });
      assert.equal(provider.id, 'openai:test-model');

      const chunks: ModelChunk[] = [];
      for await (const chunk of provider.stream({
        messages: [{ role: 'user', content: '北京天气' }],
      })) {
        chunks.push(chunk);
      }

      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === 'text'),
        [{ type: 'text', text: '正在查询天气' }],
      );
      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === 'tool-call'),
        [{ type: 'tool-call', call: { id: 'call_1', name: 'get_weather', input: { city: '北京' } } }],
      );
      assert.deepEqual(
        chunks.filter((chunk) => chunk.type === 'done'),
        [{ type: 'done', usage: { input: 12, output: 7 } }],
      );
      assert.equal(
        chunks.filter((chunk) => chunk.type === 'error').length,
        0,
        'a healthy stream must not emit errors',
      );
    },
  );
});

test('emits an error chunk for a non-2xx response', async () => {
  await withServer(
    (req, res) => {
      req.resume();
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('bad key');
    },
    async (url) => {
      const provider = createOpenAIProvider({
        baseUrl: url,
        apiKey: 'wrong',
        model: 'test-model',
      });
      const chunks: ModelChunk[] = [];
      for await (const chunk of provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]?.type, 'error');
      if (chunks[0]?.type === 'error') {
        assert.match(chunks[0].message, /401/);
        assert.match(chunks[0].message, /bad key/);
      }
    },
  );
});

test('createProviderFromEnv returns null unless all variables are set', () => {
  const keys = ['WITCODE_BASE_URL', 'WITCODE_API_KEY', 'WITCODE_MODEL'] as const;
  const original = keys.map((key) => process.env[key]);

  try {
    for (const key of keys) delete process.env[key];
    assert.equal(createProviderFromEnv(), null);

    process.env.WITCODE_BASE_URL = 'http://127.0.0.1:1/v1';
    process.env.WITCODE_API_KEY = 'key';
    assert.equal(createProviderFromEnv(), null, 'missing model must yield null');

    process.env.WITCODE_MODEL = 'env-model';
    const provider = createProviderFromEnv();
    assert.equal(provider?.id, 'openai:env-model');
  } finally {
    keys.forEach((key, index) => {
      const value = original[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
