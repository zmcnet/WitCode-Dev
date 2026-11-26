import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolContext, ToolDefinition } from '@witcode/protocol';
import { builtinTools, createToolService } from '../src/index.ts';

const ctx: ToolContext = { workspace: path.resolve(process.cwd()) };

function byName(name: string): ToolDefinition {
  const tool = builtinTools.find((item) => item.name === name);
  assert.ok(tool, `missing builtin tool: ${name}`);
  return tool;
}

type ExpectedMeta = {
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe: boolean;
  riskLevel: 'low' | 'medium' | 'high';
};

test('五个内置工具的元数据符合执行契约', () => {
  const expected: Record<string, ExpectedMeta> = {
    read_file: { readOnly: true, concurrentSafe: true, riskLevel: 'low' },
    list_dir: { readOnly: true, concurrentSafe: true, riskLevel: 'low' },
    grep: { readOnly: true, concurrentSafe: true, riskLevel: 'low' },
    write_file: { destructive: true, concurrentSafe: false, riskLevel: 'medium' },
    run_command: { destructive: true, concurrentSafe: false, riskLevel: 'high' },
  };

  assert.deepEqual(
    builtinTools.map((tool) => tool.name),
    ['read_file', 'write_file', 'list_dir', 'grep', 'run_command'],
  );

  for (const [name, meta] of Object.entries(expected)) {
    const tool = byName(name);
    assert.equal(tool.readOnly, meta.readOnly, `${name}.readOnly`);
    assert.equal(tool.destructive, meta.destructive, `${name}.destructive`);
    assert.equal(tool.concurrentSafe, meta.concurrentSafe, `${name}.concurrentSafe`);
    assert.equal(tool.riskLevel, meta.riskLevel, `${name}.riskLevel`);
    assert.equal(typeof tool.resolveInput, 'function', `${name}.resolveInput`);
    assert.equal(name === 'write_file' || name === 'run_command', !!tool.prepareApproval);
  }
});

test('resolveInput 把各工具的路径归一化为绝对路径', async () => {
  const cases: Array<[string, unknown]> = [
    ['read_file', { path: 'src/../src/a.txt' }],
    ['write_file', { path: 'src/../src/a.txt', content: 'x' }],
    ['list_dir', { path: 'src/../src' }],
    ['grep', { pattern: 'x', path: 'src/../src' }],
  ];

  for (const [name, input] of cases) {
    const resolved = (await byName(name).resolveInput!(input, ctx)) as Record<string, unknown>;
    assert.equal(
      resolved.path,
      path.resolve(ctx.workspace, name === 'read_file' || name === 'write_file' ? 'src/a.txt' : 'src'),
      name,
    );
    assert.ok(path.isAbsolute(resolved.path as string), name);
  }

  const noPath = (await byName('list_dir').resolveInput!({}, ctx)) as Record<string, unknown>;
  assert.equal(noPath.path, undefined);
});

test('resolveInput 归一化数字、字符串与命令', async () => {
  const read = (await byName('read_file').resolveInput!(
    { path: 'a.txt', offset: '3', limit: '7' },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(read.offset, 3);
  assert.equal(read.limit, 7);

  const defaults = (await byName('read_file').resolveInput!({ path: 'a.txt' }, ctx)) as Record<
    string,
    unknown
  >;
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.limit, 2000);

  const write = (await byName('write_file').resolveInput!(
    { path: 'a.txt', content: 42 },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(write.content, '42');

  const command = (await byName('run_command').resolveInput!(
    { command: '  echo normalized  \n' },
    ctx,
  )) as Record<string, unknown>;
  assert.equal(command.command, 'echo normalized');
});

test('run 先调用 resolveInput 再把结果交给 execute', async () => {
  const calls: string[] = [];
  let executedInput: unknown;

  const fake: ToolDefinition = {
    name: 'ordered',
    description: 'ordered',
    inputSchema: { type: 'object' },
    async resolveInput(input, toolCtx) {
      calls.push('resolve');
      assert.equal(toolCtx, ctx);
      return { ...(input as Record<string, unknown>), normalized: true };
    },
    async execute(input, toolCtx) {
      calls.push('execute');
      executedInput = input;
      assert.equal(toolCtx, ctx);
      return { ok: true, content: 'done' };
    },
  };

  const service = createToolService();
  service.register(fake);
  const result = await service.run('ordered', { raw: 1 }, ctx);

  assert.deepEqual(calls, ['resolve', 'execute']);
  assert.deepEqual(executedInput, { raw: 1, normalized: true });
  assert.deepEqual(result, { ok: true, content: 'done' });
});

test('resolveInput 抛错时 run 不执行并返回固定失败结果', async () => {
  let executed = false;
  const service = createToolService();
  service.register({
    name: 'fail-normalize',
    description: 'fail-normalize',
    inputSchema: { type: 'object' },
    async resolveInput() {
      throw new Error('bad input');
    },
    async execute() {
      executed = true;
      return { ok: true, content: 'should not run' };
    },
  });

  assert.deepEqual(await service.run('fail-normalize', {}, ctx), {
    ok: false,
    content: '',
    error: '输入无法归一化',
  });
  assert.equal(executed, false);
});

test('write_file 的确认预览包含绝对路径与字节数', async () => {
  const tool = byName('write_file');
  const resolved = await tool.resolveInput!({ path: 'notes/../out.txt', content: '你好' }, ctx);
  const preview = await tool.prepareApproval!(resolved, ctx);

  assert.equal(preview.title, '写入文件');
  assert.equal(preview.riskLevel, 'medium');
  assert.ok(preview.detail.includes(path.resolve(ctx.workspace, 'out.txt')));
  assert.match(preview.detail, /6 字节/);
});

test('run_command 的确认预览包含实际命令与 cwd', async () => {
  const tool = byName('run_command');
  const resolved = await tool.resolveInput!({ command: '  echo preview  ' }, ctx);
  const preview = await tool.prepareApproval!(resolved, ctx);

  assert.equal(preview.title, '执行命令');
  assert.equal(preview.riskLevel, 'high');
  assert.match(preview.detail, /命令：echo preview/);
  assert.ok(preview.detail.includes(path.resolve(ctx.workspace)));
});
