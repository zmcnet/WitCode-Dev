import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SkillSummary, SlashCommand, ToolDefinition } from '@witcode/protocol';
import {
  createCommandStore,
  createSkillStore,
  createSkillTool,
} from '../src/skills.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-skills-'));
}

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 's1',
    name: '代码审查',
    description: '审查代码质量',
    content: '完整技能正文：逐行检查并给出建议。',
    enabled: true,
    ...overrides,
  };
}

function command(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return { name: 'review', description: '审查', prompt: '请审查：', ...overrides };
}

test('默认状态：技能与命令列表为空，提示段为空，展开为 null', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const skills = await createSkillStore({ dataDir: dir });
  const commands = await createCommandStore({ dataDir: dir });

  assert.deepEqual(skills.list(), []);
  assert.equal(skills.enabledPromptSection(), '');
  assert.deepEqual(commands.list(), []);
  assert.equal(commands.expand('/review arg'), null);
});

test('技能 save 覆盖同 id、remove 不存在幂等，均返回最新列表', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createSkillStore({ dataDir: dir });

  const first = await store.save(skill());
  assert.equal(first.length, 1);
  assert.deepEqual(first, store.list());

  const overwritten = await store.save(
    skill({ name: '审查改名', description: '新描述', content: '新正文' }),
  );
  assert.equal(overwritten.length, 1);
  assert.equal(overwritten[0]?.name, '审查改名');
  assert.equal(overwritten[0]?.description, '新描述');
  assert.equal(overwritten[0]?.content, '新正文');

  assert.equal((await store.save(skill({ id: 's2', name: '测试' }))).length, 2);

  const removed = await store.remove('s1');
  assert.deepEqual(
    removed.map((item) => item.id),
    ['s2'],
  );
  assert.deepEqual(await store.remove('s1'), removed);
  assert.deepEqual(await store.remove('不存在'), removed);
  assert.deepEqual(store.list(), removed);
});

test('技能校验：id/name/content 必填，description 可空，enabled 默认 true', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createSkillStore({ dataDir: dir });

  await assert.rejects(store.save(skill({ id: '  ' })));
  await assert.rejects(store.save(skill({ name: '' })));
  await assert.rejects(store.save(skill({ content: '   ' })));
  await assert.rejects(store.save(skill({ id: undefined } as unknown as SkillSummary)));

  const saved = await store.save({ id: 'x', name: '最小技能', content: '正文' } as SkillSummary);
  assert.equal(saved[0]?.enabled, true);
  assert.equal(saved[0]?.description, '');
  assert.equal(saved[0]?.id, 'x');
  assert.equal(saved[0]?.name, '最小技能');
});

test('enabledPromptSection 只含启用技能，带标题与 use_skill 提示，长度上限 8000', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createSkillStore({ dataDir: dir });

  assert.equal(store.enabledPromptSection(), '');

  await store.save(skill({ id: 'on', name: '启用的', description: '可用描述' }));
  await store.save(skill({ id: 'off', name: '禁用的', description: '不应出现', enabled: false }));

  const section = store.enabledPromptSection();
  assert.match(section, /^## 可用技能/);
  assert.match(section, /- 启用的: 可用描述/);
  assert.doesNotMatch(section, /禁用的/);
  assert.match(section, /use_skill/);
  assert.ok(section.length <= 8000);

  await store.save(
    skill({ id: 'huge', name: '超长', description: '长'.repeat(20_000) }),
  );
  const capped = store.enabledPromptSection();
  assert.ok(capped.length <= 8000);
  assert.match(capped, /^## 可用技能/);
  assert.match(capped, /use_skill/);
});

test('命令 save 覆盖同名、remove 幂等；name/prompt 非法输入被拒绝', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createCommandStore({ dataDir: dir });

  assert.equal((await store.save(command())).length, 1);
  const overwritten = await store.save(command({ description: '改', prompt: '新提示：' }));
  assert.equal(overwritten.length, 1);
  assert.equal(overwritten[0]?.prompt, '新提示：');
  assert.equal(overwritten[0]?.description, '改');

  assert.equal((await store.save(command({ name: 'deploy' }))).length, 2);
  const removed = await store.remove('review');
  assert.deepEqual(
    removed.map((item) => item.name),
    ['deploy'],
  );
  assert.deepEqual(await store.remove('review'), removed);

  await assert.rejects(store.save(command({ name: 'Bad Name' })));
  await assert.rejects(store.save(command({ name: 'bad/name' })));
  await assert.rejects(store.save(command({ name: '' })));
  await assert.rejects(store.save(command({ prompt: '  ' })));
  await assert.rejects(store.save(command({ name: 'x', prompt: '' })));
});

test('命令展开：/name 开头展开为 prompt + 参数，未知命令返回 null', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createCommandStore({ dataDir: dir });

  await store.save(command({ name: 'review', prompt: '请审查' }));
  await store.save(command({ name: 'test-run', prompt: '请测试' }));

  assert.deepEqual(store.expand('/review src/a.ts --fix'), {
    command: 'review',
    text: '请审查 src/a.ts --fix',
  });
  assert.deepEqual(store.expand('/review'), { command: 'review', text: '请审查' });
  assert.deepEqual(store.expand('/test-run unit'), { command: 'test-run', text: '请测试 unit' });
  assert.deepEqual(store.expand('/REVIEW x'), { command: 'review', text: '请审查 x' });

  assert.equal(store.expand('/unknown x'), null);
  assert.equal(store.expand('review x'), null);
  assert.equal(store.expand('/review-more x'), null);
  assert.equal(store.expand(''), null);
});

test('use_skill 工具：readOnly，按 name/id 返回全文，禁用或未知返回 ok:false', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createSkillStore({ dataDir: dir });

  await store.save(skill({ id: 'skill-1', name: '审查', content: '正文一' }));
  await store.save(skill({ id: 'off', name: '禁用技能', content: '隐藏', enabled: false }));

  const tool: ToolDefinition = createSkillTool(store);
  assert.equal(tool.name, 'use_skill');
  assert.equal(tool.readOnly, true);
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, ['name']);

  const ctx = { workspace: dir };
  assert.deepEqual(await tool.execute({ name: '审查' }, ctx), { ok: true, content: '正文一' });
  assert.deepEqual(await tool.execute({ name: 'skill-1' }, ctx), { ok: true, content: '正文一' });
  assert.equal((await tool.execute({ name: '禁用技能' }, ctx)).ok, false);
  assert.equal((await tool.execute({ name: '不存在' }, ctx)).ok, false);
  assert.equal((await tool.execute({}, ctx)).ok, false);
});

test('持久化重启：落盘文件保留，损坏文件回退空数组', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const skills = await createSkillStore({ dataDir: dir });
  const commands = await createCommandStore({ dataDir: dir });
  await skills.save(skill({ id: 'p1', name: '持久', content: '内容' }));
  await commands.save(command({ name: 'persist', prompt: '持久提示' }));

  assert.ok((await fs.stat(path.join(dir, 'skills.json'))).isFile());
  assert.ok((await fs.stat(path.join(dir, 'commands.json'))).isFile());

  const skills2 = await createSkillStore({ dataDir: dir });
  const commands2 = await createCommandStore({ dataDir: dir });
  assert.deepEqual(skills2.list(), skills.list());
  assert.deepEqual(commands2.list(), commands.list());
  assert.deepEqual(commands2.expand('/persist arg'), {
    command: 'persist',
    text: '持久提示 arg',
  });

  await fs.writeFile(path.join(dir, 'skills.json'), '{bad json', 'utf8');
  await fs.writeFile(path.join(dir, 'commands.json'), '"not an array"', 'utf8');
  const skills3 = await createSkillStore({ dataDir: dir });
  const commands3 = await createCommandStore({ dataDir: dir });
  assert.deepEqual(skills3.list(), []);
  assert.deepEqual(commands3.list(), []);
  assert.equal(skills3.enabledPromptSection(), '');
});
