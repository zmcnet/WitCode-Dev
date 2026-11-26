import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolService } from '@witcode/protocol';
import { createToolService, registerBuiltinTools } from '../src/index.ts';

function workspace(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witcode-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function service(): ToolService {
  const svc = createToolService();
  registerBuiltinTools(svc);
  return svc;
}

function ctx(root: string): ToolContext {
  return { workspace: root };
}

function quote(command: string): string {
  return `"${process.execPath}" -e "${command}"`;
}

test('service registers, lists, runs and disposes tools', async () => {
  const svc = createToolService();
  assert.deepEqual(svc.list(), []);

  const tool: ToolDefinition = {
    name: 'ping',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { ok: true, content: 'pong' };
    },
  };
  const dispose = svc.register(tool);
  assert.deepEqual(
    svc.list().map((item) => item.name),
    ['ping'],
  );

  const result = await svc.run('ping', {}, ctx(process.cwd()));
  assert.equal(result.ok, true);
  assert.equal(result.content, 'pong');

  dispose();
  assert.deepEqual(svc.list(), []);
  const missing = await svc.run('ping', {}, ctx(process.cwd()));
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /unknown tool/);
});

test('registers all five builtins with JSON schemas', () => {
  const svc = service();
  assert.deepEqual(
    svc.list().map((tool) => tool.name),
    ['read_file', 'write_file', 'list_dir', 'grep', 'run_command'],
  );
  for (const tool of svc.list()) {
    assert.equal(tool.inputSchema['type'], 'object');
    assert.ok(tool.description.length > 0);
  }
});

test('write_file creates parents and read_file returns numbered lines', async (t) => {
  const root = workspace(t);
  const svc = service();

  const content = 'one\ntwo\nthree';
  const written = await svc.run('write_file', { path: 'a/b/hello.txt', content }, ctx(root));
  assert.equal(written.ok, true);
  assert.match(written.content, new RegExp(`Wrote ${Buffer.byteLength(content, 'utf8')} bytes`));
  assert.equal(fs.readFileSync(path.join(root, 'a/b/hello.txt'), 'utf8'), content);

  const read = await svc.run('read_file', { path: 'a/b/hello.txt' }, ctx(root));
  assert.equal(read.ok, true);
  assert.match(read.content, /1\tone/);
  assert.match(read.content, /2\ttwo/);
  assert.match(read.content, /3\tthree/);
});

test('read_file honours offset/limit and truncates after 2000 lines', async (t) => {
  const root = workspace(t);
  const svc = service();
  const lines = Array.from({ length: 2005 }, (_, i) => `line-${i + 1}`);
  await svc.run('write_file', { path: 'big.txt', content: lines.join('\n') }, ctx(root));

  const all = await svc.run('read_file', { path: 'big.txt' }, ctx(root));
  assert.equal(all.ok, true);
  assert.match(all.content, /line-2000/);
  assert.doesNotMatch(all.content, /line-2001/);
  assert.match(all.content, /truncated/);
  assert.match(all.content, /of 2005/);

  const paged = await svc.run('read_file', { path: 'big.txt', offset: 10, limit: 2 }, ctx(root));
  assert.match(paged.content, /11\tline-11/);
  assert.match(paged.content, /12\tline-12/);
  assert.doesNotMatch(paged.content, /13\tline-13/);
});

test('list_dir returns sorted name, type and size', async (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'z.txt'), 'zz');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');

  const result = await service().run('list_dir', {}, ctx(root));
  assert.equal(result.ok, true);
  const lines = result.content.split('\n');
  const indexOf = (suffix: string): number => lines.findIndex((line) => line.endsWith(suffix));
  assert.ok(indexOf('a.txt') >= 0);
  assert.ok(indexOf('a.txt') < indexOf('z.txt'));
  assert.match(lines[indexOf('src')]!, /^dir\s/);
  assert.match(lines[indexOf('a.txt')]!, /^file\s+1\s+a\.txt$/);
});

test('grep walks recursively, matches regex and skips excluded dirs', async (t) => {
  const root = workspace(t);
  const files: Record<string, string> = {
    'src/a.ts': 'foo bar\nhello foo\n',
    'src/nested/b.ts': 'nothing here\nfoo again\n',
    'src/c.js': 'foo js\n',
    'node_modules/skip.ts': 'foo\n',
    '.git/skip.ts': 'foo\n',
    'dist/skip.ts': 'foo\n',
    '.witcode/skip.ts': 'foo\n',
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const svc = service();

  const result = await svc.run('grep', { pattern: 'foo' }, ctx(root));
  assert.equal(result.ok, true);
  assert.match(result.content, /src\/a\.ts:1:foo bar/);
  assert.match(result.content, /src\/nested\/b\.ts:2:foo again/);
  for (const excluded of ['node_modules', '.git', 'dist', '.witcode']) {
    assert.doesNotMatch(result.content, new RegExp(excluded.replace('.', '\\.')));
  }

  const filtered = await svc.run('grep', { pattern: 'foo', glob: '*.ts' }, ctx(root));
  assert.match(filtered.content, /a\.ts/);
  assert.doesNotMatch(filtered.content, /c\.js/);

  const deep = await svc.run('grep', { pattern: 'foo', glob: '**/*.ts' }, ctx(root));
  assert.match(deep.content, /nested\/b\.ts/);
});

test('grep caps results at 100 matches', async (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'many.txt'), Array.from({ length: 150 }, () => 'match').join('\n'));

  const result = await service().run('grep', { pattern: 'match' }, ctx(root));
  assert.equal(result.ok, true);
  assert.equal(result.content.split('\n').filter((line) => line.includes(':match')).length, 100);
  assert.match(result.content, /truncated/);
});

test('run_command uses workspace cwd and reports exit code plus output', async (t) => {
  const root = workspace(t);
  const svc = service();

  const echo = await svc.run('run_command', { command: 'echo hello-from-shell' }, ctx(root));
  assert.equal(echo.ok, true);
  assert.match(echo.content, /exit code: 0/);
  assert.match(echo.content, /hello-from-shell/);
  assert.match(echo.content, /--- stdout ---/);
  assert.match(echo.content, /--- stderr ---/);

  const cwd = await svc.run('run_command', { command: 'echo cwd-probe > probe.txt' }, ctx(root));
  assert.equal(cwd.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'probe.txt'), 'utf8').trim(), 'cwd-probe');

  const failed = await svc.run('run_command', { command: 'exit 3' }, ctx(root));
  assert.equal(failed.ok, true);
  assert.match(failed.content, /exit code: 3/);
});

test('run_command caps stdout and stderr at 100KB each', async (t) => {
  const root = workspace(t);
  const command = quote(
    "process.stdout.write('x'.repeat(150000)); process.stderr.write('y'.repeat(150000))",
  );

  const result = await service().run('run_command', { command }, ctx(root));
  assert.equal(result.ok, true);
  assert.match(result.content, /truncated: 100KB limit/);
  const stdout = result.content.split('--- stdout ---\n')[1]!.split('\n--- stderr ---')[0]!;
  const stderr = result.content.split('--- stderr ---\n')[1]!;
  assert.ok(stdout.length <= 100 * 1024 + 80);
  assert.ok(stderr.length <= 100 * 1024 + 80);
  assert.ok(!stdout.includes('y'));
  assert.ok(!stderr.includes('x'));
});

test('path escape is rejected by every path-taking tool', async (t) => {
  const root = workspace(t);
  const svc = service();
  const cases: Array<[string, unknown]> = [
    ['read_file', { path: '../outside.txt' }],
    ['write_file', { path: '../outside.txt', content: 'x' }],
    ['list_dir', { path: '..' }],
    ['grep', { pattern: 'x', path: '..' }],
    ['read_file', { path: path.join(os.tmpdir(), 'absolute-evil.txt') }],
  ];

  for (const [name, input] of cases) {
    const result = await svc.run(name, input, ctx(root));
    assert.equal(result.ok, false, name);
    assert.equal(result.error, 'path escapes workspace', name);
  }
  assert.ok(!fs.existsSync(path.join(path.dirname(root), 'outside.txt')));
});

test('exceptions and invalid inputs become ok:false results', async (t) => {
  const root = workspace(t);
  const svc = service();

  const missing = await svc.run('read_file', { path: 'does-not-exist.txt' }, ctx(root));
  assert.equal(missing.ok, false);
  assert.ok((missing.error ?? '').length > 0);

  const badInput = await svc.run('read_file', 'nope', ctx(root));
  assert.equal(badInput.ok, false);
  assert.match(badInput.error ?? '', /invalid input/);

  const badRegex = await svc.run('grep', { pattern: '[' }, ctx(root));
  assert.equal(badRegex.ok, false);
  assert.ok((badRegex.error ?? '').length > 0);
});

test('run_command times out and kills the process tree', async (t) => {
  const root = workspace(t);
  const command = quote('setTimeout(() => {}, 10000)');
  const started = Date.now();

  const result = await service().run('run_command', { command, timeoutMs: 300 }, ctx(root));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out/);
  assert.match(result.content, /timed out after 300ms/);
  assert.ok(Date.now() - started < 5000, 'timeout should stop the child promptly');
});
