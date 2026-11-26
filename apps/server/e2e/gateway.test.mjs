// 模型网关端到端测试：本地起两个 HTTP mock provider，验证顺序回退、用量记录、
// 以及「明确 selection 后失败不切换」。不依赖真实 API key / 网络。
// 运行：cd apps/server && node --test e2e/gateway.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { after, before, test } from 'node:test';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '../..');
const PORT = Number(process.env.E2E_GATEWAY_PORT ?? 18789);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'witcode-e2e-gateway-'));
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const ID_A = 'e2e-provider-a';
const ID_B = 'e2e-provider-b';
const SECRET = 'sk-e2e-secret-do-not-leak-1234567890';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_TAIL = 4000;
const appendTail = (prev, chunk) => (prev + chunk.toString()).slice(-MAX_TAIL);

let mockA = null;
let mockB = null;
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

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

function startMock(handler) {
  const server = http.createServer((req, res) => {
    req.resume(); // 丢弃请求体，避免 keep-alive 卡住
    handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeMock(mock) {
  if (!mock) return Promise.resolve();
  return new Promise((resolve) => {
    mock.server.closeAllConnections?.();
    mock.server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// 服务端进程
// ---------------------------------------------------------------------------

function spawnServer() {
  // 用同一个 node 可执行文件 + tsx loader，避免依赖 pnpm / 全局脚本。
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      WITCODE_DATA_DIR: DATA_DIR,
      WITCODE_WORKSPACE: repoRoot,
      WITCODE_MODEL_MODE: 'auto',
      // 避免外部环境变量意外注入 provider，测试完全自包含。
      WITCODE_BASE_URL: '',
      WITCODE_API_KEY: '',
      WITCODE_MODEL: '',
    },
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
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1000) });
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

// ---------------------------------------------------------------------------
// WebSocket 客户端（带按条件等待）
// ---------------------------------------------------------------------------

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

function isFailureOf(items, providerId) {
  return items.filter((item) => item.providerId === providerId && item.ok === false);
}

function isSuccessOf(items, providerId) {
  return items.filter((item) => item.providerId === providerId && item.ok === true);
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

before(async () => {
  // A：任何请求都 500（模拟限流/故障）。
  mockA = await startMock((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('mock-a: rate limited');
  });

  // B：OpenAI 兼容 SSE，包含两块文本与 usage。
  mockB = await startMock((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    res.write(
      'data: {"choices":[{"delta":{"content":"，世界"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });

  spawnServer();
  await waitForHealth();
});

after(async () => {
  await stopServer();
  await Promise.all([closeMock(mockA), closeMock(mockB)]);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test('网关：顺序回退、usage 记录、明确 selection 失败不切换', { timeout: 60000 }, async (t) => {
  const client = await connect();
  t.after(() => client.close());

  try {
    // 0. 新数据目录下初始 selection 应为空。
    const initial = await client.waitFor((m) => m.type === 'selection', 0, 5000);
    assert.equal(initial.message.selection, null, '初始 selection 应为空');

    // 1. providers:save A / B（A 先保存，order 策略下先尝试 A）。
    let start = client.messages.length;
    client.send({
      type: 'providers:save',
      provider: {
        id: ID_A,
        name: 'Mock A (always 500)',
        baseUrl: mockA.url,
        apiKey: SECRET,
        modelIds: ['mock-a'],
      },
    });
    const savedA = await client.waitFor(
      (m) => m.type === 'providers' && m.items.some((p) => p.id === ID_A),
      start,
      8000,
    );
    assert.equal(savedA.message.items.length, 1, '保存 A 后应只有 1 个 provider');

    start = client.messages.length;
    client.send({
      type: 'providers:save',
      provider: {
        id: ID_B,
        name: 'Mock B (SSE)',
        baseUrl: mockB.url,
        apiKey: SECRET,
        modelIds: ['mock-b'],
      },
    });
    const savedB = await client.waitFor(
      (m) => m.type === 'providers' && m.items.length === 2,
      start,
      8000,
    );
    const items = savedB.message.items;
    assert.equal(items.length, 2, `providers 消息应有 2 项，实际 ${items.length}`);
    assert.deepEqual(
      items.map((p) => p.id).sort(),
      [ID_A, ID_B].sort(),
      '应包含 A 与 B 两个 provider',
    );
    for (const item of items) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(item, 'apiKey'),
        false,
        `provider ${item.id} 不应含明文 apiKey 字段`,
      );
      assert.equal(item.hasApiKey, true, `provider ${item.id} 应标记 hasApiKey`);
      assert.ok(
        !JSON.stringify(item).includes(SECRET),
        `provider ${item.id} 的公开视图不应泄露明文 key`,
      );
    }
    const modelsMsg = await client.waitFor(
      (m) => m.type === 'models' && m.items.some((i) => i.id === 'mock-b'),
      savedB.index,
      5000,
    );
    assert.ok(
      modelsMsg.message.items.some((i) => i.id === 'mock-a'),
      'models 应包含 mock-a',
    );

    // 2/3. 不设 selection 发 prompt：A 失败后应切到 B，最终 done 含「你好」。
    start = client.messages.length;
    client.send({ type: 'prompt', text: '网关 e2e：你好' });
    const end = await client.waitFor(
      (m) => m.type === 'done' || m.type === 'error',
      start,
      15000,
    );
    assert.equal(
      end.message.type,
      'done',
      `期望 done（A 失败后回退到 B），实际: ${JSON.stringify(end.message)}\n${diagnostics()}`,
    );
    assert.match(end.message.text, /你好/, `done.text 应包含「你好」: ${end.message.text}`);

    const deltas = deltasBetween(client, start, end.index);
    assert.ok(deltas.length >= 1, `至少收到 1 个 delta，实际 ${deltas.length}`);
    assert.match(
      deltas.map((d) => d.text).join(''),
      /你好/,
      'delta 拼接后应包含「你好」',
    );
    assert.equal(
      client.messages.slice(start, end.index + 1).some((m) => m.type === 'error'),
      false,
      '自动回退不应把 provider A 的错误暴露给客户端',
    );

    start = client.messages.length;
    client.send({ type: 'usage:list' });
    const usage1 = await client.waitFor((m) => m.type === 'usage', start, 8000);
    const aFailures = isFailureOf(usage1.message.items, ID_A);
    const bSuccesses = isSuccessOf(usage1.message.items, ID_B);
    assert.ok(aFailures.length >= 1, 'usage 应至少有 1 条 A 的失败记录');
    assert.ok(bSuccesses.length >= 1, 'usage 应至少有 1 条 B 的成功记录');
    assert.ok(aFailures[0].error, 'A 的失败记录应带 error 信息');
    const baselineA = aFailures.length;

    // 4. selection:set 到 A，再发 prompt：失败不应偷偷切到 B。
    start = client.messages.length;
    client.send({ type: 'selection:set', selection: { providerId: ID_A, model: 'mock-a' } });
    const selection = await client.waitFor(
      (m) => m.type === 'selection' && m.selection?.providerId === ID_A,
      start,
      8000,
    );
    assert.equal(selection.message.selection.model, 'mock-a', 'selection.model 应为 mock-a');

    start = client.messages.length;
    client.send({ type: 'prompt', text: '网关 e2e：固定选择' });
    const end2 = await client.waitFor(
      (m) => m.type === 'done' || m.type === 'error',
      start,
      15000,
    );
    assert.equal(
      end2.message.type,
      'error',
      `明确选择 A 后失败应收到 error（而非静默切到 B 后 done），实际: ${JSON.stringify(
        end2.message,
      )}\n${diagnostics()}`,
    );
    assert.match(end2.message.message, /500/, `error 应包含 500 信息: ${end2.message.message}`);
    assert.equal(
      deltasBetween(client, start, end2.index).length,
      0,
      '明确选择失败后不应产生来自 B 的文本输出',
    );
    const noDone = await client
      .waitFor((m) => m.type === 'done', end2.index + 1, 500)
      .then(() => false, () => true);
    assert.ok(noDone, '明确选择失败后不应额外收到 done');

    start = client.messages.length;
    client.send({ type: 'usage:list' });
    const usage2 = await client.waitFor((m) => m.type === 'usage', start, 8000);
    const aFailuresAfter = isFailureOf(usage2.message.items, ID_A).length;
    assert.ok(
      aFailuresAfter >= baselineA + 1,
      `usage 应新增一条 A 的失败记录（原 ${baselineA}，现 ${aFailuresAfter}）`,
    );
  } catch (error) {
    console.error('[gateway e2e] 服务端 stderr 尾部:\n' + stderrTail);
    throw error;
  }
});
