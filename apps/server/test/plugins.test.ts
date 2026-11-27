import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getBrain } from '@witcode/brains';
import type { PluginManager } from '../src/plugins.ts';
import { createPluginManager } from '../src/plugins.ts';

const TOOL_NAMES = [
  'read_file',
  'write_file',
  'list_dir',
  'grep',
  'run_command',
  'consult_partner',
  'spawn_subagent',
];
const BRAIN_IDS = ['standard', 'coding', 'dsh'];
const BUILTIN_IDS = [
  'witcode.tools',
  'witcode.brains',
  'witcode.collab',
  'witcode.memory',
  'witcode.context',
  'witcode.echo',
];

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-plugins-'));
}

async function makeManager(dataDir: string): Promise<PluginManager> {
  return createPluginManager({
    dataDir,
    toolNames: TOOL_NAMES,
    brainIds: BRAIN_IDS,
  });
}

function manifest(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `测试脑 ${id}`,
    description: '用于插件测试的本地 Brain',
    identity: '你是一个测试脑子。',
    rules: ['只依据事实回答'],
    bestFor: ['测试'],
    tools: {},
    ...extra,
  });
}

test('默认状态：七组内置插件全部启用，组件齐全，echo 锁定，状态可落盘', async () => {
  const dir = await tempDir();
  const manager = await makeManager(dir);
  const items = manager.list();

  assert.deepEqual(
    items.map((item) => item.id),
    BUILTIN_IDS,
  );
  assert.ok(items.every((item) => item.enabled && item.builtin && item.kind === 'builtin'));
  assert.deepEqual(
    items.find((item) => item.id === 'witcode.tools')?.components.map((c) => c.id),
    ['tool.read_file', 'tool.write_file', 'tool.list_dir', 'tool.grep', 'tool.run_command'],
  );
  assert.deepEqual(
    items.find((item) => item.id === 'witcode.collab')?.components.map((c) => c.id),
    ['tool.consult_partner', 'tool.spawn_subagent'],
  );

  const echo = items
    .find((item) => item.id === 'witcode.echo')
    ?.components.find((c) => c.id === 'feature.echo');
  assert.equal(echo?.locked, true);
  assert.ok(echo?.lockReason);

  // 默认工具 / Brain / feature 全开。
  for (const name of TOOL_NAMES) assert.equal(manager.isToolEnabled(name), true);
  for (const id of BRAIN_IDS) assert.equal(manager.isBrainEnabled(id), true);
  assert.equal(manager.isFeatureEnabled('projectMemory'), true);
  assert.equal(manager.isFeatureEnabled('context'), true);

  // 一次切换后 plugins.json 原子落盘，内容可读。
  await manager.setComponentEnabled('witcode.tools', 'tool.grep', false);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'plugins.json'), 'utf8'));
  assert.deepEqual(persisted.disabled, ['tool.grep']);
  assert.deepEqual(persisted.customBrains, []);
});

test('禁用单个工具：isToolEnabled=false，组件与插件状态同步', async () => {
  const manager = await makeManager(await tempDir());
  await manager.setComponentEnabled('witcode.tools', 'tool.grep', false);

  assert.equal(manager.isToolEnabled('grep'), false);
  assert.equal(manager.isToolEnabled('read_file'), true);
  const tools = manager.list().find((item) => item.id === 'witcode.tools');
  assert.equal(tools?.components.find((c) => c.id === 'tool.grep')?.enabled, false);
  assert.equal(tools?.enabled, true); // 同组其它工具仍启用

  // 整组停用再恢复。
  await manager.setPluginEnabled('witcode.tools', false);
  assert.equal(manager.isToolEnabled('read_file'), false);
  assert.equal(manager.isToolEnabled('grep'), false);
  await manager.setPluginEnabled('witcode.tools', true);
  assert.equal(manager.isToolEnabled('read_file'), true);
  // 之前单独禁用的 grep 被整组启用操作一并恢复。
  assert.equal(manager.isToolEnabled('grep'), true);
});

test('禁用单个 Brain：isBrainEnabled=false', async () => {
  const manager = await makeManager(await tempDir());
  await manager.setComponentEnabled('witcode.brains', 'brain.dsh', false);

  assert.equal(manager.isBrainEnabled('dsh'), false);
  assert.equal(manager.isBrainEnabled('standard'), true);
  const brains = manager.list().find((item) => item.id === 'witcode.brains');
  assert.equal(brains?.components.find((c) => c.id === 'brain.dsh')?.enabled, false);
});

test('locked echo 组件不可停用，整组切换也不影响它', async () => {
  const manager = await makeManager(await tempDir());
  await assert.rejects(
    manager.setComponentEnabled('witcode.echo', 'feature.echo', false),
    /已锁定|锁定/,
  );
  assert.equal(manager.isFeatureEnabled('echo'), true);

  await manager.setPluginEnabled('witcode.echo', false);
  assert.equal(
    manager.list().find((item) => item.id === 'witcode.echo')?.components[0]?.enabled,
    true,
  );
  assert.equal(manager.isFeatureEnabled('echo'), true);
});

test('installBrain：合法清单注册并列入插件，非法清单与 id 冲突被拒绝', async () => {
  const dir = await tempDir();
  const manager = await makeManager(dir);
  const id = 'test.brain.install';

  const items = await manager.installBrain(manifest(id));
  const installed = items.find((item) => item.id === `custom.${id}`);
  assert.ok(installed);
  assert.equal(installed.kind, 'brain');
  assert.equal(installed.builtin, false);
  assert.equal(installed.removable, true);
  assert.equal(installed.source, '本地安装');
  assert.equal(installed.enabled, true);
  assert.deepEqual(installed.components.map((c) => c.id), [`brain.${id}`]);
  assert.ok(getBrain(id));

  // 非法输入。
  await assert.rejects(manager.installBrain('{bad json'), /JSON/);
  await assert.rejects(manager.installBrain(JSON.stringify({ id: 'x', name: 'x' })), /identity/);
  await assert.rejects(
    manager.installBrain(manifest(id, { rules: 'not an array' })),
    /rules/,
  );
  await assert.rejects(
    manager.installBrain(manifest(id, { bestFor: 'not an array' })),
    /bestFor/,
  );
  await assert.rejects(manager.installBrain(manifest(id, { tools: [] })), /tools/);
  await assert.rejects(manager.installBrain(manifest(id, { modes: {} })), /modes/);

  // id 与内置 / 已装 Brain 冲突。
  await assert.rejects(manager.installBrain(manifest('standard')), /已存在|冲突/);
  await assert.rejects(manager.installBrain(manifest(id)), /已存在|冲突/);

  await manager.uninstall(`custom.${id}`);
});

test('重启后禁用状态与自定义 Brain 保留', async () => {
  const dir = await tempDir();
  const id = 'test.brain.restart';

  const first = await makeManager(dir);
  await first.setComponentEnabled('witcode.tools', 'tool.grep', false);
  await first.setComponentEnabled('witcode.memory', 'feature.projectMemory', false);
  await first.installBrain(manifest(id));

  const second = await makeManager(dir);
  assert.equal(second.isToolEnabled('grep'), false);
  assert.equal(second.isFeatureEnabled('projectMemory'), false);
  assert.equal(second.isFeatureEnabled('context'), true);
  assert.ok(second.list().find((item) => item.id === `custom.${id}`));
  assert.ok(getBrain(id));

  await second.uninstall(`custom.${id}`);
});

test('uninstall：移除自定义插件并注销 Brain，内置插件不可卸载', async () => {
  const dir = await tempDir();
  const manager = await makeManager(dir);
  const id = 'test.brain.uninstall';

  await manager.installBrain(manifest(id));
  assert.ok(getBrain(id));

  const items = await manager.uninstall(`custom.${id}`);
  assert.equal(items.find((item) => item.id === `custom.${id}`), undefined);
  assert.equal(getBrain(id), undefined);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'plugins.json'), 'utf8'));
  assert.deepEqual(persisted.customBrains, []);

  await assert.rejects(manager.uninstall('witcode.tools'), /内置插件不可卸载/);
});

test('isFeatureEnabled：context 可切换，echo 即使被写入 disabled 也永远为 true', async () => {
  const dir = await tempDir();
  const manager = await makeManager(dir);
  await manager.setComponentEnabled('witcode.context', 'feature.context', false);
  assert.equal(manager.isFeatureEnabled('context'), false);
  await manager.setComponentEnabled('witcode.context', 'feature.context', true);
  assert.equal(manager.isFeatureEnabled('context'), true);

  // 篡改持久化文件也不影响 echo 兜底。
  await fs.writeFile(
    path.join(dir, 'plugins.json'),
    JSON.stringify({ disabled: ['feature.echo'], customBrains: [] }),
    'utf8',
  );
  const reopened = await makeManager(dir);
  assert.equal(reopened.isFeatureEnabled('echo'), true);
  assert.equal(
    reopened.list().find((item) => item.id === 'witcode.echo')?.components[0]?.enabled,
    true,
  );
});
