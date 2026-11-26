import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext, ToolDefinition } from '@witcode/protocol';
import { createToolService, registerBuiltinTools } from '../src/index.ts';

const ctx: ToolContext = { workspace: process.cwd() };

function makeTool(name: string, content: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    async execute() {
      return { ok: true, content };
    },
  };
}

test('register/list/run：工具注册、列举与执行', async () => {
  const service = createToolService();
  const tool = makeTool('echo', 'echo-result');

  const dispose = service.register(tool);

  assert.deepEqual(service.list(), [tool]);
  assert.deepEqual(await service.run('echo', {}, ctx), { ok: true, content: 'echo-result' });

  dispose();
  assert.deepEqual(service.list(), []);
});

test('run：未知工具返回失败结果而不是抛错', async () => {
  const service = createToolService();

  const result = await service.run('missing', {}, ctx);

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unknown tool: missing/);
});

test('run：execute 抛错或返回非法输入都转成失败结果', async () => {
  const service = createToolService();
  service.register({
    name: 'boom',
    description: 'boom',
    inputSchema: {},
    async execute() {
      throw new Error('kaboom');
    },
  });

  const result = await service.run('boom', {}, ctx);

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /kaboom/);
});

test('register：disposer 不会误删后来注册的同名工具', async () => {
  const service = createToolService();

  const first = service.register(makeTool('x', 'one'));
  first();
  const second = service.register(makeTool('x', 'two'));
  first();

  assert.equal((await service.run('x', {}, ctx)).content, 'two');
  second();
  assert.deepEqual(service.list(), []);
});

test('registerBuiltinTools：注册五个内置工具，disposer 全部注销', async () => {
  const service = createToolService();

  const dispose = registerBuiltinTools(service);

  assert.deepEqual(
    service.list().map((tool) => tool.name),
    ['read_file', 'write_file', 'list_dir', 'grep', 'run_command'],
  );

  dispose();
  assert.deepEqual(service.list(), []);
});
