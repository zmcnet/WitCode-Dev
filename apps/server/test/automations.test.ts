import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AutomationInput, AutomationPublic } from '@witcode/protocol';
import { createAutomationStore, nextRunAt } from '../src/automations.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-automations-'));
}

function input(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    id: 'a1',
    name: '每日构建',
    prompt: '执行构建',
    schedule: 'every 15m',
    enabled: true,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待超时');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('nextRunAt：every 语法解析间隔，大小写与空白不敏感', () => {
  assert.equal(nextRunAt('every 15m', 0), 15 * 60_000);
  assert.equal(nextRunAt('EVERY 2H', 0), 2 * 3_600_000);
  assert.equal(nextRunAt('  every   90 m  ', 1_000), 1_000 + 90 * 60_000);
});

test('nextRunAt：daily 当天未到取今日，已过或正好到点取明天', () => {
  const before = new Date(2026, 0, 2, 9, 0, 0).getTime();
  assert.equal(nextRunAt('daily 09:30', before), new Date(2026, 0, 2, 9, 30, 0).getTime());

  const after = new Date(2026, 0, 2, 10, 0, 0).getTime();
  assert.equal(nextRunAt('DAILY 09:30', after), new Date(2026, 0, 3, 9, 30, 0).getTime());

  const exact = new Date(2026, 0, 2, 9, 30, 0).getTime();
  assert.equal(nextRunAt('daily 9:30', exact), new Date(2026, 0, 3, 9, 30, 0).getTime());
});

test('nextRunAt：非法语法返回 null，save 拒绝并报错', async (t) => {
  for (const bad of [
    'weekly',
    'every 15x',
    'every 0m',
    'daily 25:00',
    'daily 09:60',
    'daily 09',
    'every 15m extra',
    '',
  ]) {
    assert.equal(nextRunAt(bad, 0), null, bad);
  }

  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createAutomationStore({ dataDir: dir, run: async () => ({ ok: true }) });
  await assert.rejects(store.save(input({ schedule: 'weekly' })), /schedule/);
  assert.deepEqual(store.list(), []);
});

test('CRUD：save 覆盖同 id、remove 幂等，落盘不含 nextRun 且可恢复', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clock = 1_000;
  const store = await createAutomationStore({
    dataDir: dir,
    now: () => clock,
    run: async () => ({ ok: true }),
  });

  const first = await store.save(input());
  assert.equal(first.length, 1);
  assert.equal(first[0]?.id, 'a1');
  assert.equal(first[0]?.nextRun, clock + 15 * 60_000);

  const second = await store.save(input({ id: 'a2', name: '第二个', schedule: 'daily 09:30' }));
  assert.equal(second.length, 2);
  assert.deepEqual(second, store.list());

  const file = path.join(dir, 'automations.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>[];
  assert.equal(raw.length, 2);
  for (const item of raw) {
    assert.ok(!Object.prototype.hasOwnProperty.call(item, 'nextRun'));
  }

  const updated = await store.save(input({ name: '改名' }));
  assert.equal(updated.length, 2);
  assert.equal(updated[0]?.name, '改名');

  const removed = await store.remove('a1');
  assert.deepEqual(
    removed.map((item) => item.id),
    ['a2'],
  );
  assert.deepEqual(await store.remove('a1'), removed);
  assert.deepEqual(await store.remove('不存在'), removed);
  assert.deepEqual(store.list(), removed);

  const reopened = await createAutomationStore({
    dataDir: dir,
    now: () => clock,
    run: async () => ({ ok: true }),
  });
  assert.deepEqual(reopened.list(), removed);
});

test('start：到期执行，禁用项不执行，执行后续期', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const startClock = new Date(2026, 0, 2, 8, 0, 0).getTime();
  let clock = startClock;
  const seen: AutomationPublic[] = [];
  const store = await createAutomationStore({
    dataDir: dir,
    tickMs: 10,
    now: () => clock,
    run: async (automation) => {
      seen.push(automation);
      return { ok: true };
    },
  });
  await store.save(input({ id: 'on', schedule: 'every 1m' }));
  await store.save(input({ id: 'off', schedule: 'every 1m', enabled: false }));

  clock = startClock + 60_000 + 1;
  t.after(() => store.stop());
  store.start();
  await waitFor(() => seen.length >= 1);

  assert.equal(seen[0]?.id, 'on');
  assert.equal(seen[0]?.nextRun, startClock + 60_000);
  const on = store.list().find((item) => item.id === 'on');
  assert.equal(on?.lastStatus, 'ok');
  assert.equal(on?.lastRun, clock);
  assert.equal(on?.nextRun, clock + 60_000);

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(seen.length, 1);
});

test('runNow：忽略 enabled，执行中再次调用不重入', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let calls = 0;
  let release: (() => void) | undefined;
  const store = await createAutomationStore({
    dataDir: dir,
    run: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true };
    },
  });
  await store.save(input({ enabled: false }));

  const first = store.runNow('a1');
  const second = store.runNow('a1');
  await waitFor(() => calls === 1);
  assert.equal(calls, 1);
  release?.();
  await Promise.all([first, second]);
  assert.equal(calls, 1);

  const list = await store.runNow('a1');
  assert.equal(calls, 2);
  assert.equal(list[0]?.lastStatus, 'ok');
});

test('失败记录：ok=false 与异常写入 lastError，并持久化到磁盘', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let clock = 10_000;
  let mode: 'error' | 'throw' | 'ok' = 'error';
  const store = await createAutomationStore({
    dataDir: dir,
    now: () => clock,
    run: async () => {
      if (mode === 'error') return { ok: false, error: 'boom' };
      if (mode === 'throw') throw new Error('crash');
      return { ok: true };
    },
  });
  await store.save(input());

  await store.runNow('a1');
  assert.equal(store.list()[0]?.lastStatus, 'error');
  assert.equal(store.list()[0]?.lastError, 'boom');
  assert.equal(store.list()[0]?.lastRun, clock);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'automations.json'), 'utf8')) as Record<
    string,
    unknown
  >[];
  assert.equal(raw[0]?.lastStatus, 'error');
  assert.equal(raw[0]?.lastError, 'boom');
  assert.ok(!Object.prototype.hasOwnProperty.call(raw[0] ?? {}, 'nextRun'));

  mode = 'throw';
  clock += 1_000;
  await store.runNow('a1');
  assert.equal(store.list()[0]?.lastStatus, 'error');
  assert.equal(store.list()[0]?.lastError, 'crash');

  mode = 'ok';
  clock += 1_000;
  await store.runNow('a1');
  assert.equal(store.list()[0]?.lastStatus, 'ok');
  assert.equal(store.list()[0]?.lastError, undefined);

  const reopened = await createAutomationStore({
    dataDir: dir,
    now: () => clock,
    run: async () => ({ ok: true }),
  });
  assert.equal(reopened.list()[0]?.lastStatus, 'ok');
  assert.equal(reopened.list()[0]?.lastRun, clock);
});

test('stop：清理定时器后不再执行，可再次 start', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let clock = 0;
  let calls = 0;
  const store = await createAutomationStore({
    dataDir: dir,
    tickMs: 10,
    now: () => clock,
    run: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  await store.save(input({ id: 'a', schedule: 'every 1m' }));

  t.after(() => store.stop());
  clock = 60_000;
  store.start();
  await waitFor(() => calls === 1);

  store.stop();
  clock = 120_000;
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1);

  store.start();
  await waitFor(() => calls === 2);
  store.stop();
});
