import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ToolContext, ToolDefinition } from '@witcode/protocol';
import type { GoalState, GoalStatus } from '../src/goals.ts';
import { createGoalStore, createGoalTools } from '../src/goals.ts';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'witcode-goals-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function context(sessionId?: string): ToolContext {
  return { workspace: process.cwd(), sessionId };
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `缺少工具 ${name}`);
  return tool;
}

const state = (
  goal: string,
  status: GoalStatus = 'active',
  extra: Partial<GoalState> = {},
): GoalState => ({ goal, status, updatedAt: 1000, ...extra });

test('空目标：get 返回 null，get_goal 返回“当前没有目标”', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });

  assert.equal(store.get('s1'), null);
  const get = toolNamed(createGoalTools(store), 'get_goal');
  const result = await get.execute({}, context('s1'));
  assert.equal(result.ok, true);
  assert.equal(result.content, '当前没有目标');
  store.clear('s1'); // 幂等
  assert.equal(store.get('s1'), null);
});

test('设置/读取：set_goal 立目标并覆盖，get_goal 读回同一份', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });
  const tools = createGoalTools(store);
  const set = toolNamed(tools, 'set_goal');
  const get = toolNamed(tools, 'get_goal');

  const written = await set.execute({ goal: '  完成多轮重构  ' }, context('s1'));
  assert.equal(written.ok, true);
  assert.match(written.content, /目标：完成多轮重构/);
  assert.match(written.content, /状态：active/);
  assert.deepEqual(store.get('s1'), state('完成多轮重构', 'active', { updatedAt: store.get('s1')!.updatedAt }));

  const readBack = await get.execute({}, context('s1'));
  assert.equal(readBack.ok, true);
  assert.equal(readBack.content, written.content);

  const replaced = await set.execute({ goal: '新目标' }, context('s1'));
  assert.equal(replaced.ok, true);
  assert.equal(store.get('s1')?.goal, '新目标');
  assert.equal(store.get('s1')?.status, 'active');
  assert.equal(store.get('s1')?.note, undefined);
});

test('更新状态与 note：completed/blocked 可更新，note 可保留与清空，updatedAt 刷新', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });
  const tools = createGoalTools(store);
  const update = toolNamed(tools, 'update_goal');
  store.set('s1', state('发布 v2'));

  const done = await update.execute({ status: 'completed', note: '  已合并 PR  ' }, context('s1'));
  assert.equal(done.ok, true);
  assert.match(done.content, /状态：completed/);
  assert.match(done.content, /说明：已合并 PR/);
  const afterDone = store.get('s1')!;
  assert.equal(afterDone.status, 'completed');
  assert.equal(afterDone.note, '已合并 PR');
  assert.ok(afterDone.updatedAt > 1000);

  const blocked = await update.execute({ status: 'blocked' }, context('s1'));
  assert.equal(blocked.ok, true);
  assert.equal(store.get('s1')?.status, 'blocked');
  assert.equal(store.get('s1')?.note, '已合并 PR'); // 不传 note 时保留原说明

  const cleared = await update.execute({ status: 'active', note: '' }, context('s1'));
  assert.equal(cleared.ok, true);
  assert.equal(store.get('s1')?.note, undefined);
  assert.doesNotMatch(cleared.content, /说明：/);
});

test('无目标更新报错：不创建文件，也不污染其他会话', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });
  const update = toolNamed(createGoalTools(store), 'update_goal');

  const result = await update.execute({ status: 'active', note: 'x' }, context('s1'));
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
  assert.match(result.error!, /没有目标/);
  assert.equal(result.content, '');
  assert.equal(store.get('s1'), null);

  store.set('s2', state('别人的目标'));
  const other = await update.execute({ status: 'completed' }, context('s2'));
  assert.equal(other.ok, true);
  assert.equal(store.get('s1'), null);
});

test('非法输入：空 goal / 非法 status / 非字符串 note / 非法 store 状态均失败且不落盘', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });
  const tools = createGoalTools(store);
  const set = toolNamed(tools, 'set_goal');
  const update = toolNamed(tools, 'update_goal');

  for (const input of [{}, { goal: '' }, { goal: '   ' }, { goal: 123 }, null]) {
    const result = await set.execute(input, context('s1'));
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0);
    assert.equal(result.content, '');
  }
  for (const input of [
    {},
    { status: 'done' },
    { status: 1 },
    { status: 'completed', note: 42 },
    null,
  ]) {
    const result = await update.execute(input, context('s1'));
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0);
    assert.equal(result.content, '');
  }
  assert.equal(store.get('s1'), null);

  assert.throws(() => store.set('s1', state('', 'active')));
  assert.throws(() => store.set('s1', state('ok', 'done' as GoalStatus)));
  assert.throws(() => store.set('s1', { goal: 'ok', status: 'active', updatedAt: NaN }));
  assert.throws(() => store.set('s1', state('ok', 'active', { note: 7 as unknown as string })));
  assert.equal(store.get('s1'), null);
});

test('持久化：重开 store 读到同一份目标，clear 后为空', async (t) => {
  const dir = await tempDir(t);
  const first = await createGoalStore({ dataDir: dir });
  const expected = state('坚持到底', 'blocked', { note: '等依赖', updatedAt: 123456 });
  first.set('s1', expected);

  const second = await createGoalStore({ dataDir: dir });
  assert.deepEqual(second.get('s1'), expected);

  second.clear('s1');
  assert.equal(first.get('s1'), null);
  assert.equal(second.get('s1'), null);
  second.clear('s1'); // 幂等
});

test('会话隔离与默认会话：缺省 sessionId 落到 default', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });
  const tools = createGoalTools(store);
  const set = toolNamed(tools, 'set_goal');
  const get = toolNamed(tools, 'get_goal');

  await set.execute({ goal: 'A 的目标' }, context('session-a'));
  await set.execute({ goal: 'B 的目标' }, context('session-b'));
  await set.execute({ goal: '默认目标' }, context());
  await set.execute({ goal: '空 ID 目标' }, context(''));

  assert.equal(store.get('session-a')?.goal, 'A 的目标');
  assert.equal(store.get('session-b')?.goal, 'B 的目标');
  assert.equal(store.get('default')?.goal, '空 ID 目标');
  assert.equal(store.get('missing'), null);

  const result = await get.execute({}, context());
  assert.match(result.content, /空 ID 目标/);
  assert.doesNotMatch(result.content, /A 的目标|B 的目标/);
});

test('路径穿越：恶意 sessionId 被清洗，文件只落在 goals 目录内', async (t) => {
  const dir = await tempDir(t);
  const store = await createGoalStore({ dataDir: dir });
  const evil = '../../escape/../outside';

  store.set(evil, state('安全目标'));

  const goalsDir = path.join(dir, 'goals');
  const files = await fs.readdir(goalsDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^s-[0-9a-f]{24}\.json$/);
  assert.equal(path.dirname(path.join(goalsDir, files[0]!)), goalsDir);
  assert.deepEqual(store.get(evil), state('安全目标'));

  await assert.rejects(fs.stat(path.join(dir, 'escape')));
  await assert.rejects(fs.stat(path.join(dir, 'outside.json')));
  assert.equal(store.get('outside'), null);

  // 工具同样走清洗逻辑
  await toolNamed(createGoalTools(store), 'set_goal').execute(
    { goal: '恶意会话目标' },
    context('..\\..\\bad\\name'),
  );
  assert.equal(store.get('bad\\name'), null);
  assert.equal((await fs.readdir(goalsDir)).length, 2);
  await assert.rejects(fs.stat(path.join(dir, 'bad')));
});

test('工具声明：只读、低风险、可并行，描述说明先立目标并完成/受阻时更新', () => {
  const store = {
    get: (_sessionId: string): GoalState | null => null,
    set: (_sessionId: string, _state: GoalState): void => {},
    clear: (_sessionId: string): void => {},
  };
  const tools = createGoalTools(store);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['set_goal', 'get_goal', 'update_goal'],
  );
  for (const tool of tools) {
    assert.equal(tool.readOnly, true);
    assert.equal(tool.destructive, false);
    assert.equal(tool.riskLevel, 'low');
    assert.equal(tool.concurrentSafe, true);
    assert.match(tool.description, /多轮/);
    assert.match(tool.description, /目标/);
    assert.match(tool.description, /更新/);
  }
  const set = toolNamed(tools, 'set_goal');
  const update = toolNamed(tools, 'update_goal');
  assert.deepEqual((set.inputSchema as { required: string[] }).required, ['goal']);
  assert.deepEqual(
    (update.inputSchema as { properties: { status: { enum: string[] } } }).properties.status.enum,
    ['active', 'completed', 'blocked', 'cancelled'],
  );
});
