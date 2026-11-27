import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import type { SessionStore } from '@witcode/protocol';
import { createSqliteSessionStore } from '../src/index.ts';

const tempDirs: string[] = [];

function storeIn(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'witcode-session-search-'));
  tempDirs.push(dir);
  return createSqliteSessionStore({ dbPath: join(dir, 'witcode.db') });
}

afterEach(() => {
  // Windows 下 SQLite 仍持有句柄，清理失败无妨（目录位于系统临时区）。
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('search 命中消息，返回标题/时间/带省略号的片段，且大小写不敏感', async () => {
  const store = storeIn();
  const session = await store.create('搜索标题');
  await store.append(session.id, { role: 'user', content: 'please find the NEEDLE in this text' });

  const hits = await store.search('needle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.sessionId, session.id);
  assert.equal(hits[0]?.title, '搜索标题');
  assert.equal(hits[0]?.updatedAt, (await store.get(session.id))?.updatedAt);
  assert.equal(hits[0]?.snippet, '…please find the NEEDLE in this text…');

  // LIKE 默认 ASCII 大小写不敏感。
  assert.deepEqual(
    (await store.search('NEEDLE')).map((hit) => hit.sessionId),
    [session.id],
  );
});

test('search 同一会话只返回一条命中，取该会话最新一条匹配消息', async () => {
  const store = storeIn();
  const session = await store.create('去重');
  await store.append(session.id, { role: 'user', content: 'old MATCH here' });
  await store.append(session.id, { role: 'assistant', content: 'new MATCH here' });
  await store.append(session.id, { role: 'assistant', content: '无关的结尾' });

  const hits = await store.search('match');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.sessionId, session.id);
  assert.equal(hits[0]?.snippet, '…new MATCH here…');
});

test('search 多会话去重并按 updatedAt 倒序', async () => {
  const store = storeIn();
  const first = await store.create('first');
  const second = await store.create('second');
  const third = await store.create('third');
  await store.append(first.id, { role: 'user', content: 'MATCH one' });
  await store.append(first.id, { role: 'user', content: 'MATCH two' });
  await store.append(second.id, { role: 'user', content: 'MATCH three' });
  // third 不含命中词

  const hits = await store.search('MATCH');
  assert.deepEqual(
    hits.map((hit) => hit.sessionId),
    [second.id, first.id],
  );
  assert.equal(new Set(hits.map((hit) => hit.sessionId)).size, hits.length);
  assert.deepEqual(
    hits.map((hit) => hit.title),
    ['second', 'first'],
  );
});

test('search 默认返回 10 条，limit 限制在 1..20', async () => {
  const store = storeIn();
  const sessions = [];
  for (let i = 0; i < 21; i += 1) {
    const session = await store.create(`s${i}`);
    await store.append(session.id, { role: 'user', content: `MATCH ${i}` });
    sessions.push(session);
  }

  assert.equal((await store.search('MATCH')).length, 10);
  assert.equal((await store.search('MATCH', 3)).length, 3);
  assert.equal((await store.search('MATCH', 0)).length, 1);
  assert.equal((await store.search('MATCH', -5)).length, 1);
  assert.equal((await store.search('MATCH', 1.9)).length, 1);
  assert.equal((await store.search('MATCH', 999)).length, 20);
  assert.deepEqual(
    (await store.search('MATCH', 2)).map((hit) => hit.title),
    ['s20', 's19'],
  );
  // 确保数组非空，防止上面循环被优化掉。
  assert.equal(sessions.length, 21);
});

test('search 转义 %/_/\\，只匹配字面量', async () => {
  const store = storeIn();
  const literal = await store.create('literal');
  await store.append(literal.id, { role: 'user', content: '价格 100% off, code foo_bar at C:\\temp' });
  const wild = await store.create('wild');
  await store.append(wild.id, { role: 'user', content: '价格 100X off, code fooxbar at C:xtemp' });

  for (const query of ['100%', 'foo_bar', '\\temp', '%', '_']) {
    const hits = await store.search(query);
    assert.deepEqual(hits.map((hit) => hit.sessionId), [literal.id], `query: ${query}`);
  }
  assert.deepEqual(
    (await store.search('100% off')).map((hit) => hit.sessionId),
    [literal.id],
  );
});

test('search 空白 query 返回空数组', async () => {
  const store = storeIn();
  const session = await store.create('有内容');
  await store.append(session.id, { role: 'user', content: 'MATCH' });

  assert.deepEqual(await store.search(''), []);
  assert.deepEqual(await store.search('   '), []);
  assert.deepEqual(await store.search('\n\t '), []);
  assert.equal((await store.search('  MATCH  ')).length, 1);
});

test('search 片段取命中前后各 60 字符并折叠空白', async () => {
  const store = storeIn();
  const session = await store.create('片段');
  const content = `${'A'.repeat(70)}NEEDLE${'B'.repeat(70)}`;
  await store.append(session.id, { role: 'user', content });

  const snippet = (await store.search('needle'))[0]?.snippet ?? '';
  assert.equal(snippet.length, 128); // 两侧省略号 + 60 A + NEEDLE + 60 B
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.equal(snippet.slice(1, -1), `${'A'.repeat(60)}NEEDLE${'B'.repeat(60)}`);

  const spaced = await store.create('空白');
  await store.append(spaced.id, { role: 'user', content: 'alpha   beta\n\n gamma MATCH' });
  assert.equal((await store.search('match')).find((hit) => hit.sessionId === spaced.id)?.snippet,
    '…alpha beta gamma MATCH…');
});
