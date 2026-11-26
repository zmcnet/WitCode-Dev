import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { SessionStore } from '@witcode/protocol';
import { createSqliteSessionStore } from '../src/index.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'witcode-session-'));
  tempDirs.push(dir);
  return dir;
}

function storeIn(dir: string): SessionStore {
  return createSqliteSessionStore({ dbPath: join(dir, 'witcode.db') });
}

afterEach(() => {
  // Windows 下 SQLite 仍持有文件句柄，删除临时目录可能失败；忽略即可，目录位于系统临时区。
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('create 生成 uuid、默认标题并返回完整记录', async () => {
  const store = storeIn(tempDir());

  const record = await store.create();
  assert.equal(typeof record.id, 'string');
  assert.ok(record.id.length > 0);
  assert.equal(record.title, '新会话');
  assert.equal(record.createdAt, record.updatedAt);
  assert.deepEqual(record.messages, []);

  const custom = await store.create('我的会话');
  assert.equal(custom.title, '我的会话');
  assert.notEqual(custom.id, record.id);
});

test('append 追加消息、刷新 updatedAt，get 按时间顺序返回完整消息', async () => {
  const store = storeIn(tempDir());
  const created = await store.create();

  await store.append(created.id, { role: 'user', content: '你好' });
  await store.append(created.id, { role: 'assistant', content: '你好呀' });
  await store.append(created.id, {
    role: 'tool',
    content: '文件内容',
    toolCallId: 'call-1',
    toolName: 'read_file',
  });

  const got = await store.get(created.id);
  assert.ok(got);
  assert.equal(got.id, created.id);
  assert.equal(got.title, created.title);
  assert.equal(got.createdAt, created.createdAt);
  assert.ok(got.updatedAt > created.updatedAt);
  assert.deepEqual(got.messages, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
    { role: 'tool', content: '文件内容', toolCallId: 'call-1', toolName: 'read_file' },
  ]);

  assert.equal(await store.get('不存在的会话'), null);
});

test('list 按 updatedAt 倒序返回摘要', async () => {
  const store = storeIn(tempDir());
  const first = await store.create('first');
  const second = await store.create('second');
  await store.append(first.id, { role: 'user', content: '更新一下' });

  const listed = await store.list();
  assert.deepEqual(
    listed.map((item) => item.id),
    [first.id, second.id],
  );
  assert.deepEqual(Object.keys(listed[0]!).sort(), ['id', 'title', 'updatedAt']);
});

test('rename 修改标题并反映在 get/list 中', async () => {
  const store = storeIn(tempDir());
  const session = await store.create('旧标题');

  await store.rename(session.id, '新标题');

  const got = await store.get(session.id);
  assert.equal(got?.title, '新标题');
  assert.equal((await store.list())[0]?.title, '新标题');
});

test('remove 删除会话及其消息', async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  const session = await store.create();
  await store.append(session.id, { role: 'user', content: 'hello' });

  await store.remove(session.id);

  assert.equal(await store.get(session.id), null);
  assert.deepEqual(await store.list(), []);

  const db = new DatabaseSync(join(dir, 'witcode.db'));
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
    .get(session.id) as unknown as { c: number } | undefined;
  db.close();
  assert.equal(row?.c, 0);
});

test('重开数据库后数据仍在', async () => {
  const dir = tempDir();
  const first = storeIn(dir);
  const session = await first.create('持久化');
  await first.append(session.id, { role: 'user', content: '记住我' });

  const reopened = storeIn(dir);
  const got = await reopened.get(session.id);
  assert.ok(got);
  assert.equal(got.title, '持久化');
  assert.deepEqual(got.messages, [{ role: 'user', content: '记住我' }]);
  assert.equal((await reopened.list()).length, 1);
});

test('assistant 的 toolCalls 写入后重开数据库仍完整保留', async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  const session = await store.create();
  const toolCalls = [
    { id: 'call-1', name: 'read_file', input: { path: 'D:/a.txt', line: 12 } },
    { id: 'call-2', name: 'list_dir', input: { recursive: true, patterns: ['*.ts', '*.md'] } },
  ];

  await store.append(session.id, { role: 'assistant', content: '', toolCalls });

  const reopened = storeIn(dir);
  const got = await reopened.get(session.id);
  assert.ok(got);
  assert.deepEqual(got.messages[0]?.toolCalls, toolCalls);
});

test('旧库缺少 tool_calls 列时自动升级且旧数据可读', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'witcode.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  legacy
    .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('legacy-1', '旧会话', 1000, 1000);
  legacy
    .prepare(
      'INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('legacy-1', 'user', '旧消息', null, null, 1001);
  legacy.close();

  const store = storeIn(dir);
  const got = await store.get('legacy-1');
  assert.ok(got);
  assert.deepEqual(got.messages, [{ role: 'user', content: '旧消息' }]);

  const toolCalls = [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }];
  await store.append('legacy-1', { role: 'assistant', content: '', toolCalls });
  const after = await store.get('legacy-1');
  assert.deepEqual(after?.messages[1]?.toolCalls, toolCalls);
});

test('tool_calls JSON 损坏时忽略并正常读取其他字段', async () => {
  const dir = tempDir();
  const store = storeIn(dir);
  const session = await store.create();
  await store.append(session.id, { role: 'assistant', content: '正常内容' });

  const db = new DatabaseSync(join(dir, 'witcode.db'));
  db.prepare('UPDATE messages SET tool_calls = ? WHERE session_id = ?').run('{bad json', session.id);
  db.close();

  const got = await store.get(session.id);
  assert.ok(got);
  assert.equal(got.messages[0]?.content, '正常内容');
  assert.equal(got.messages[0]?.toolCalls, undefined);
});

test('默认路径取自 WITCODE_DATA_DIR 并自动创建目录', async () => {
  const dir = tempDir();
  const dataDir = join(dir, 'nested', 'data');
  const previous = process.env.WITCODE_DATA_DIR;

  process.env.WITCODE_DATA_DIR = dataDir;
  try {
    createSqliteSessionStore();
    assert.ok(existsSync(join(dataDir, 'witcode.db')));
  } finally {
    if (previous === undefined) delete process.env.WITCODE_DATA_DIR;
    else process.env.WITCODE_DATA_DIR = previous;
  }
});
