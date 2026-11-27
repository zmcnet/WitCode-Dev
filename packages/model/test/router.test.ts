import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ModelChunk,
  ModelRequest,
  ModelService,
  UsageRecord,
} from '@witcode/protocol';
import { createModelRouter } from '../src/router.ts';
import type {
  ModelRouter,
  ProviderRegistry,
  RouterOptions,
  RoutingStrategy,
  StoredProvider,
  UsageStore,
} from '../src/types.ts';

interface Harness {
  router: ModelRouter;
  /** createProvider 的实际调用顺序，形如 "p1:m1"。 */
  calls: string[];
  usages: UsageRecord[];
  services: Map<string, ModelService>;
}

function makeProvider(
  id: string,
  modelIds: string[] = ['m1'],
  enabled = true,
  contextWindow = 1_000_000,
): StoredProvider {
  return {
    id,
    name: id,
    baseUrl: 'http://model.invalid/v1',
    apiKey: 'test-key',
    modelIds,
    contextWindow,
    modelSettings: {},
    enabled,
    createdAt: 0,
    updatedAt: 0,
  };
}

function fakeService(id: string, chunks: ModelChunk[]): ModelService {
  return {
    id,
    async *stream() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeHarness(
  providers: StoredProvider[],
  strategy: RoutingStrategy | undefined,
  extra: Partial<RouterOptions> = {},
): Harness {
  const registry: ProviderRegistry = {
    async list() {
      return providers.slice();
    },
    async get(id) {
      return providers.find((provider) => provider.id === id) ?? null;
    },
    async save() {},
    async remove() {},
    async reorder() {
      return providers.slice();
    },
  };
  const usages: UsageRecord[] = [];
  const usage: UsageStore = {
    async append(record) {
      usages.push(record);
    },
    async list() {
      return usages.slice().reverse();
    },
    async summary() {
      throw new Error('not used in router tests');
    },
  };
  const calls: string[] = [];
  const services = new Map<string, ModelService>();

  const options: RouterOptions = {
    registry,
    usage,
    strategy,
    now: () => 1000,
    createProvider(provider, model) {
      const key = `${provider.id}:${model}`;
      calls.push(key);
      const service = services.get(key);
      if (!service) throw new Error(`no fake service for ${key}`);
      return service;
    },
    ...extra,
  };

  return { router: createModelRouter(options), calls, usages, services };
}

const request: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };

async function collect(
  router: ModelRouter,
  signal?: AbortSignal,
  req: ModelRequest = request,
): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of router.stream(req, signal)) chunks.push(chunk);
  return chunks;
}

test('order 按 registry 顺序用首个模型，成功后停止', async () => {
  const harness = makeHarness(
    [makeProvider('p1', ['m1', 'm2']), makeProvider('p2')],
    'order',
  );
  harness.services.set(
    'p1:m1',
    fakeService('p1', [
      { type: 'text', text: 'a' },
      { type: 'done', usage: { input: 1, output: 2 } },
    ]),
  );
  harness.services.set(
    'p2:m1',
    fakeService('p2', [{ type: 'text', text: 'should not appear' }, { type: 'done' }]),
  );

  const chunks = await collect(harness.router);
  assert.deepEqual(chunks, [
    { type: 'text', text: 'a' },
    { type: 'done', usage: { input: 1, output: 2 } },
  ]);
  assert.deepEqual(harness.calls, ['p1:m1'], '必须使用 modelIds[0] 且不继续后续 provider');
  assert.equal(harness.usages.length, 1);
});

test('rotate 从上次成功的下一个开始轮转', async () => {
  const harness = makeHarness(
    [makeProvider('p1'), makeProvider('p2'), makeProvider('p3')],
    'rotate',
  );
  for (const id of ['p1', 'p2', 'p3']) {
    harness.services.set(
      `${id}:m1`,
      fakeService(id, [{ type: 'text', text: id }, { type: 'done' }]),
    );
  }

  for (const expected of ['p1', 'p2', 'p3', 'p1']) {
    const chunks = await collect(harness.router);
    assert.deepEqual(chunks[0], { type: 'text', text: expected });
  }
  assert.deepEqual(harness.calls, ['p1:m1', 'p2:m1', 'p3:m1', 'p1:m1']);
});

test('输出前的错误切到备用并成功，两次尝试各写一条 usage', async () => {
  const harness = makeHarness([makeProvider('p1'), makeProvider('p2')], 'order');
  harness.services.set('p1:m1', fakeService('p1', [{ type: 'error', message: '429 rate limited' }]));
  harness.services.set(
    'p2:m1',
    fakeService('p2', [
      { type: 'text', text: 'ok' },
      { type: 'done', usage: { input: 7, output: 3 } },
    ]),
  );

  const chunks = await collect(harness.router);
  assert.deepEqual(chunks, [
    { type: 'text', text: 'ok' },
    { type: 'done', usage: { input: 7, output: 3 } },
  ]);
  assert.deepEqual(harness.calls, ['p1:m1', 'p2:m1']);
  assert.deepEqual(harness.usages, [
    {
      at: 1000,
      providerId: 'p1',
      model: 'm1',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      ok: false,
      error: '429 rate limited',
    },
    {
      at: 1000,
      providerId: 'p2',
      model: 'm1',
      inputTokens: 7,
      outputTokens: 3,
      durationMs: 0,
      ok: true,
    },
  ]);
});

test('已产出文本后失败不切换，错误原样透传', async () => {
  const harness = makeHarness([makeProvider('p1'), makeProvider('p2')], 'order');
  harness.services.set(
    'p1:m1',
    fakeService('p1', [{ type: 'text', text: 'partial' }, { type: 'error', message: 'boom' }]),
  );
  harness.services.set(
    'p2:m1',
    fakeService('p2', [{ type: 'text', text: 'duplicate' }, { type: 'done' }]),
  );

  const chunks = await collect(harness.router);
  assert.deepEqual(chunks, [
    { type: 'text', text: 'partial' },
    { type: 'error', message: 'boom' },
  ]);
  assert.deepEqual(harness.calls, ['p1:m1'], '不得切换到第二个 provider');
  assert.equal(harness.usages.length, 1);
  assert.equal(harness.usages[0]?.ok, false);
  assert.equal(harness.usages[0]?.error, 'boom');
});

test('全部候选失败产出最后一个错误，且每次尝试都写 usage', async () => {
  const harness = makeHarness([makeProvider('p1'), makeProvider('p2')], 'order');
  harness.services.set('p1:m1', fakeService('p1', [{ type: 'error', message: 'first error' }]));
  harness.services.set('p2:m1', fakeService('p2', [{ type: 'error', message: 'last error' }]));

  const chunks = await collect(harness.router);
  assert.deepEqual(chunks, [{ type: 'error', message: 'last error' }]);
  assert.deepEqual(harness.calls, ['p1:m1', 'p2:m1']);
  assert.deepEqual(
    harness.usages.map((record) => [record.providerId, record.ok, record.error]),
    [
      ['p1', false, 'first error'],
      ['p2', false, 'last error'],
    ],
  );
});

test('第三个候选成功时保留三次尝试的 usage', async () => {
  const harness = makeHarness(
    [makeProvider('p1'), makeProvider('p2'), makeProvider('p3')],
    'order',
  );
  harness.services.set('p1:m1', fakeService('p1', [{ type: 'error', message: '429' }]));
  harness.services.set('p2:m1', fakeService('p2', [{ type: 'error', message: '500' }]));
  harness.services.set('p3:m1', fakeService('p3', [{ type: 'done', usage: { input: 9, output: 1 } }]));

  const chunks = await collect(harness.router);
  assert.deepEqual(chunks, [{ type: 'done', usage: { input: 9, output: 1 } }]);
  assert.equal(harness.usages.length, 3);
  assert.deepEqual(
    harness.usages.map((record) => [record.providerId, record.ok, record.inputTokens]),
    [
      ['p1', false, 0],
      ['p2', false, 0],
      ['p3', true, 9],
    ],
  );
});

test('selection 优先，按指定模型创建且失败不切换', async () => {
  const harness = makeHarness([makeProvider('p1'), makeProvider('p2')], 'order');
  harness.services.set(
    'p1:m1',
    fakeService('p1', [{ type: 'text', text: 'should not appear' }, { type: 'done' }]),
  );
  harness.services.set('p2:special', fakeService('p2:special', [{ type: 'error', message: 'denied' }]));

  const chunks = await collect(harness.router, undefined, {
    ...request,
    selection: { providerId: 'p2', model: 'special' },
  });
  assert.deepEqual(chunks, [{ type: 'error', message: 'denied' }]);
  assert.deepEqual(harness.calls, ['p2:special'], '尊重用户选择，失败也不切换');
  assert.equal(harness.usages.length, 1);
  assert.equal(harness.usages[0]?.model, 'special');
});

test('signal 已取消时直接返回，不写失败记录也不切换', async () => {
  const harness = makeHarness([makeProvider('p1'), makeProvider('p2')], 'order');
  harness.services.set('p1:m1', fakeService('p1', [{ type: 'error', message: 'boom' }]));
  harness.services.set(
    'p2:m1',
    fakeService('p2', [{ type: 'text', text: 'should not appear' }, { type: 'done' }]),
  );
  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(await collect(harness.router, controller.signal), []);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.usages, []);
});

test('流中途 abort 不写 usage、不透传后续错误', async () => {
  const controller = new AbortController();
  const harness = makeHarness([makeProvider('p1'), makeProvider('p2')], 'order');
  harness.services.set('p1:m1', {
    id: 'p1',
    async *stream() {
      yield { type: 'text', text: 'partial' };
      controller.abort();
      yield { type: 'error', message: 'after abort' };
    },
  });
  harness.services.set(
    'p2:m1',
    fakeService('p2', [{ type: 'text', text: 'should not appear' }, { type: 'done' }]),
  );

  const chunks = await collect(harness.router, controller.signal);
  assert.deepEqual(chunks, [{ type: 'text', text: 'partial' }]);
  assert.deepEqual(harness.calls, ['p1:m1']);
  assert.deepEqual(harness.usages, []);
});

test('没有可用 provider 时用 fallback，没有 fallback 则产出 error', async () => {
  const fallback = fakeService('echo', [{ type: 'text', text: 'hi' }, { type: 'done' }]);
  const withFallback = makeHarness([makeProvider('p1', ['m1'], false)], 'order', { fallback });
  assert.deepEqual(await collect(withFallback.router), [
    { type: 'text', text: 'hi' },
    { type: 'done' },
  ]);
  assert.deepEqual(withFallback.calls, []);
  assert.equal(withFallback.usages.length, 1);
  assert.equal(withFallback.usages[0]?.providerId, 'echo');

  const withoutFallback = makeHarness([makeProvider('p1', ['m1'], false)], 'order');
  const chunks = await collect(withoutFallback.router);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.type, 'error');
  assert.deepEqual(withoutFallback.calls, []);
  assert.deepEqual(withoutFallback.usages, []);
});

test('selection 内存状态与文件持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'witcode-router-'));
  try {
    const file = join(dir, 'nested', 'selection.json');
    const providers = [makeProvider('p1'), makeProvider('p2')];
    const harness = makeHarness(providers, 'order', { selectionFile: file });

    assert.equal(harness.router.id, 'model-router');
    assert.equal(harness.router.getSelection(), null);

    const selected = { providerId: 'p2', model: 'special' };
    await harness.router.setSelection(selected);
    assert.deepEqual(harness.router.getSelection(), selected);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), selected);

    const reloaded = makeHarness(providers, 'order', { selectionFile: file });
    assert.deepEqual(reloaded.router.getSelection(), selected);

    await harness.router.setSelection(null);
    assert.equal(harness.router.getSelection(), null);
    await assert.rejects(readFile(file, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setSelection 拒绝窗口不足 1M 的 provider', async () => {
  const providers = [
    makeProvider('small', ['m1'], true, 128_000),
    makeProvider('big', ['m2'], true, 1_000_000),
  ];
  const harness = makeHarness(providers, 'order');

  await assert.rejects(
    harness.router.setSelection({ providerId: 'small', model: 'm1' }),
    /上下文窗口不足 1000000 tokens/,
  );
  assert.equal(harness.router.getSelection(), null);

  await harness.router.setSelection({ providerId: 'big', model: 'm2' });
  assert.deepEqual(harness.router.getSelection(), { providerId: 'big', model: 'm2' });

  await assert.rejects(
    harness.router.setSelection({ providerId: 'missing', model: 'm1' }),
    /未知的提供商/,
  );
});

test('自动路由跳过 disabled 模型，整 provider 全禁用时一并跳过', async () => {
  const p1 = makeProvider('p1', ['off', 'on']);
  p1.modelSettings = { off: { enabled: false } };
  const p2 = makeProvider('p2', ['off']);
  p2.modelSettings = { off: { enabled: false } };
  const harness = makeHarness([p1, p2, makeProvider('p3')], 'order');
  harness.services.set(
    'p1:on',
    fakeService('p1', [{ type: 'text', text: 'from p1' }, { type: 'done' }]),
  );
  harness.services.set(
    'p3:m1',
    fakeService('p3', [{ type: 'text', text: 'from p3' }, { type: 'done' }]),
  );

  assert.deepEqual(await collect(harness.router), [
    { type: 'text', text: 'from p1' },
    { type: 'done' },
  ]);
  assert.deepEqual(harness.calls, ['p1:on'], '不得选中 off，也不得尝试全禁用的 p2');

  harness.calls.length = 0;
  harness.services.set('p1:on', fakeService('p1', [{ type: 'error', message: '429' }]));
  assert.deepEqual(await collect(harness.router), [
    { type: 'text', text: 'from p3' },
    { type: 'done' },
  ]);
  assert.deepEqual(harness.calls, ['p1:on', 'p3:m1'], 'p2 必须被完全跳过');
});

test('setSelection 拒绝禁用模型，但允许同 provider 的其它模型', async () => {
  const provider = makeProvider('p1', ['off', 'on']);
  provider.modelSettings = { off: { enabled: false } };
  const harness = makeHarness([provider], 'order');

  await assert.rejects(
    harness.router.setSelection({ providerId: 'p1', model: 'off' }),
    /模型已禁用：p1\/off/,
  );
  assert.equal(harness.router.getSelection(), null);

  await harness.router.setSelection({ providerId: 'p1', model: 'on' });
  assert.deepEqual(harness.router.getSelection(), { providerId: 'p1', model: 'on' });
});

test('路由策略可运行时切换并持久化，重启后恢复且 rotate 行为不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'witcode-strategy-'));
  try {
    const file = join(dir, 'routing.json');
    const providers = [makeProvider('p1'), makeProvider('p2'), makeProvider('p3')];
    const registerServices = (harness: Harness): void => {
      for (const id of ['p1', 'p2', 'p3']) {
        harness.services.set(
          `${id}:m1`,
          fakeService(id, [{ type: 'text', text: id }, { type: 'done' }]),
        );
      }
    };

    const first = makeHarness(providers, 'order', { strategyFile: file });
    assert.equal(first.router.getStrategy(), 'order');
    registerServices(first);
    assert.deepEqual((await collect(first.router))[0], { type: 'text', text: 'p1' });

    await first.router.setStrategy('rotate');
    assert.equal(first.router.getStrategy(), 'rotate');
    assert.equal(JSON.parse(await readFile(file, 'utf8')), 'rotate');
    await assert.rejects(
      first.router.setStrategy('random' as RoutingStrategy),
      /未知的路由策略/,
    );
    assert.equal(first.router.getStrategy(), 'rotate');

    const second = makeHarness(providers, 'order', { strategyFile: file });
    assert.equal(second.router.getStrategy(), 'rotate', '重启后必须从 routing.json 恢复');
    registerServices(second);
    const firstTexts = [(await collect(second.router))[0], (await collect(second.router))[0]];
    assert.deepEqual(firstTexts, [
      { type: 'text', text: 'p1' },
      { type: 'text', text: 'p2' },
    ]);

    await second.router.setStrategy('order');
    assert.equal(second.router.getStrategy(), 'order');
    assert.deepEqual((await collect(second.router))[0], { type: 'text', text: 'p1' });
    assert.equal(JSON.parse(await readFile(file, 'utf8')), 'order');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
