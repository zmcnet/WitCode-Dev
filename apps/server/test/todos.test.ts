import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { TodoItem, ToolContext, ToolDefinition } from '@witcode/protocol';
import { createTodoStore, createTodoTools, safeSessionId } from '../src/todos.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witcode-todos-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function context(workspace: string, sessionId?: string): ToolContext {
  return { workspace, sessionId };
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `缺少工具 ${name}`);
  return tool;
}

const item = (id: string, content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({
  id,
  content,
  status,
});

test('空清单：get 为空，todo_read 返回“当前没有待办”', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });

  assert.deepEqual(store.get('s1'), []);
  const read = toolNamed(createTodoTools(store), 'todo_read');
  const result = await read.execute({}, context(dir, 's1'));
  assert.equal(result.ok, true);
  assert.equal(result.content, '当前没有待办');

  const write = toolNamed(createTodoTools(store), 'todo_write');
  const emptyWrite = await write.execute({ items: [] }, context(dir, 's1'));
  assert.equal(emptyWrite.content, '当前没有待办');
});

test('写入/读取：todo_write 整表替换并返回渲染文本，todo_read 读回同一份', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });
  const tools = createTodoTools(store);
  const write = toolNamed(tools, 'todo_write');
  const read = toolNamed(tools, 'todo_read');

  const written = await write.execute(
    {
      items: [
        { content: '写计划', status: 'completed' },
        { content: '实现功能', status: 'in_progress' },
        { content: '跑测试' },
      ],
    },
    context(dir, 's1'),
  );
  assert.equal(written.ok, true);
  for (const text of ['写计划', '实现功能', '跑测试']) assert.match(written.content, new RegExp(text));
  assert.match(written.content, /1 待办 \/ 1 进行中 \/ 1 已完成/);

  assert.deepEqual(
    store.get('s1').map((todo) => [todo.content, todo.status]),
    [
      ['写计划', 'completed'],
      ['实现功能', 'in_progress'],
      ['跑测试', 'pending'],
    ],
  );
  const readBack = await read.execute({}, context(dir, 's1'));
  assert.equal(readBack.ok, true);
  assert.equal(readBack.content, written.content);

  const replaced = await write.execute(
    { items: [{ content: '新计划' }] },
    context(dir, 's1'),
  );
  assert.equal(replaced.ok, true);
  assert.deepEqual(
    store.get('s1').map((todo) => todo.content),
    ['新计划'],
  );
});

test('非法输入：非数组/空 content/非法 status/超限均失败且不落盘', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });
  const write = toolNamed(createTodoTools(store), 'todo_write');

  const invalid: unknown[] = [
    {},
    { items: 'oops' },
    { items: [null] },
    { items: [{ content: '   ' }] },
    { items: [{ content: 'ok', status: 'done' }] },
    { items: [{ content: 'ok', status: 1 }] },
    { items: Array.from({ length: 51 }, (_, i) => ({ content: `t${i}` })) },
  ];
  for (const input of invalid) {
    const result = await write.execute(input, context(dir, 's1'));
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0, `应给出错误信息：${JSON.stringify(input)}`);
    assert.equal(result.content, '');
  }
  assert.deepEqual(store.get('s1'), []);

  assert.throws(() => store.replace('s1', [item('x', '', 'pending')]));
  assert.throws(() => store.replace('s1', [item('x', 'ok', 'done' as TodoItem['status'])]));
  assert.throws(() => store.replace('s1', Array.from({ length: 51 }, (_, i) => item(`${i}`, `t${i}`))));
});

test('id 补全与去重：自动补 id，重复 id 重新分配，全部唯一', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });
  const write = toolNamed(createTodoTools(store), 'todo_write');

  const result = await write.execute(
    {
      items: [
        { id: 'dup', content: 'a' },
        { id: 'dup', content: 'b' },
        { id: '   ', content: 'c' },
        { content: 'd' },
      ],
    },
    context(dir, 's1'),
  );
  assert.equal(result.ok, true);
  const todos = store.get('s1');
  assert.equal(todos.length, 4);
  assert.deepEqual(
    todos.map((todo) => todo.content),
    ['a', 'b', 'c', 'd'],
  );
  for (const todo of todos) assert.ok(todo.id.length > 0);
  assert.equal(new Set(todos.map((todo) => todo.id)).size, 4);
  assert.deepEqual(store.get('s1'), todos);

  const fromStore = store.replace('s2', [item('same', 'a'), item('same', 'b')]);
  assert.equal(new Set(fromStore.map((todo) => todo.id)).size, 2);
});

test('50 条上限：正好 50 条可写，51 条拒绝', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });
  const fifty = Array.from({ length: 50 }, (_, i) => item(`t${i}`, `任务 ${i}`));

  assert.equal(store.replace('s1', fifty).length, 50);
  assert.equal(store.get('s1').length, 50);
  assert.throws(() => store.replace('s1', [...fifty, item('over', '溢出')]));
  assert.equal(store.get('s1').length, 50);

  const write = toolNamed(createTodoTools(store), 'todo_write');
  const tooMany = await write.execute(
    { items: Array.from({ length: 51 }, (_, i) => ({ content: `任务 ${i}` })) },
    context(dir, 's2'),
  );
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error ?? '', /50/);
});

test('持久化：重开 store 读到同一份清单，clear 后为空', async (t) => {
  const dir = await tempDir(t);
  const first = await createTodoStore({ dataDir: dir });
  const expected = [item('a', '持久化', 'in_progress'), item('b', '已完成', 'completed')];
  first.replace('s1', expected);

  const second = await createTodoStore({ dataDir: dir });
  assert.deepEqual(second.get('s1'), expected);

  second.clear('s1');
  assert.deepEqual(first.get('s1'), []);
  assert.deepEqual(second.get('s1'), []);
  second.clear('s1'); // 幂等
});

test('会话隔离与默认会话：缺省 sessionId 落到 default', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });
  const tools = createTodoTools(store);
  const write = toolNamed(tools, 'todo_write');
  const read = toolNamed(tools, 'todo_read');

  await write.execute({ items: [{ content: 'A' }] }, context(dir, 'session-a'));
  await write.execute({ items: [{ content: 'B' }] }, context(dir, 'session-b'));
  await write.execute({ items: [{ content: 'D' }] }, context(dir));
  await write.execute({ items: [{ content: 'E' }] }, context(dir, ''));

  assert.deepEqual(store.get('session-a').map((todo) => todo.content), ['A']);
  assert.deepEqual(store.get('session-b').map((todo) => todo.content), ['B']);
  assert.deepEqual(store.get('default').map((todo) => todo.content), ['E']);
  assert.deepEqual(store.get('missing'), []);

  const result = await read.execute({}, context(dir));
  assert.match(result.content, /E/);
  assert.doesNotMatch(result.content, /A|B/);
});

test('路径穿越：恶意 sessionId 被清洗，文件只落在 todos 目录内', async (t) => {
  const dir = await tempDir(t);
  const store = await createTodoStore({ dataDir: dir });
  const evil = '../../escape/../outside';

  store.replace(evil, [item('x', 'safe')]);

  const todosDir = path.join(dir, 'todos');
  const files = await fs.readdir(todosDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^s-[0-9a-f]{24}\.json$/);
  assert.equal(path.dirname(path.join(todosDir, files[0]!)), todosDir);
  assert.deepEqual(store.get(evil).map((todo) => todo.content), ['safe']);

  await assert.rejects(fs.stat(path.join(dir, 'escape')));
  await assert.rejects(fs.stat(path.join(dir, 'outside.json')));

  assert.doesNotMatch(safeSessionId(evil), /[\\/]/);
  assert.notEqual(safeSessionId('../../a'), safeSessionId('../../b'));
  assert.equal(safeSessionId('session.1'), 'session.1');
});

test('工具声明：只读、低风险、可并行，描述说明先列计划并完成即更新', () => {
  const store = {
    get: () => [],
    replace: (_sessionId: string, items: TodoItem[]) => items,
    clear: () => {},
  };
  const tools = createTodoTools(store);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['todo_write', 'todo_read'],
  );
  for (const tool of tools) {
    assert.equal(tool.readOnly, true);
    assert.equal(tool.riskLevel, 'low');
    assert.equal(tool.concurrentSafe, true);
    assert.match(tool.description, /计划/);
    assert.match(tool.description, /更新/);
  }
  const write = toolNamed(tools, 'todo_write');
  assert.deepEqual((write.inputSchema as { properties: { items: { maxItems: number } } }).properties.items.maxItems, 50);
});
