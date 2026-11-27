import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolDefinition } from '@witcode/protocol';
import type { PluginRuntime } from '../src/plugin-runtime.ts';
import { createPluginRuntime } from '../src/plugin-runtime.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-plugin-runtime-'));
}

interface Recorder {
  tools: Map<string, ToolDefinition>;
  registered: string[];
  disposed: string[];
  register(tool: ToolDefinition): () => void;
}

function recorder(): Recorder {
  const tools = new Map<string, ToolDefinition>();
  const registered: string[] = [];
  const disposed: string[] = [];
  return {
    tools,
    registered,
    disposed,
    register(tool) {
      tools.set(tool.name, tool);
      registered.push(tool.name);
      return () => {
        tools.delete(tool.name);
        disposed.push(tool.name);
      };
    },
  };
}

function makeRuntime(dataDir: string, rec: Recorder, logs: string[], workspace?: string): PluginRuntime {
  return createPluginRuntime({
    dataDir,
    registerTool: rec.register,
    logger: (line) => logs.push(line),
    ...(workspace === undefined ? {} : { workspace }),
  });
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo.plugin',
    name: 'Demo Plugin',
    version: '1.2.3',
    description: '测试用代码插件',
    author: 'tester',
    main: 'main.mjs',
    ...overrides,
  };
}

async function writeFixture(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return dir;
}

const ECHO_MAIN = `
export function apply(api) {
  const cfg = api.getConfig();
  api.log('applied', cfg);
  api.registerTool({
    name: 'plugin_echo',
    description: 'Echo text from a code plugin',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async execute(input) {
      return { ok: true, content: String(input && input.text ? input.text : '') };
    },
  });
  api.onDispose(() => { api.log('disposed'); });
}
`;

const CONFIG_MAIN = `
export function apply(api) {
  api.registerTool({
    name: 'plugin_config',
    description: 'Read plugin config',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, content: JSON.stringify(api.getConfig()) };
    },
  });
  api.registerTool({
    name: 'plugin_set_config',
    description: 'Write plugin config',
    inputSchema: { type: 'object', properties: { greeting: { type: 'string' } } },
    async execute(input) {
      await api.setConfig({ greeting: input.greeting });
      return { ok: true, content: 'ok' };
    },
  });
}
`;

const LOG_MAIN = `
export function apply(api) {
  api.log('from-plugin');
  api.registerTool({
    name: 'plugin_workspace',
    description: 'Return workspace from api',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { ok: true, content: api.workspace };
    },
  });
}
`;

test('安装：校验清单、复制源目录、默认启用并注册工具，摘要字段齐全', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const src = await writeFixture(path.join(root, 'src'), baseManifest(), {
    'main.mjs': ECHO_MAIN,
    'extra.txt': 'kept',
  });
  const rec = recorder();
  const logs: string[] = [];
  const runtime = makeRuntime(dataDir, rec, logs);

  const items = await runtime.installLocal(src);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.id, 'demo.plugin');
  assert.equal(item.kind, 'code');
  assert.equal(item.builtin, false);
  assert.equal(item.removable, true);
  assert.equal(item.status, 'running');
  assert.equal(item.enabled, true);
  assert.equal(item.author, 'tester');
  assert.equal(item.main, 'main.mjs');
  assert.deepEqual(rec.registered, ['plugin_echo']);

  const installed = path.join(dataDir, 'plugins', 'demo.plugin');
  assert.deepEqual((await fs.readdir(installed)).sort(), ['extra.txt', 'main.mjs', 'manifest.json']);
  assert.ok(logs.some((line) => line.includes('沙箱')), '应明确警告无沙箱');
  assert.ok(logs.some((line) => line.includes('[plugin:demo.plugin] applied')), 'api.log 应带插件前缀');
});

test('禁用注销工具并写 disabled 列表；重新启用再次注册', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const src = await writeFixture(path.join(root, 'src'), baseManifest(), { 'main.mjs': ECHO_MAIN });
  const rec = recorder();
  const logs: string[] = [];
  const runtime = makeRuntime(dataDir, rec, logs);
  await runtime.installLocal(src);
  assert.deepEqual(rec.registered, ['plugin_echo']);

  const off = await runtime.setEnabled('demo.plugin', false);
  assert.equal(off[0]!.status, 'stopped');
  assert.equal(off[0]!.enabled, false);
  assert.deepEqual(rec.disposed, ['plugin_echo']);
  assert.equal(rec.tools.size, 0);
  assert.ok(logs.some((line) => line.includes('[plugin:demo.plugin] disposed')), 'onDispose 应触发');

  const state = JSON.parse(await fs.readFile(path.join(dataDir, 'plugins', 'installed.json'), 'utf8'));
  assert.deepEqual(state.disabled, ['demo.plugin']);

  // 重复禁用无副作用。
  await runtime.setEnabled('demo.plugin', false);
  assert.deepEqual(rec.disposed, ['plugin_echo']);

  const on = await runtime.setEnabled('demo.plugin', true);
  assert.equal(on[0]!.status, 'running');
  assert.equal(on[0]!.enabled, true);
  assert.deepEqual(rec.registered, ['plugin_echo', 'plugin_echo']);
  const state2 = JSON.parse(await fs.readFile(path.join(dataDir, 'plugins', 'installed.json'), 'utf8'));
  assert.deepEqual(state2.disabled, []);
});

test('卸载：删除插件目录、注销工具并从列表移除', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const src = await writeFixture(path.join(root, 'src'), baseManifest(), { 'main.mjs': ECHO_MAIN });
  const rec = recorder();
  const runtime = makeRuntime(dataDir, rec, []);
  await runtime.installLocal(src);

  const items = await runtime.uninstall('demo.plugin');
  assert.equal(items.length, 0);
  assert.deepEqual(rec.disposed, ['plugin_echo']);
  await assert.rejects(fs.stat(path.join(dataDir, 'plugins', 'demo.plugin')), { code: 'ENOENT' });
  await assert.rejects(runtime.uninstall('demo.plugin'), /未知的插件/);
});

test('非法 manifest 与 main 逃逸/自覆盖被拒绝且不留下安装目录', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const runtime = makeRuntime(dataDir, recorder(), []);

  await assert.rejects(
    runtime.installLocal(
      await writeFixture(path.join(root, 'bad-id'), baseManifest({ id: '../evil' }), {
        'main.mjs': ECHO_MAIN,
      }),
    ),
    /id 非法/,
  );
  await assert.rejects(
    runtime.installLocal(
      await writeFixture(path.join(root, 'upper-id'), baseManifest({ id: 'Demo' }), {
        'main.mjs': ECHO_MAIN,
      }),
    ),
    /id 非法/,
  );
  await assert.rejects(
    runtime.installLocal(
      await writeFixture(path.join(root, 'escape'), baseManifest({ main: '../evil.mjs' }), {
        'main.mjs': ECHO_MAIN,
      }),
    ),
    /main/,
  );

  // 源目录是安装目录的祖先时拒绝，避免覆盖自身。
  await writeFixture(dataDir, baseManifest(), { 'main.mjs': ECHO_MAIN });
  await assert.rejects(runtime.installLocal(dataDir), /重叠/);

  assert.equal(runtime.list().length, 0);
});

test('加载失败：apply 抛错或缺 apply 导出时 status=error + error，不崩服务', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const rec = recorder();
  const logs: string[] = [];
  const runtime = makeRuntime(dataDir, rec, logs);

  const boom = await writeFixture(
    path.join(root, 'boom'),
    baseManifest({ id: 'boom.plugin' }),
    {
      'main.mjs': `
export function apply(api) {
  api.registerTool({
    name: 'partial_tool',
    description: '部分注册',
    inputSchema: { type: 'object', properties: {} },
    async execute() { return { ok: true, content: '' }; },
  });
  throw new Error('boom in apply');
}
`,
    },
  );
  const failed = await runtime.installLocal(boom);
  assert.equal(failed[0]!.status, 'error');
  assert.match(failed[0]!.error ?? '', /boom in apply/);
  assert.equal(rec.tools.size, 0, '失败时已注册的工具应被清理');
  assert.ok(logs.some((line) => line.includes('加载失败')), '失败应记录日志');

  const noApply = await writeFixture(
    path.join(root, 'no-apply'),
    baseManifest({ id: 'no.apply' }),
    { 'main.mjs': 'export const nope = 1;\n' },
  );
  const failed2 = await runtime.installLocal(noApply);
  assert.equal(failed2[0]!.status, 'error');
  assert.match(failed2[0]!.error ?? '', /apply/);

  // 服务仍可用。
  assert.equal(runtime.list().length, 2);
  const okSrc = await writeFixture(path.join(root, 'ok'), baseManifest(), { 'main.mjs': ECHO_MAIN });
  const ok = await runtime.installLocal(okSrc);
  assert.equal(ok.find((item) => item.id === 'demo.plugin')?.status, 'running');
});

test('config：清单默认值合并，api 与 runtime 读写落盘 config.json', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const src = await writeFixture(
    path.join(root, 'src'),
    baseManifest({
      settings: [{ key: 'greeting', label: '问候语', type: 'string', default: 'hello' }],
    }),
    { 'main.mjs': CONFIG_MAIN },
  );
  const rec = recorder();
  const runtime = makeRuntime(dataDir, rec, []);
  await runtime.installLocal(src);

  assert.deepEqual(runtime.getConfig('demo.plugin'), { greeting: 'hello' });
  await runtime.setConfig('demo.plugin', { greeting: 'hi', extra: 7 });
  const onDisk = JSON.parse(
    await fs.readFile(path.join(dataDir, 'plugins', 'demo.plugin', 'config.json'), 'utf8'),
  );
  assert.deepEqual(onDisk, { greeting: 'hi', extra: 7 });

  const readTool = rec.tools.get('plugin_config')!;
  const result = await readTool.execute({}, { workspace: dataDir });
  assert.deepEqual(JSON.parse(result.content), { greeting: 'hi', extra: 7 });

  // 插件内部通过 api.setConfig 写入，同样落盘。
  await rec.tools.get('plugin_set_config')!.execute({ greeting: 'changed' }, { workspace: dataDir });
  assert.deepEqual(runtime.getConfig('demo.plugin'), { greeting: 'changed', extra: 7 });
  const onDisk2 = JSON.parse(
    await fs.readFile(path.join(dataDir, 'plugins', 'demo.plugin', 'config.json'), 'utf8'),
  );
  assert.deepEqual(onDisk2, { greeting: 'changed', extra: 7 });
  await assert.rejects(runtime.setConfig('missing', { a: 1 }), /未知的插件/);
});

test('重启 loadAll：保持禁用状态，恢复启用状态并注册工具', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const src = await writeFixture(path.join(root, 'src'), baseManifest(), { 'main.mjs': ECHO_MAIN });

  const first = makeRuntime(dataDir, recorder(), []);
  await first.installLocal(src);
  await first.setEnabled('demo.plugin', false);

  const rec2 = recorder();
  const second = makeRuntime(dataDir, rec2, []);
  await second.loadAll();
  const items = second.list();
  assert.equal(items[0]!.enabled, false);
  assert.equal(items[0]!.status, 'stopped');
  assert.deepEqual(rec2.registered, []);

  await second.setEnabled('demo.plugin', true);
  assert.deepEqual(rec2.registered, ['plugin_echo']);
  assert.equal(second.list()[0]!.status, 'running');

  // loadAll 幂等，不重复注册。
  await second.loadAll();
  assert.deepEqual(rec2.registered, ['plugin_echo']);
});

test('内置 id 冲突拒绝；node_modules 原样复制并警告；api.workspace 生效', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const rec = recorder();
  const logs: string[] = [];
  const runtime = makeRuntime(dataDir, rec, logs, workspace);

  await assert.rejects(
    runtime.installLocal(
      await writeFixture(path.join(root, 'builtin'), baseManifest({ id: 'witcode.tools' }), {
        'main.mjs': ECHO_MAIN,
      }),
    ),
    /冲突/,
  );

  const src = await writeFixture(
    path.join(root, 'with-deps'),
    baseManifest({ id: 'with.deps' }),
    { 'main.mjs': LOG_MAIN, 'node_modules/dep/index.mjs': 'export const dep = 1;\n' },
  );
  const items = await runtime.installLocal(src);
  assert.equal(items[0]!.status, 'running');
  assert.ok(logs.some((line) => line.includes('node_modules')), '应警告 node_modules');
  assert.equal(
    await fs.readFile(path.join(dataDir, 'plugins', 'with.deps', 'node_modules', 'dep', 'index.mjs'), 'utf8'),
    'export const dep = 1;\n',
  );
  const result = await rec.tools.get('plugin_workspace')!.execute({}, { workspace: root });
  assert.equal(result.content, workspace);
});
