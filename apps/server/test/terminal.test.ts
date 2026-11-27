import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createPipeTerminal,
  createTerminal,
  defaultShell,
  type TerminalOptions,
  type TerminalSession,
} from '../src/terminal.ts';

const requireModule = createRequire(import.meta.url);
const PTY_AVAILABLE = (() => {
  try {
    const mod = requireModule('node-pty') as { spawn?: unknown };
    return typeof mod.spawn === 'function';
  } catch {
    return false;
  }
})();

const TEST_SHELL =
  process.platform === 'win32'
    ? process.env.ComSpec ?? 'cmd.exe'
    : process.env.SHELL ?? 'bash';

function options(extra: Partial<TerminalOptions> = {}): TerminalOptions {
  return { cwd: process.cwd(), cols: 80, rows: 24, ...extra };
}

function track(t: TestContext, session: TerminalSession): TerminalSession {
  t.after(() => session.kill());
  return session;
}

function withPtyMode<T>(fn: () => T): T {
  const previous = process.env.WITCODE_TERMINAL;
  delete process.env.WITCODE_TERMINAL;
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.env.WITCODE_TERMINAL = previous;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitExit(session: TerminalSession, timeoutMs = 6000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('exit 事件未触发')), timeoutMs);
    session.onExit((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function expectEcho(session: TerminalSession, marker: string): Promise<void> {
  let output = '';
  session.onData((data) => {
    output += data;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  session.write(`echo ${marker}\r\n`);
  // 一次来自终端回显，一次来自命令输出。
  await waitFor(() => output.split(marker).length - 1 >= 2, 8000, `echo ${marker}`);
}

test('defaultShell() 返回非空 shell', () => {
  const shell = defaultShell();
  assert.equal(typeof shell, 'string');
  assert.ok(shell.trim().length > 0);
});

test('pipe: echo hello 能收到输出', async (t) => {
  const session = track(t, createPipeTerminal(options({ shell: TEST_SHELL })));
  await expectEcho(session, 'WITCODE_PIPE_ECHO');
});

test(
  'PTY: echo hello 能收到输出',
  { skip: PTY_AVAILABLE ? false : 'node-pty 不可用，跳过 PTY 用例' },
  async (t) => {
    const session = track(t, withPtyMode(() => createTerminal(options({ shell: TEST_SHELL }))));
    await expectEcho(session, 'WITCODE_PTY_ECHO');
  },
);

test('pipe: resize 不抛，越界值被收敛', async (t) => {
  const session = track(t, createPipeTerminal(options({ shell: TEST_SHELL })));
  assert.doesNotThrow(() => session.resize(120, 40));
  assert.doesNotThrow(() => session.resize(-5, 5000));
});

test(
  'PTY: resize 不抛，越界值被收敛',
  { skip: PTY_AVAILABLE ? false : 'node-pty 不可用，跳过 PTY 用例' },
  async (t) => {
    const session = track(t, withPtyMode(() => createTerminal(options({ shell: TEST_SHELL }))));
    assert.doesNotThrow(() => session.resize(120, 40));
    assert.doesNotThrow(() => session.resize(-5, 99999));
  },
);

test('pipe: kill 后 exit 触发且可重复调用', async (t) => {
  const session = createPipeTerminal(options({ shell: TEST_SHELL }));
  track(t, session);
  let first = 0;
  let second = 0;
  session.onExit(() => first++);
  session.onExit(() => second++);
  const exited = waitExit(session);
  session.kill();
  assert.doesNotThrow(() => session.kill());
  const code = await exited;
  assert.equal(typeof code, 'number');
  assert.equal(first, 1);
  assert.equal(second, 1);
});

test(
  'PTY: kill 后 exit 触发且可重复调用',
  { skip: PTY_AVAILABLE ? false : 'node-pty 不可用，跳过 PTY 用例' },
  async (t) => {
    const session = withPtyMode(() => createTerminal(options({ shell: TEST_SHELL })));
    track(t, session);
    let first = 0;
    let second = 0;
    session.onExit(() => first++);
    session.onExit(() => second++);
    const exited = waitExit(session);
    session.kill();
    assert.doesNotThrow(() => session.kill());
    const code = await exited;
    assert.equal(typeof code, 'number');
    assert.equal(first, 1);
    assert.equal(second, 1);
  },
);

test('非法 cols/rows/cwd 报错，合法越界数值被收敛', async (t) => {
  assert.throws(() => createPipeTerminal(options({ cols: Number.NaN })), /cols/);
  assert.throws(() => createPipeTerminal(options({ rows: Number.POSITIVE_INFINITY })), /rows/);
  assert.throws(() => createPipeTerminal(options({ cols: '80' as unknown as number })), /cols/);
  assert.throws(
    () => createPipeTerminal(options({ cwd: path.join(process.cwd(), '__witcode_missing_dir__') })),
    /cwd/,
  );
  assert.throws(
    () => createPipeTerminal(options({ cwd: path.join(process.cwd(), 'package.json') })),
    /cwd/,
  );

  const session = track(t, createPipeTerminal(options({ cols: 5000, rows: -3 })));
  assert.doesNotThrow(() => session.resize(1, 1000));
});

test('onData 支持多监听与取消订阅', async (t) => {
  const session = track(t, createPipeTerminal(options({ shell: TEST_SHELL })));
  let active = '';
  let removed = '';
  session.onData((data) => {
    active += data;
  });
  const off = session.onData((data) => {
    removed += data;
  });
  off();
  session.write('echo WITCODE_LISTENER\r\n');
  await waitFor(() => active.includes('WITCODE_LISTENER'), 8000, 'onData 监听器');
  assert.equal(removed, '');
});

test(
  'env 只追加新变量，PATH/TERM 不被覆盖',
  { skip: process.platform !== 'win32' ? '仅验证 Windows cmd.exe' : false },
  async (t) => {
    const session = track(
      t,
      createPipeTerminal(
        options({
          shell: TEST_SHELL,
          env: {
            PATH: 'HACKED_PATH',
            HOME: 'HACKED_HOME',
            TERM: 'hacked-term',
            WITCODE_TEST_VAR: 'WITCODE_ADDED',
          },
        }),
      ),
    );
    let output = '';
    session.onData((data) => {
      output += data;
    });
    session.write(
      'echo ENV_VAR=%WITCODE_TEST_VAR%\r\necho ENV_TERM=%TERM%\r\necho ENV_PATH=%PATH%\r\n',
    );
    await waitFor(
      () =>
        output.includes('ENV_VAR=WITCODE_ADDED') &&
        output.includes('ENV_TERM=xterm-256color') &&
        output.includes('ENV_PATH='),
      8000,
      'env 校验输出',
    );
    assert.ok(!output.includes('HACKED_PATH'));
  },
);
