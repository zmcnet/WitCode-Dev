// 端到端测试：真实启动服务端进程，通过 WebSocket 走完整条 prompt -> delta -> done 链路。
// 运行：cd apps/server && node --test e2e/*.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { after, before, test } from 'node:test';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 18787);
// 每个测试进程用独立数据目录，避免复用真实会话导致断言失真。
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'witcode-e2e-smoke-'));
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_TAIL = 4000;
const appendTail = (prev, chunk) => (prev + chunk.toString()).slice(-MAX_TAIL);

let child = null;
let stderrTail = '';
let stdoutTail = '';

function diagnostics() {
  return [
    '--- server stderr (tail) ---',
    stderrTail || '(empty)',
    '--- server stdout (tail) ---',
    stdoutTail || '(empty)',
  ].join('\n');
}

function spawnServer() {
  // 用同一个 node 可执行文件 + tsx loader，避免依赖 pnpm / 全局脚本。
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT), WITCODE_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk);
  });
  child.on('error', (error) => {
    stderrTail = appendTail(stderrTail, `\n[spawn error] ${error.message}`);
  });
  return child;
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `服务端提前退出 (exit=${child.exitCode}, signal=${child.signalCode})\n${diagnostics()}`,
      );
    }
    try {
      const response = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastError = new Error(`/health 返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  throw new Error(
    `${timeoutMs}ms 内 /health 未就绪 (${lastError?.message ?? 'unknown'})\n${diagnostics()}`,
  );
}

async function stopServer() {
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      // Windows 下 kill() 只杀 node 本身；taskkill /T 顺带清理整棵进程树。
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
        killer.once('error', resolve);
        killer.once('exit', resolve);
      });
    } else {
      child.kill('SIGTERM');
    }

    await Promise.race([once(child, 'exit').catch(() => {}), sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  child = null;
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = new Set();

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.messages.push(message);
      this._dispatch(this.messages.length - 1);
    });

    ws.on('error', (error) => {
      this.messages.push({ type: '__socket_error', message: error.message });
      this._dispatch(this.messages.length - 1);
    });
  }

  _dispatch(index) {
    const message = this.messages[index];
    for (const waiter of [...this.waiters]) {
      if (index < waiter.fromIndex) continue;
      if (waiter.predicate(message)) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve({ index, message });
      }
    }
  }

  /** 从 fromIndex 起等待第一条满足条件的消息，返回它在 messages 中的下标。 */
  waitFor(predicate, fromIndex = 0, timeoutMs = 5000) {
    for (let i = fromIndex; i < this.messages.length; i += 1) {
      if (predicate(this.messages[i])) {
        return Promise.resolve({ index: i, message: this.messages[i] });
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, fromIndex, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `等待消息超时(${timeoutMs}ms)，最近收到: ${JSON.stringify(
              this.messages.slice(-6),
            )}\n${diagnostics()}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = new Client(ws);
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket 连接超时\n${diagnostics()}`));
    }, 5000);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 连接失败: ${error.message}\n${diagnostics()}`));
    });
  });
}

function deltasBetween(client, startIndex, endIndex) {
  return client.messages
    .slice(startIndex, endIndex)
    .filter((message) => message.type === 'delta');
}

before(async () => {
  spawnServer();
  await waitForHealth();
});

after(async () => {
  await stopServer();
});

test('prompt 收到至少 1 个 delta 并以非空 done 结束', { timeout: 25000 }, async (t) => {
  const client = await connect();
  t.after(() => client.close());

  const ready = await client.waitFor((m) => m.type === 'ready', 0, 5000);
  assert.ok(ready.message.sessionId, 'ready 消息应带 sessionId');

  const start = client.messages.length;
  client.send({ type: 'prompt', text: 'e2e 冒烟' });

  const end = await client.waitFor(
    (m) => m.type === 'done' || m.type === 'error',
    start,
    10000,
  );
  assert.equal(
    end.message.type,
    'done',
    `期望 done，实际: ${JSON.stringify(end.message)}\n${diagnostics()}`,
  );

  const deltas = deltasBetween(client, start, end.index);
  assert.ok(deltas.length >= 1, `至少收到 1 个 delta，实际 ${deltas.length}`);
  assert.equal(typeof end.message.text, 'string', 'done.text 应为字符串');
  assert.ok(end.message.text.length > 0, 'done.text 不应为空');
  assert.equal(
    deltas.map((delta) => delta.text).join(''),
    end.message.text,
    'done.text 应等于所有 delta 的拼接',
  );
});

test('cancel 中断流式输出且连接仍可用', { timeout: 25000 }, async (t) => {
  const client = await connect();
  t.after(() => client.close());

  await client.waitFor((m) => m.type === 'ready', 0, 5000);

  const start = client.messages.length;
  client.send({ type: 'prompt', text: 'e2e 冒烟 取消' });
  client.send({ type: 'cancel' });

  const end = await client.waitFor(
    (m) => m.type === 'done' || m.type === 'error',
    start,
    6000,
  );
  assert.equal(
    end.message.type,
    'done',
    `期望 done，实际: ${JSON.stringify(end.message)}\n${diagnostics()}`,
  );

  const deltas = deltasBetween(client, start, end.index);
  assert.ok(
    deltas.length <= 3,
    `cancel 后不应继续无限输出，实际 delta 数量=${deltas.length}`,
  );

  // done 之后允许 sessions 之类的元数据更新，但不允许再有 delta / error。
  const quiet = await client
    .waitFor((m) => m.type === 'delta' || m.type === 'error', end.index + 1, 500)
    .then(() => false, () => true);
  assert.ok(quiet, 'cancel 完成后不应继续推送 delta/error');

  const start2 = client.messages.length;
  client.send({ type: 'prompt', text: 'e2e 冒烟 恢复' });
  const end2 = await client.waitFor(
    (m) => m.type === 'done' || m.type === 'error',
    start2,
    10000,
  );
  assert.equal(
    end2.message.type,
    'done',
    `恢复后的请求期望 done，实际: ${JSON.stringify(end2.message)}\n${diagnostics()}`,
  );

  const deltas2 = deltasBetween(client, start2, end2.index);
  assert.ok(deltas2.length >= 1, `恢复后至少收到 1 个 delta，实际 ${deltas2.length}`);
  assert.ok(end2.message.text.length > 0, '恢复后 done.text 不应为空');
});
