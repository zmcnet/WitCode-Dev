// 协作链路 e2e：主智能体 → 伙伴（只读咨询）→ 子智能体（独立任务）→ 总结。
// 用 collab 剧本模型，不依赖真实 API key。
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
const PORT = 18790;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'witcode-e2e-collab-'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      WITCODE_MODEL_MODE: 'collab',
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

function runPrompt(text, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const received = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timeout; got ${JSON.stringify(received.map((m) => m.type))}`));
    }, timeoutMs);

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

test('主智能体咨询伙伴并派发子智能体', async () => {
  const { child, getStderr } = startServer();

  try {
    await waitHealth();
    const received = await runPrompt('做一次带伙伴和子智能体的改动');

    const types = received.map((item) => item.type);
    const partnerStart = received.find((item) => item.type === 'partner:start');
    const partnerDone = received.find((item) => item.type === 'partner:done');
    const subagentStart = received.find((item) => item.type === 'subagent:start');
    const subagentDone = received.find((item) => item.type === 'subagent:done');
    const done = received.find((item) => item.type === 'done');
    const error = received.find((item) => item.type === 'error');

    assert.equal(error, undefined, `unexpected error: ${error?.message ?? ''}\n${types.join(',')}`);
    assert.ok(partnerStart, 'should emit partner:start');
    assert.equal(partnerStart.brainId, 'profession');
    assert.ok(partnerDone, 'should emit partner:done');
    assert.match(partnerDone.answer, /伙伴意见/);
    assert.ok(subagentStart, 'should emit subagent:start');
    assert.ok(subagentDone, 'should emit subagent:done');
    assert.equal(subagentDone.status, 'done');
    assert.match(subagentDone.output, /README/);
    assert.ok(done, 'should emit done');
    assert.match(done.text, /协作完成/);
  } catch (error) {
    throw new Error(`${error.message}\n--- server stderr ---\n${getStderr().slice(-3000)}`);
  } finally {
    await killTree(child);
  }
});
