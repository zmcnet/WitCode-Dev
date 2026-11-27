import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ProviderInput } from '@witcode/protocol';
import {
  applyProviderInput,
  createProviderRegistry,
  defaultProvidersPath,
  providerToPublic,
} from '../src/registry.ts';
import type { StoredProvider } from '../src/types.ts';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witcode-registry-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sampleInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    name: '  OpenAI  ',
    baseUrl: '  https://api.openai.com/v1  ',
    apiKey: 'sk-abcdefghijklmnop',
    modelIds: [' gpt-4o ', '', 'gpt-4o', 'o3-mini'],
    ...overrides,
  };
}

test('增删改查与持久化：重开实例后数据仍在，删除后消失', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    const registry = createProviderRegistry({ filePath });
    assert.deepEqual(await registry.list(), []);

    const stored = applyProviderInput(sampleInput());
    await registry.save(stored);

    const found = await registry.get(stored.id);
    assert.ok(found);
    assert.deepEqual(found, stored);
    assert.equal(found.name, 'OpenAI');
    assert.equal(found.baseUrl, 'https://api.openai.com/v1');
    assert.deepEqual(found.modelIds, ['gpt-4o', 'o3-mini']);

    const updated = applyProviderInput(
      {
        id: stored.id,
        name: '  renamed  ',
        baseUrl: stored.baseUrl,
        apiKey: '',
        modelIds: ['o3-mini'],
      },
      found,
    );
    await registry.save(updated);
    const afterUpdate = await registry.get(stored.id);
    assert.ok(afterUpdate);
    assert.equal(afterUpdate.name, 'renamed');
    assert.equal(afterUpdate.apiKey, stored.apiKey);
    assert.equal(afterUpdate.createdAt, stored.createdAt);
    assert.ok(afterUpdate.updatedAt >= stored.updatedAt);

    const reopened = createProviderRegistry({ filePath });
    assert.deepEqual(await reopened.get(stored.id), afterUpdate);

    await reopened.remove(stored.id);
    assert.equal(await reopened.get(stored.id), null);
    assert.deepEqual(await createProviderRegistry({ filePath }).list(), []);
  });
});

test('原子写：文件存在且可解析，并发写不丢数据且无临时文件残留', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    const registry = createProviderRegistry({ filePath });
    const providers = Array.from({ length: 5 }, (_, index) =>
      applyProviderInput(sampleInput({ name: `p${index}`, apiKey: `key-${index}` })));

    await Promise.all(providers.map((provider) => registry.save(provider)));

    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredProvider[];
    assert.equal(parsed.length, providers.length, '写操作必须串行化');
    assert.deepEqual(
      parsed.map((item) => item.id).sort(),
      providers.map((item) => item.id).sort(),
    );
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '临时文件应在 rename 后被消费');
  });
});

test('损坏的 JSON 备份为 .bad-<时间戳> 并返回空列表', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    await fs.writeFile(filePath, '{ broken json', 'utf8');

    const registry = createProviderRegistry({ filePath });
    assert.deepEqual(await registry.list(), []);

    const names = await fs.readdir(dir);
    assert.equal(names.some((name) => /^providers\.json\.bad-\d+$/.test(name)), true);
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
    assert.deepEqual(await createProviderRegistry({ filePath }).list(), []);
  });
});

test('跳过字段缺失或类型错误的条目，不影响合法条目', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    const good = applyProviderInput(sampleInput());
    await fs.writeFile(
      filePath,
      JSON.stringify([
        null,
        { id: 'missing-fields' },
        { ...good, enabled: 'yes' },
        { ...good, modelIds: 'gpt-4o' },
        good,
      ]),
      'utf8',
    );

    const list = await createProviderRegistry({ filePath }).list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], good);
  });
});

test('providerToPublic 不返回明文 key，并按长度生成提示', () => {
  const base = applyProviderInput(sampleInput({ apiKey: '' }));

  const empty = providerToPublic({ ...base, apiKey: '' });
  assert.equal(empty.hasApiKey, false);
  assert.equal(empty.apiKeyHint, '未设置');

  const short = providerToPublic({ ...base, apiKey: 'short' });
  assert.equal(short.hasApiKey, true);
  assert.equal(short.apiKeyHint, '已设置');

  const twelve = providerToPublic({ ...base, apiKey: 'abcdefghijkl' });
  assert.equal(twelve.apiKeyHint, 'abcd…ijkl');

  const long = providerToPublic({ ...base, apiKey: 'abcd12345678wxyz' });
  assert.equal(long.apiKeyHint, 'abcd…wxyz');
  assert.equal(long.hasApiKey, true);

  const secret = 'sk-very-secret-value-1234567890';
  const publicView = providerToPublic({ ...base, apiKey: secret });
  assert.equal('apiKey' in publicView, false);
  assert.equal(JSON.stringify(publicView).includes(secret), false);
});

test('applyProviderInput 合并：空 key 保留、id 复用、modelIds 去重、createdAt 保留', () => {
  const existing = applyProviderInput(sampleInput());
  const merged = applyProviderInput(
    {
      id: existing.id,
      name: '  新名字  ',
      baseUrl: '  https://example.com/v1  ',
      apiKey: undefined,
      modelIds: [' b ', 'a', 'b', '', '  ', 'a'],
      enabled: false,
    },
    existing,
  );

  assert.equal(merged.id, existing.id, '传入 id 必须复用');
  assert.equal(merged.apiKey, existing.apiKey, '空 key 必须保留旧值');
  assert.equal(merged.createdAt, existing.createdAt);
  assert.deepEqual(merged.modelIds, ['b', 'a']);
  assert.equal(merged.name, '新名字');
  assert.equal(merged.baseUrl, 'https://example.com/v1');
  assert.equal(merged.enabled, false);
  assert.ok(merged.updatedAt >= existing.updatedAt);

  const blankKey = applyProviderInput(sampleInput({ apiKey: '' }), existing);
  assert.equal(blankKey.apiKey, existing.apiKey);

  const fresh = applyProviderInput(sampleInput({ apiKey: undefined }));
  assert.match(
    fresh.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(fresh.apiKey, '');
  assert.equal(fresh.enabled, true);
});

test('defaultProvidersPath 遵守 dataDir 与 WITCODE_DATA_DIR 优先级', () => {
  assert.equal(defaultProvidersPath('/tmp/witcode'), path.join('/tmp/witcode', 'providers.json'));

  const original = process.env.WITCODE_DATA_DIR;
  try {
    process.env.WITCODE_DATA_DIR = path.join(os.tmpdir(), 'witcode-env');
    assert.equal(defaultProvidersPath(), path.join(os.tmpdir(), 'witcode-env', 'providers.json'));
    assert.equal(defaultProvidersPath('/explicit'), path.join('/explicit', 'providers.json'));
  } finally {
    if (original === undefined) delete process.env.WITCODE_DATA_DIR;
    else process.env.WITCODE_DATA_DIR = original;
  }
});

test('contextWindow：默认 1M，低于 1M 拒绝保存', () => {
  assert.equal(applyProviderInput(sampleInput()).contextWindow, 1_000_000);
  assert.equal(
    applyProviderInput(sampleInput({ contextWindow: 2_000_000 })).contextWindow,
    2_000_000,
  );
  assert.throws(
    () => applyProviderInput(sampleInput({ contextWindow: 128_000 })),
    /上下文窗口必须 ≥ 1000000 tokens/,
  );
  assert.throws(
    () => applyProviderInput(sampleInput({ contextWindow: Number.NaN })),
    /上下文窗口必须/,
  );
});

test('旧 providers.json 缺少 contextWindow 时按 1M 补齐', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    const legacy = {
      id: 'legacy',
      name: 'Legacy',
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'sk-legacy',
      modelIds: ['m1'],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    await fs.writeFile(filePath, JSON.stringify([legacy]), 'utf8');

    const registry = createProviderRegistry({ filePath });
    const [provider] = await registry.list();
    assert.equal(provider?.contextWindow, 1_000_000);
  });
});

test('modelSettings 清洗：裁剪模型、trim、布尔校验、输出上限与回落', () => {
  const stored = applyProviderInput({
    ...sampleInput(),
    modelIds: ['m1', 'm2'],
    modelSettings: {
      m1: {
        displayName: '  GPT-4o  ',
        contextWindow: 2_000_000,
        maxOutputTokens: 500_000,
        enabled: 'yes' as unknown as boolean,
      },
      m2: { displayName: '   ', enabled: false },
      removed: { displayName: 'not-in-modelIds' },
    },
  });

  assert.deepEqual(stored.modelSettings, {
    m1: { displayName: 'GPT-4o', contextWindow: 2_000_000, maxOutputTokens: 128_000 },
    m2: { enabled: false },
  });
  assert.deepEqual(providerToPublic(stored).modelSettings, stored.modelSettings);
  assert.deepEqual(applyProviderInput({ ...sampleInput(), modelIds: ['m1'] }).modelSettings, {});
});

test('modelSettings 编辑合并：未提及字段沿用旧值，移除模型时清理', () => {
  const existing = applyProviderInput({
    ...sampleInput(),
    modelIds: ['m1', 'm2'],
    modelSettings: {
      m1: { displayName: 'First', enabled: false },
      m2: { contextWindow: 3_000_000 },
    },
  });

  const merged = applyProviderInput(
    {
      ...sampleInput(),
      id: existing.id,
      modelIds: ['m1'],
      modelSettings: { m1: { maxOutputTokens: 4_000 } },
    },
    existing,
  );
  assert.deepEqual(merged.modelSettings, {
    m1: { displayName: 'First', enabled: false, maxOutputTokens: 4_000 },
  });

  const untouched = applyProviderInput(
    { ...sampleInput(), id: existing.id, modelIds: ['m1', 'm2'] },
    existing,
  );
  assert.deepEqual(untouched.modelSettings, existing.modelSettings);
});

test('modelSettings 的 contextWindow 低于 1M 时拒绝保存并报错', () => {
  assert.throws(
    () => applyProviderInput({
      ...sampleInput(),
      modelIds: ['m1'],
      modelSettings: { m1: { contextWindow: 128_000 } },
    }),
    /模型 m1 的上下文窗口必须 ≥ 1000000 tokens/,
  );
});

test('旧 providers.json 缺 modelSettings 补空对象，脏值被丢弃', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    const good = applyProviderInput(sampleInput());
    await fs.writeFile(
      filePath,
      JSON.stringify([
        {
          ...good,
          id: 'legacy',
          modelSettings: undefined,
        },
        {
          ...good,
          id: 'dirty',
          modelSettings: {
            m1: {
              displayName: '  kept  ',
              contextWindow: 900_000,
              maxOutputTokens: 999_000,
              enabled: 'yes',
            },
            m2: 'not-an-object',
          },
        },
      ]),
      'utf8',
    );

    const list = await createProviderRegistry({ filePath }).list();
    assert.equal(list.length, 2);
    assert.deepEqual(list[0]?.modelSettings, {});
    assert.deepEqual(list[1]?.modelSettings, {
      m1: { displayName: 'kept', maxOutputTokens: 128_000 },
    });
  });
});

test('reorder：指定 id 在前，未列出的保持相对顺序，未知/重复 id 忽略且原子落盘', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'providers.json');
    const registry = createProviderRegistry({ filePath });
    const a = applyProviderInput(sampleInput({ name: 'A' }));
    const b = applyProviderInput(sampleInput({ name: 'B' }));
    const c = applyProviderInput(sampleInput({ name: 'C' }));
    await Promise.all([a, b, c].map((provider) => registry.save(provider)));

    const ordered = await registry.reorder([c.id, 'missing', a.id, c.id]);
    assert.deepEqual(ordered.map((provider) => provider.id), [c.id, a.id, b.id]);
    assert.deepEqual((await registry.list()).map((provider) => provider.id), [c.id, a.id, b.id]);
    assert.deepEqual(
      (await createProviderRegistry({ filePath }).list()).map((provider) => provider.id),
      [c.id, a.id, b.id],
    );
    assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  });
});
