import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { HookConfig } from '@witcode/protocol';
import { createHookRunner, createHookStore } from '../src/hooks.ts';
import type { HookStore } from '../src/hooks.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'witcode-hooks-'));
}

/** 写一个临时 .mjs 脚本，返回 shell 可直接执行的命令。 */
async function scriptCommand(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, body, 'utf8');
  return `"${process.execPath}" "${file}"`;
}

function hook(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    id: 'h1',
    name: '守卫',
    event: 'PreToolUse',
    matcher: 'write_*',
    command: 'node -e ""',
    enabled: true,
    ...overrides,
  };
}

test('store：CRUD、覆盖同 id、原子写与重新加载后持久化', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createHookStore({ dataDir: dir });

  assert.deepEqual(store.list(), []);

  const saved = await store.save(hook());
  assert.equal(saved.length, 1);
  assert.deepEqual(saved, store.list());

  const updated = await store.save(hook({ name: '守卫改名' }));
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.name, '守卫改名');

  await store.save(hook({ id: 'h2', event: 'Stop', name: '收尾', matcher: '' }));
  assert.equal(store.list().length, 2);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'hooks.json'), 'utf8'));
  assert.ok(Array.isArray(raw));
  assert.equal(raw.length, 2);
  assert.deepEqual((await createHookStore({ dataDir: dir })).list(), store.list());

  const removed = await store.remove('h1');
  assert.deepEqual(
    removed.map((item) => item.id),
    ['h2'],
  );
  assert.deepEqual(await store.remove('h1'), removed);
  assert.deepEqual(await store.remove('不存在'), removed);
  assert.deepEqual((await createHookStore({ dataDir: dir })).list(), removed);
});

test('store：校验 event/command，补全 id/name，timeout 收敛到 100..60000', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await createHookStore({ dataDir: dir });

  await assert.rejects(store.save(hook({ event: 'Bogus' as HookConfig['event'] })), /event/);
  await assert.rejects(store.save(hook({ command: '   ' })), /command/);
  await assert.rejects(store.save(hook({ event: undefined } as unknown as HookConfig)), /event/);

  const generated = await store.save({
    event: 'Stop',
    command: 'node -e ""',
    enabled: true,
  } as HookConfig);
  assert.ok(generated[0]?.id);
  assert.ok(generated[0]?.name);
  assert.equal(generated[0]?.timeoutMs, 10_000);

  await store.save(hook({ id: 'low', timeoutMs: 1 }));
  await store.save(hook({ id: 'high', timeoutMs: 999_999 }));
  const items = store.list();
  assert.equal(items.find((item) => item.id === 'low')?.timeoutMs, 100);
  assert.equal(items.find((item) => item.id === 'high')?.timeoutMs, 60_000);
});

test('matcher：* 匹配全部，前缀通配 write_* 只匹配对应工具名', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const prefixCmd = await scriptCommand(
    dir,
    'prefix',
    "console.log('MARK:PREFIX:' + process.env.WITCODE_TOOL_NAME);",
  );
  const anyCmd = await scriptCommand(dir, 'any', "console.log('MARK:ANY');");
  const store = await createHookStore({ dataDir: dir });
  await store.save(hook({ id: 'prefix', name: '前缀', command: prefixCmd, matcher: 'write_*' }));
  await store.save(hook({ id: 'any', name: '全部', command: anyCmd, matcher: '*' }));
  const runner = createHookRunner({ store });

  const write = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'write_file' });
  assert.equal(write.blocked, false);
  assert.match(write.logs.join('\n'), /MARK:PREFIX:write_file/);
  assert.match(write.logs.join('\n'), /MARK:ANY/);

  const read = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'read_file' });
  const readLogs = read.logs.join('\n');
  assert.doesNotMatch(readLogs, /MARK:PREFIX/);
  assert.match(readLogs, /MARK:ANY/);
  assert.match(readLogs, /skipped \(matcher/);
});

test('matcher：PostToolUse 参与匹配，Stop/SessionStart 忽略 matcher', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cmd = await scriptCommand(dir, 'mark', "console.log('MARK:EXEC');");
  const store = await createHookStore({ dataDir: dir });
  await store.save(
    hook({ id: 'post', event: 'PostToolUse', matcher: 'write_*', command: cmd }),
  );
  const runner = createHookRunner({ store });

  assert.match(
    (await runner.run('PostToolUse', { WITCODE_TOOL_NAME: 'write_file' })).logs.join('\n'),
    /MARK:EXEC/,
  );
  assert.doesNotMatch(
    (await runner.run('PostToolUse', { WITCODE_TOOL_NAME: 'read_file' })).logs.join('\n'),
    /MARK:EXEC/,
  );

  // 非工具事件没有工具名，matcher 被忽略，钩子仍执行。
  assert.match((await runner.run('Stop', {})).logs.join('\n'), /MARK:EXEC/);
  assert.match((await runner.run('SessionStart', {})).logs.join('\n'), /MARK:EXEC/);
});

test('PreToolUse：退出码 2 阻断并返回消息，后续钩子不再执行', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const blocker = await scriptCommand(
    dir,
    'blocker',
    "console.error('DENIED_BY_HOOK'); process.exit(2);",
  );
  const later = await scriptCommand(dir, 'later', "console.log('MARK:SHOULD_NOT_RUN');");
  const store = await createHookStore({ dataDir: dir });
  await store.save(hook({ id: 'blocker', name: '阻断器', command: blocker, matcher: 'write_*' }));
  await store.save(hook({ id: 'later', name: '后续', command: later, matcher: '*' }));
  const runner = createHookRunner({ store });

  const result = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'write_file' });
  assert.equal(result.blocked, true);
  assert.match(result.message ?? '', /DENIED_BY_HOOK/);
  assert.match(result.logs.join('\n'), /exit=2/);
  assert.doesNotMatch(result.logs.join('\n'), /MARK:SHOULD_NOT_RUN/);
});

test('非零退出：PreToolUse exit 1 与非工具事件非零只记录、不阻断', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const warn = await scriptCommand(
    dir,
    'warn',
    "console.error('WARN_ONLY'); process.exit(3);",
  );
  const store = await createHookStore({ dataDir: dir });
  await store.save(hook({ event: 'PreToolUse', command: warn, matcher: 'write_*' }));
  await store.save(hook({ id: 'stop', event: 'Stop', command: warn, matcher: '' }));
  const runner = createHookRunner({ store });

  const pre = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'write_file' });
  assert.equal(pre.blocked, false);
  assert.equal(pre.message, undefined);
  assert.match(pre.logs.join('\n'), /exit=3/);
  assert.match(pre.logs.join('\n'), /WARN_ONLY/);
  assert.match(pre.logs.join('\n'), /只记录，不阻断/);

  const stop = await runner.run('Stop', {});
  assert.equal(stop.blocked, false);
  assert.match(stop.logs.join('\n'), /exit=3/);
});

test('timeout：钩子级与 runner 级超时都杀进程并快速返回', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const slow = await scriptCommand(dir, 'slow', 'setInterval(() => {}, 1000);');
  const store = await createHookStore({ dataDir: dir });
  await store.save(hook({ id: 'slow', command: slow, timeoutMs: 100 }));
  const runner = createHookRunner({ store, timeoutMs: 10_000 });

  const started = Date.now();
  const result = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'write_file' });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `超时钩子耗时过长：${elapsed}ms`);
  assert.equal(result.blocked, false);
  assert.match(result.logs.join('\n'), /timeout/);
  assert.match(result.logs.join('\n'), /已杀进程树/);

  // runner 的 timeoutMs 作为没有配置 timeoutMs 的钩子默认值。
  const inlineStore: HookStore = {
    list: () => [hook({ id: 'inline', command: slow, timeoutMs: undefined })],
    save: async () => [],
    remove: async () => [],
  };
  const inlineResult = await createHookRunner({ store: inlineStore, timeoutMs: 100 }).run('Stop', {});
  assert.match(inlineResult.logs.join('\n'), /超时 100ms/);
});

test('输出截断：stdout 与 stderr 各保留最多 10KB', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const noisy = await scriptCommand(
    dir,
    'noisy',
    "process.stdout.write('O'.repeat(20000)); process.stderr.write('E'.repeat(20000));",
  );
  const store = await createHookStore({ dataDir: dir });
  await store.save(hook({ id: 'noisy', name: '吵闹', command: noisy, matcher: '' }));
  const runner = createHookRunner({ store });

  const result = await runner.run('Stop', {});
  const logs = result.logs.join('\n');
  const stdoutLog = result.logs.find((line) => line.includes(': stdout: ')) ?? '';
  const stderrLog = result.logs.find((line) => line.includes(': stderr: ')) ?? '';
  assert.equal(stdoutLog.slice(stdoutLog.indexOf(': stdout: ') + ': stdout: '.length).length, 10 * 1024);
  assert.equal(stderrLog.slice(stderrLog.indexOf(': stderr: ') + ': stderr: '.length).length, 10 * 1024);
  assert.ok(!logs.includes('O'.repeat(10 * 1024 + 1)));
  assert.ok(!logs.includes('E'.repeat(10 * 1024 + 1)));
});

test('禁用与不匹配：跳过且不执行命令', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const disabledCmd = await scriptCommand(dir, 'disabled', "console.log('MARK:DISABLED');");
  const matchCmd = await scriptCommand(dir, 'match', "console.log('MARK:MATCHED');");
  const store = await createHookStore({ dataDir: dir });
  await store.save(
    hook({ id: 'disabled', name: '已禁用', command: disabledCmd, matcher: '', enabled: false }),
  );
  await store.save(hook({ id: 'match', name: '匹配', command: matchCmd, matcher: 'write_*' }));
  const runner = createHookRunner({ store });

  const skipped = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'read_file' });
  const skippedLogs = skipped.logs.join('\n');
  assert.equal(skipped.blocked, false);
  assert.doesNotMatch(skippedLogs, /MARK:DISABLED/);
  assert.doesNotMatch(skippedLogs, /MARK:MATCHED/);
  assert.match(skippedLogs, /skipped \(disabled\)/);
  assert.match(skippedLogs, /skipped \(matcher/);

  const executed = await runner.run('PreToolUse', { WITCODE_TOOL_NAME: 'write_file' });
  assert.match(executed.logs.join('\n'), /MARK:MATCHED/);
  assert.doesNotMatch(executed.logs.join('\n'), /MARK:DISABLED/);
});

test('环境变量：传入事件、会话、工具名/输入/结果与钩子 id', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cmd = await scriptCommand(
    dir,
    'env',
    "console.log(JSON.stringify({event:process.env.WITCODE_EVENT,session:process.env.WITCODE_SESSION_ID,tool:process.env.WITCODE_TOOL_NAME,input:process.env.WITCODE_TOOL_INPUT,result:process.env.WITCODE_TOOL_RESULT,id:process.env.WITCODE_HOOK_ID}));",
  );
  const store = await createHookStore({ dataDir: dir });
  await store.save(hook({ id: 'env-hook', name: '环境', command: cmd, matcher: 'write_*' }));
  const runner = createHookRunner({ store });

  const result = await runner.run('PreToolUse', {
    WITCODE_SESSION_ID: 'session-42',
    WITCODE_TOOL_NAME: 'write_file',
    WITCODE_TOOL_INPUT: '{"path":"a.txt"}',
    WITCODE_TOOL_RESULT: 'ok',
  });
  const line = result.logs.find((item) => item.includes('stdout: ')) ?? '';
  const env = JSON.parse(line.slice(line.indexOf(': stdout: ') + ': stdout: '.length).trim());
  assert.equal(env.event, 'PreToolUse');
  assert.equal(env.session, 'session-42');
  assert.equal(env.tool, 'write_file');
  assert.equal(env.input, '{"path":"a.txt"}');
  assert.equal(env.result, 'ok');
  assert.equal(env.id, 'env-hook');
});
