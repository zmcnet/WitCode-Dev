import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createToolService, registerBuiltinTools } from '../src/index.ts';

test('内置文件工具：write_file → read_file → list_dir → grep', async (t) => {
  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'witcode-tools-'));
  t.after(() => fs.promises.rm(workspace, { recursive: true, force: true }));

  const service = createToolService();
  registerBuiltinTools(service);
  const ctx = { workspace };

  const write = await service.run(
    'write_file',
    { path: 'src/hello.txt', content: 'alpha\nbeta\ngamma\n' },
    ctx,
  );
  assert.equal(write.ok, true, write.error);

  const read = await service.run('read_file', { path: 'src/hello.txt', offset: 1, limit: 1 }, ctx);
  assert.equal(read.ok, true, read.error);
  assert.match(read.content, /beta/);
  assert.match(read.content, /skipped first 1 lines/);
  assert.match(read.content, /truncated: showing lines 2-2 of 3/);

  const list = await service.run('list_dir', { path: 'src' }, ctx);
  assert.equal(list.ok, true, list.error);
  assert.match(list.content, /hello\.txt/);

  const grep = await service.run('grep', { pattern: 'beta', path: 'src', glob: '*.txt' }, ctx);
  assert.equal(grep.ok, true, grep.error);
  assert.match(grep.content, /hello\.txt:2:beta/);
});

test('内置工具：越界路径与非法输入都返回失败结果', async () => {
  const service = createToolService();
  registerBuiltinTools(service);
  const ctx = { workspace: process.cwd() };

  const escape = await service.run('read_file', { path: '../secret.txt' }, ctx);
  assert.equal(escape.ok, false);
  assert.match(escape.error ?? '', /path escapes workspace/);

  const missing = await service.run('write_file', { path: 'x.txt' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /missing "content"/);

  // timeoutMs 校验在 spawn 之前，测试不会真的起子进程。
  const badTimeout = await service.run('run_command', { command: 'echo hi', timeoutMs: -1 }, ctx);
  assert.equal(badTimeout.ok, false);
  assert.match(badTimeout.error ?? '', /timeoutMs/);
});
