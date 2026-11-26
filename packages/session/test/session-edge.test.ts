import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionStore } from '@witcode/protocol';
import { createSqliteSessionStore } from '../src/index.ts';

function storeInTempDir(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'witcode-session-edge-'));
  // Windows 下 SQLite 仍持有文件句柄，清理失败不影响测试正确性。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  return createSqliteSessionStore({ dbPath: join(dir, 'witcode.db') });
}

test('未知 id：append/rename 报错，remove 是幂等的', async () => {
  const store = storeInTempDir();

  await assert.rejects(store.append('nope', { role: 'user', content: 'hi' }), /Session not found: nope/);
  await assert.rejects(store.rename('nope', 'title'), /Session not found: nope/);
  await assert.doesNotReject(store.remove('nope'));
  assert.deepEqual(await store.list(), []);
});

test('assistant 消息的 toolCalls 原样往返，空标题被保留', async () => {
  const store = storeInTempDir();
  const session = await store.create('');
  const toolCalls = [{ id: 'call-9', name: 'grep', input: { pattern: 'x' } }];

  await store.append(session.id, {
    role: 'assistant',
    content: '',
    toolCalls,
  });

  const got = await store.get(session.id);
  assert.equal(got?.title, '');
  assert.deepEqual(got?.messages, [{ role: 'assistant', content: '', toolCalls }]);
});
