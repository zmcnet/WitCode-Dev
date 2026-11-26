import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { UsageRecord } from '@witcode/protocol';
import { createUsageStore } from '../src/usage.ts';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'witcode-usage-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    at: 1000,
    providerId: 'p1',
    model: 'm1',
    inputTokens: 10,
    outputTokens: 4,
    durationMs: 120,
    ok: true,
    ...overrides,
  };
}

test('append 写一行 JSON 并自动创建目录，list 能读回', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'nested', 'usage.jsonl');
    const store = createUsageStore({ filePath });
    assert.equal(existsSync(filePath), false);

    await store.append(makeRecord());

    assert.equal(existsSync(filePath), true);
    const lines = (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), makeRecord());
    assert.deepEqual(await store.list(), [makeRecord()]);
  });
});

test('list 跳过坏行（非法 JSON、非对象、字段不全、空行）', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'usage.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify(makeRecord({ at: 3, providerId: 'a' })),
        '{not json',
        JSON.stringify({ nope: true }),
        JSON.stringify({ at: 'oops', providerId: 'b', model: 'm' }),
        '',
        JSON.stringify(makeRecord({ at: 2, providerId: 'b' })),
      ].join('\n'),
      'utf8',
    );

    const records = await createUsageStore({ filePath }).list();
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.providerId),
      ['a', 'b'],
    );
  });
});

test('list 按时间倒序并遵守 limit', async () => {
  await withTempDir(async (dir) => {
    const store = createUsageStore({ dataDir: dir });
    await store.append(makeRecord({ at: 1, providerId: 'first' }));
    await store.append(makeRecord({ at: 3, providerId: 'third' }));
    await store.append(makeRecord({ at: 2, providerId: 'second' }));

    assert.deepEqual(
      (await store.list()).map((record) => record.providerId),
      ['third', 'second', 'first'],
    );
    assert.deepEqual(
      (await store.list(2)).map((record) => record.providerId),
      ['third', 'second'],
    );
    assert.deepEqual(await store.list(0), []);
  });
});

test('summary 聚合总量与按 provider 分组（请求数倒序）', async () => {
  await withTempDir(async (dir) => {
    const store = createUsageStore({ dataDir: dir });
    await store.append(makeRecord({ providerId: 'p1', inputTokens: 10, outputTokens: 2 }));
    await store.append(makeRecord({ providerId: 'p2', inputTokens: 5, outputTokens: 3 }));
    await store.append(
      makeRecord({ providerId: 'p1', inputTokens: 7, outputTokens: 1, ok: false, error: '429' }),
    );
    await store.append(makeRecord({ providerId: 'p3', inputTokens: 1, outputTokens: 1 }));

    assert.deepEqual(await store.summary(), {
      totalRequests: 4,
      totalInputTokens: 23,
      totalOutputTokens: 7,
      byProvider: [
        { providerId: 'p1', requests: 2, inputTokens: 17, outputTokens: 3 },
        { providerId: 'p2', requests: 1, inputTokens: 5, outputTokens: 3 },
        { providerId: 'p3', requests: 1, inputTokens: 1, outputTokens: 1 },
      ],
    });
  });
});

test('append 写盘失败不抛给调用方，而是通过 onError 上报', async () => {
  await withTempDir(async (dir) => {
    const errors: unknown[] = [];
    // 目录不能作为文件追加，必然失败。
    const store = createUsageStore({ filePath: dir, onError: (error) => errors.push(error) });
    await store.append(makeRecord());
    assert.equal(errors.length, 1);
  });
});

test('默认使用 WITCODE_DATA_DIR/usage.jsonl', async () => {
  await withTempDir(async (dir) => {
    const previous = process.env.WITCODE_DATA_DIR;
    const dataDir = join(dir, 'env-data');
    process.env.WITCODE_DATA_DIR = dataDir;
    try {
      await createUsageStore().append(makeRecord());
      assert.ok(existsSync(join(dataDir, 'usage.jsonl')));
    } finally {
      if (previous === undefined) delete process.env.WITCODE_DATA_DIR;
      else process.env.WITCODE_DATA_DIR = previous;
    }
  });
});
