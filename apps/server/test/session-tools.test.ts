import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionStore, ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';
import { createSqliteSessionStore } from '@witcode/session';
import { createSessionTools } from '../src/session-tools.ts';

const tempDirs: string[] = [];

function setup(): { store: SessionStore; tools: ToolDefinition[] } {
  const dir = mkdtempSync(join(tmpdir(), 'witcode-session-tools-'));
  tempDirs.push(dir);
  const store = createSqliteSessionStore({ dbPath: join(dir, 'witcode.db') });
  return { store, tools: createSessionTools(store) };
}

process.on('exit', () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上 SQLite 句柄可能仍占用，忽略即可。
    }
  }
});

function getTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `tool "${name}" should be registered`);
  return found;
}

function run(
  tool: ToolDefinition,
  input: unknown,
  ctx: ToolContext = { workspace: process.cwd() },
): Promise<ToolResult> {
  return tool.execute(input, ctx);
}

test('工具元数据：名称、只读标记、低风险与描述', () => {
  const { tools } = setup();
  assert.deepEqual(tools.map((tool) => tool.name), ['session_search', 'session_export']);

  for (const tool of tools) {
    assert.equal(tool.readOnly, true);
    assert.equal(tool.destructive, false);
    assert.equal(tool.concurrentSafe, true);
    assert.equal(tool.riskLevel, 'low');
    assert.equal((tool.inputSchema as { type?: string }).type, 'object');
    assert.ok(tool.description.length > 0);
  }
  assert.match(getTool(tools, 'session_search').description, /以前的对话/);
  assert.match(getTool(tools, 'session_export').description, /当前会话/);
  assert.deepEqual(
    ((getTool(tools, 'session_search').inputSchema as { required?: string[] }).required ?? []),
    ['query'],
  );
});

test('session_search：编号列表含标题、时间、片段与 sessionId，按更新时间倒序', async () => {
  const { store, tools } = setup();
  const first = await store.create('旧会话');
  const second = await store.create('新会话');
  await store.append(first.id, { role: 'user', content: 'the magic word appears here' });
  await store.append(second.id, { role: 'user', content: 'another magic word here' });

  const result = await run(getTool(tools, 'session_search'), { query: 'magic' });
  assert.equal(result.ok, true, result.error);
  assert.match(result.content, /^1\. 新会话\n/);
  assert.match(result.content, /2\. 旧会话\n/);
  assert.match(result.content, /时间: \d{4}-\d{2}-\d{2}T/);
  assert.match(result.content, /片段: .*magic word/);
  assert.ok(result.content.includes(`sessionId: ${second.id}`));
  assert.ok(result.content.includes(`sessionId: ${first.id}`));
});

test('session_search：limit 透传，无命中与非法参数', async () => {
  const { store, tools } = setup();
  for (let i = 0; i < 4; i += 1) {
    const session = await store.create(`s${i}`);
    await store.append(session.id, { role: 'user', content: `magic ${i}` });
  }

  const limited = await run(getTool(tools, 'session_search'), { query: 'magic', limit: 2 });
  assert.equal(limited.ok, true, limited.error);
  assert.equal(limited.content.match(/^\d+\. /gm)?.length, 2);

  const none = await run(getTool(tools, 'session_search'), { query: 'absent' });
  assert.equal(none.ok, true, none.error);
  assert.match(none.content, /未找到/);

  for (const input of [null, {}, { query: '' }, { query: '  ' }, { query: 'x', limit: '2' }]) {
    const bad = await run(getTool(tools, 'session_search'), input);
    assert.equal(bad.ok, false, `expected failure for ${JSON.stringify(input)}`);
  }
});

test('session_export：默认导出当前会话 Markdown，含 role、正文与工具调用 JSON', async () => {
  const { store, tools } = setup();
  const session = await store.create('导出标题');
  await store.append(session.id, { role: 'user', content: '帮我读文件' });
  await store.append(session.id, {
    role: 'assistant',
    content: '好的',
    toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }],
  });
  await store.append(session.id, { role: 'tool', content: '文件内容', toolCallId: 'c1', toolName: 'read_file' });

  const result = await run(getTool(tools, 'session_export'), {}, { workspace: process.cwd(), sessionId: session.id });
  assert.equal(result.ok, true, result.error);
  assert.match(result.content, /^# 导出标题/);
  assert.match(result.content, /创建时间: \d{4}-/);
  assert.match(result.content, /更新时间: \d{4}-/);
  assert.match(result.content, /### 1\. user/);
  assert.match(result.content, /### 2\. assistant/);
  assert.match(result.content, /### 3\. tool/);
  assert.match(result.content, /帮我读文件/);
  assert.match(result.content, /```json\n\[\s*\{[\s\S]*"name": "read_file"/);
  assert.match(result.content, /```/);
});

test('session_export：指定 sessionId 优先于上下文，json 格式返回记录', async () => {
  const { store, tools } = setup();
  const ctxSession = await store.create('上下文会话');
  const target = await store.create('目标会话');
  await store.append(target.id, { role: 'user', content: 'only in target' });

  const result = await run(
    getTool(tools, 'session_export'),
    { sessionId: target.id, format: 'json' },
    { workspace: process.cwd(), sessionId: ctxSession.id },
  );
  assert.equal(result.ok, true, result.error);
  const record = JSON.parse(result.content) as { id: string; title: string; messages: Array<{ content: string }> };
  assert.equal(record.id, target.id);
  assert.equal(record.title, '目标会话');
  assert.equal(record.messages[0]?.content, 'only in target');
});

test('session_export：未知会话与缺失 sessionId 报错', async () => {
  const { store, tools } = setup();
  const session = await store.create('存在');
  await store.append(session.id, { role: 'user', content: 'x' });

  const unknown = await run(getTool(tools, 'session_export'), { sessionId: 'no-such-session' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? '', /不存在|not found/);

  const noId = await run(getTool(tools, 'session_export'), {});
  assert.equal(noId.ok, false);
  assert.match(noId.error ?? '', /sessionId/);

  const badFormat = await run(getTool(tools, 'session_export'), { sessionId: session.id, format: 'xml' });
  assert.equal(badFormat.ok, false);
});

test('session_export：超过 50000 字符时截断', async () => {
  const { store, tools } = setup();
  const session = await store.create('超长');
  await store.append(session.id, { role: 'user', content: 'M'.repeat(60_000) });

  for (const format of ['markdown', 'json'] as const) {
    const result = await run(getTool(tools, 'session_export'), { sessionId: session.id, format });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.content.length <= 50_000, `${format} export exceeded cap`);
    assert.match(result.content, /截断/);
  }
});
