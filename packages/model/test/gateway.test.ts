import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ModelChunk,
  ModelGateway,
  ModelRequest,
  ModelSelection,
  ModelService,
} from '@witcode/protocol';
import { createModelGateway } from '../src/gateway.ts';
import type { GatewayOptions, StoredProvider } from '../src/types.ts';

const request: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'witcode-gateway-'));
  try {
    await run(dir);
  } finally {
    // Windows 下临时目录偶尔被占用而删不掉，忽略即可。
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

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

function fakeService(
  id: string,
  chunks: ModelChunk[],
  onRequest?: (request: ModelRequest) => void,
): ModelService {
  return {
    id,
    async *stream(incoming) {
      onRequest?.(incoming);
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 产出一段文本并以带用量的 done 结束的假服务。 */
function textService(
  id: string,
  text = 'ok',
  usage: { input: number; output: number } = { input: 1, output: 1 },
  onRequest?: (request: ModelRequest) => void,
): ModelService {
  return fakeService(
    id,
    [
      { type: 'text', text },
      { type: 'done', usage },
    ],
    onRequest,
  );
}

interface Harness {
  gateway: ModelGateway;
  /** createProvider 实际收到的 (provider, model)，按调用顺序。 */
  created: Array<{ provider: StoredProvider; model: string }>;
  /** 按 `${provider.id}:${model}` 注册的假服务。 */
  services: Map<string, ModelService>;
}

async function makeHarness(dataDir: string, extra: Partial<GatewayOptions> = {}): Promise<Harness> {
  const created: Array<{ provider: StoredProvider; model: string }> = [];
  const services = new Map<string, ModelService>();
  const options: GatewayOptions = {
    dataDir,
    createProvider(provider, model) {
      created.push({ provider, model });
      const service = services.get(`${provider.id}:${model}`);
      if (!service) throw new Error(`no fake service for ${provider.id}:${model}`);
      return service;
    },
    fallback: textService('fallback', 'fallback', { input: 0, output: 0 }),
    ...extra,
  };
  return { gateway: await createModelGateway(options), created, services };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('CRUD 与脱敏：列表不含明文 key，模型被展平', async () => {
  await withTempDir(async (dir) => {
    const { gateway } = await makeHarness(dir);
    const secretA = 'sk-secret-abcdefghijklmnop';
    const secretB = 'sk-secret-zzyyzzzzzzzzzzzz';

    const a = await gateway.saveProvider({
      name: 'Provider A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: secretA,
      modelIds: ['m1', 'm2'],
    });
    const b = await gateway.saveProvider({
      name: 'Provider B',
      baseUrl: 'https://b.invalid/v1',
      apiKey: secretB,
      modelIds: ['m3'],
    });
    assert.notEqual(a.id, b.id);

    const providers = await gateway.listProviders();
    assert.equal(providers.length, 2);
    for (const provider of providers) {
      assert.equal('apiKey' in provider, false);
      assert.equal(provider.hasApiKey, true);
      assert.ok(provider.apiKeyHint && provider.apiKeyHint !== '未设置');
    }
    const serialized = JSON.stringify(providers);
    assert.equal(serialized.includes(secretA), false);
    assert.equal(serialized.includes(secretB), false);

    const models = await gateway.listModels();
    assert.deepEqual(
      models.map((model) => [model.providerId, model.id]),
      [
        [a.id, 'm1'],
        [a.id, 'm2'],
        [b.id, 'm3'],
      ],
    );
    assert.equal(models[0]?.providerName, 'Provider A');
  });
});

test('编辑合并：apiKey 留空时内部仍用旧 key', async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const oldKey = 'sk-keep-this-key-123456';
    const saved = await harness.gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: oldKey,
      modelIds: ['m1'],
    });
    harness.services.set(`${saved.id}:m1`, textService('A'));

    const edited = await harness.gateway.saveProvider({
      id: saved.id,
      name: 'A renamed',
      baseUrl: 'https://a.invalid/v1',
      apiKey: '',
      modelIds: ['m1'],
    });
    assert.equal(edited.id, saved.id);
    assert.equal(edited.hasApiKey, true);

    await collect(harness.gateway.stream(request));
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0]?.provider.apiKey, oldKey);
    assert.equal(harness.created[0]?.provider.name, 'A renamed');
  });
});

test('删除联动：删除当前 selection 指向的 provider 后清空 selection', async () => {
  await withTempDir(async (dir) => {
    const { gateway } = await makeHarness(dir);
    const saved = await gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: 'sk-delete-me-1234567890',
      modelIds: ['m1'],
    });
    const selected: ModelSelection = { providerId: saved.id, model: 'm1' };
    await gateway.setSelection(selected);
    assert.deepEqual(gateway.getSelection(), selected);

    await gateway.deleteProvider(saved.id);
    assert.equal(gateway.getSelection(), null);
    assert.deepEqual(await gateway.listProviders(), []);
  });
});

test('selection 注入：请求被强制带上当前 selection', async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const saved = await harness.gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: 'sk-inject-1234567890',
      modelIds: ['m1'],
    });
    const selected: ModelSelection = { providerId: saved.id, model: 'm1' };
    await harness.gateway.setSelection(selected);

    let received: ModelRequest | undefined;
    harness.services.set(
      `${saved.id}:m1`,
      textService('A', 'selected', undefined, (incoming) => {
        received = incoming;
      }),
    );

    const chunks = await collect(harness.gateway.stream(request));
    assert.equal(chunks[0]?.type, 'text');
    const seen = received;
    assert.ok(seen);
    assert.deepEqual(seen.selection, selected);
  });
});

test('selection 持久化：重建网关后仍读到 selection', async () => {
  await withTempDir(async (dir) => {
    const first = await makeHarness(dir);
    const saved = await first.gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: 'sk-persist-1234567890',
      modelIds: ['m1'],
    });
    const selected: ModelSelection = { providerId: saved.id, model: 'm1' };
    await first.gateway.setSelection(selected);

    const second = await makeHarness(dir);
    assert.deepEqual(second.gateway.getSelection(), selected);
  });
});

test('兜底：没有任何 provider 时走 fallback', async () => {
  await withTempDir(async (dir) => {
    const { gateway } = await makeHarness(dir);
    assert.deepEqual(await gateway.listProviders(), []);

    const chunks = await collect(gateway.stream(request));
    assert.deepEqual(chunks, [
      { type: 'text', text: 'fallback' },
      { type: 'done', usage: { input: 0, output: 0 } },
    ]);
  });
});

test('用量：成功请求后 listUsage 与 summary 有记录', async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const saved = await harness.gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: 'sk-usage-1234567890',
      modelIds: ['m1'],
    });
    harness.services.set(`${saved.id}:m1`, textService('A', 'hi', { input: 5, output: 7 }));

    await collect(harness.gateway.stream(request));

    const usage = await harness.gateway.listUsage();
    assert.ok(usage.length >= 1);
    assert.equal(usage[0]?.ok, true);
    const summary = await harness.gateway.summary();
    assert.ok(summary.totalRequests >= 1);
  });
});

test('失败切换：A 返回 error 后 B 成功，usage 至少两条', async () => {
  await withTempDir(async (dir) => {
    const harness = await makeHarness(dir);
    const a = await harness.gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: 'sk-fail-1234567890',
      modelIds: ['m1'],
    });
    const b = await harness.gateway.saveProvider({
      name: 'B',
      baseUrl: 'https://b.invalid/v1',
      apiKey: 'sk-ok-1234567890',
      modelIds: ['m1'],
    });
    harness.services.set(`${a.id}:m1`, fakeService('A', [{ type: 'error', message: '429 rate limited' }]));
    harness.services.set(`${b.id}:m1`, textService('B', 'from B'));

    const chunks = await collect(harness.gateway.stream(request));
    assert.deepEqual(chunks, [
      { type: 'text', text: 'from B' },
      { type: 'done', usage: { input: 1, output: 1 } },
    ]);

    const usage = await harness.gateway.listUsage();
    assert.ok(usage.length >= 2);
    const byProvider = new Map(usage.map((record) => [record.providerId, record]));
    assert.equal(byProvider.get(a.id)?.ok, false);
    assert.equal(byProvider.get(a.id)?.error, '429 rate limited');
    assert.equal(byProvider.get(b.id)?.ok, true);
  });
});

test('listModels：模型级覆盖优先，禁用模型仍返回供 UI 展示', async () => {
  await withTempDir(async (dir) => {
    const { gateway } = await makeHarness(dir);
    await gateway.saveProvider({
      name: 'A',
      baseUrl: 'https://a.invalid/v1',
      apiKey: 'sk-models-1234567890',
      modelIds: ['m1', 'm2', 'm3'],
      contextWindow: 2_000_000,
      modelSettings: {
        m1: {
          displayName: '  GPT-4o  ',
          contextWindow: 3_000_000,
          maxOutputTokens: 32_000,
          enabled: true,
        },
        m3: { enabled: false },
      },
    });
    await gateway.saveProvider({
      name: 'B',
      baseUrl: 'https://b.invalid/v1',
      apiKey: 'sk-models-b-123456',
      modelIds: ['x'],
      enabled: false,
    });

    const models = await gateway.listModels();
    assert.deepEqual(
      models.map((model) => [
        model.id,
        model.displayName,
        model.contextWindow,
        model.maxOutputTokens,
        model.enabled,
      ]),
      [
        ['m1', 'GPT-4o', 3_000_000, 32_000, true],
        ['m2', undefined, 2_000_000, 128_000, true],
        ['m3', undefined, 2_000_000, 128_000, false],
        ['x', undefined, 1_000_000, 128_000, false],
      ],
    );
    assert.equal(models[0]?.providerName, 'A');
  });
});

test('reorderProviders：按 ids 重排并返回脱敏列表，重启后保留顺序', async () => {
  await withTempDir(async (dir) => {
    const { gateway } = await makeHarness(dir);
    const a = await gateway.saveProvider({
      name: 'A', baseUrl: 'https://a.invalid/v1', apiKey: 'sk-r1-1234567890', modelIds: ['m1'],
    });
    const b = await gateway.saveProvider({
      name: 'B', baseUrl: 'https://b.invalid/v1', apiKey: 'sk-r2-1234567890', modelIds: ['m1'],
    });
    const c = await gateway.saveProvider({
      name: 'C', baseUrl: 'https://c.invalid/v1', apiKey: 'sk-r3-1234567890', modelIds: ['m1'],
    });

    const reordered = await gateway.reorderProviders([c.id, 'missing', a.id]);
    assert.deepEqual(reordered.map((provider) => provider.id), [c.id, a.id, b.id]);
    assert.equal('apiKey' in reordered[0]!, false);
    assert.equal(JSON.stringify(reordered).includes('sk-r3-1234567890'), false);

    const reopened = await makeHarness(dir);
    assert.deepEqual(
      (await reopened.gateway.listProviders()).map((provider) => provider.id),
      [c.id, a.id, b.id],
    );
  });
});

test('网关路由策略：运行时切换写入 routing.json，重建网关后恢复', async () => {
  await withTempDir(async (dir) => {
    const first = await makeHarness(dir);
    assert.equal(await first.gateway.getRoutingStrategy(), 'order');
    await first.gateway.setRoutingStrategy('rotate');
    assert.equal(await first.gateway.getRoutingStrategy(), 'rotate');
    assert.equal(JSON.parse(await readFile(join(dir, 'routing.json'), 'utf8')), 'rotate');

    const second = await makeHarness(dir);
    assert.equal(await second.gateway.getRoutingStrategy(), 'rotate');
    await second.gateway.setRoutingStrategy('order');
    assert.equal(JSON.parse(await readFile(join(dir, 'routing.json'), 'utf8')), 'order');
  });
});

test('testProvider：GET /v1/models 带 Bearer key，解析模型数量', async () => {
  await withTempDir(async (dir) => {
    await withServer(
      (req, res) => {
        assert.equal(req.url, '/v1/models');
        assert.equal(req.headers.authorization, 'Bearer sk-test-provider-key');
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }, { name: 'no-id' }] }));
      },
      async (url) => {
        const { gateway } = await makeHarness(dir);
        const saved = await gateway.saveProvider({
          name: 'A',
          baseUrl: `${url}/v1///`,
          apiKey: 'sk-test-provider-key',
          modelIds: ['m1'],
        });
        const result = await gateway.testProvider(saved.id);
        assert.equal(result.providerId, saved.id);
        assert.equal(result.ok, true);
        assert.equal(result.modelCount, 2);
        assert.ok(result.latencyMs >= 0);
        assert.equal(result.error, undefined);
      },
    );
  });
});

test('testProvider：/models 结尾直接使用，401 与未知 id 返回 ok:false 而不抛错', async () => {
  await withTempDir(async (dir) => {
    await withServer(
      (req, res) => {
        assert.equal(req.url, '/models');
        req.resume();
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
      },
      async (url) => {
        const { gateway } = await makeHarness(dir);
        const saved = await gateway.saveProvider({
          name: 'A',
          baseUrl: `${url}/models/`,
          apiKey: 'bad-key',
          modelIds: ['m1'],
        });

        const failed = await gateway.testProvider(saved.id);
        assert.equal(failed.providerId, saved.id);
        assert.equal(failed.ok, false);
        assert.match(failed.error ?? '', /401/);
        assert.equal(failed.modelCount, undefined);

        const unknown = await gateway.testProvider('not-found');
        assert.equal(unknown.ok, false);
        assert.match(unknown.error ?? '', /未知的提供商/);
      },
    );
  });
});

test('testProvider：响应不是合法 models JSON 时返回错误而不是抛错', async () => {
  await withTempDir(async (dir) => {
    await withServer(
      (req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ objects: [] }));
      },
      async (url) => {
        const { gateway } = await makeHarness(dir);
        const saved = await gateway.saveProvider({
          name: 'A', baseUrl: url, apiKey: 'sk-bad-response', modelIds: ['m1'],
        });
        const result = await gateway.testProvider(saved.id);
        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /data 数组/);
      },
    );
  });
});
