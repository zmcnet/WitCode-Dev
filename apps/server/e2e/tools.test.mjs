// 工具链路 e2e：用剧本模型触发一次 read_file，验证「模型 → 工具 → 结果 → 再想」。
// 不依赖真实 API key，也不依赖网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoRoot = path.resolve(serverDir, '../..');
const PORT = 18788;
// 独立数据目录：否则会复用真实会话，剧本模型看到历史里的工具结果就跳过工具调用了。
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'witcode-e2e-tools-'));
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  throw new Error('server did not become healthy in time');
}

function startServer() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      WITCODE_MODEL_MODE: 'scripted',
      WITCODE_WORKSPACE: repoRoot,
      WITCODE_DATA_DIR: DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', () => {});

  return { child, getStderr: () => stderr };
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
  await sleep(200);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function runPrompt(text) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const received = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timeout waiting for done; got ${JSON.stringify(received)}`));
    }, 20000);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'prompt', text }));
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.type === 'done' || message.type === 'error') {
        clearTimeout(timer);
        socket.close();
        resolve(received);
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('剧本模型触发 read_file，并把结果回给模型', async () => {
  const { child, getStderr } = startServer();

  try {
    await waitHealth();
    const received = await runPrompt('看看这个项目是干嘛的');

    const toolCall = received.find((item) => item.type === 'tool-call');
    const toolResult = received.find((item) => item.type === 'tool-result');
    const done = received.find((item) => item.type === 'done');
    const error = received.find((item) => item.type === 'error');

    assert.equal(error, undefined, `unexpected error: ${error?.message ?? ''}`);
    assert.ok(toolCall, 'should emit tool-call');
    assert.equal(toolCall.name, 'read_file');
    assert.ok(toolResult, 'should emit tool-result');
    assert.equal(toolResult.ok, true);
    assert.match(toolResult.content, /WitCode/);
    assert.ok(done, 'should emit done');
    assert.ok(done.text.length > 0);
  } catch (error) {
    throw new Error(`${error.message}\n--- server stderr ---\n${getStderr().slice(-2000)}`);
  } finally {
    await killTree(child);
  }
});
