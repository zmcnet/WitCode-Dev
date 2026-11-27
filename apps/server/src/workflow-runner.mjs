/**
 * Dynamic Workflow 的脚本执行器（独立子进程，纯 JS ESM）。
 *
 * 与父进程通过 stdin/stdout 的 NDJSON 通信：
 * - 父 → 子：{type:'start', script}；{type:'ask-result', requestId, result?/error?}
 * - 子 → 父：phase / agent / ask / artifact / log / done / error
 *
 * 脚本以 data URL 动态 import，因此顶层 await 可用；globals 挂在 globalThis 上。
 * 非 JSON 的 stdout 行由父进程忽略，这里只输出 JSON 行。
 */

import { randomUUID } from 'node:crypto';

const askWaiters = new Map();
let started = false;
let finished = false;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function format(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describe(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

/** 停止读 stdin，并防止脚本遗留的句柄让子进程永不退出。 */
function finish() {
  if (finished) return;
  finished = true;
  try {
    process.stdin.destroy();
  } catch {
    /* ignore */
  }
  // unref：正常情况下进程会随 stdout 排空自然退出；有遗留句柄时才强制退出。
  const forceExit = setTimeout(() => process.exit(0), 200);
  forceExit.unref?.();
}

function installGlobals() {
  globalThis.phase = (name) => {
    emit({ type: 'phase', name: typeof name === 'string' ? name : String(name ?? '') });
  };

  globalThis.agent = (name) => {
    const actorId = `actor-${randomUUID()}`;
    const actorName = typeof name === 'string' ? name : String(name ?? '');
    emit({ type: 'agent', id: actorId, name: actorName });
    return {
      id: actorId,
      name: actorName,
      ask(prompt) {
        const requestId = `ask-${randomUUID()}`;
        emit({
          type: 'ask',
          requestId,
          actorId,
          prompt: typeof prompt === 'string' ? prompt : String(prompt ?? ''),
        });
        return new Promise((resolve, reject) => {
          askWaiters.set(requestId, { resolve, reject });
        });
      },
    };
  };

  globalThis.artifact = (title, content) => {
    emit({
      type: 'artifact',
      title: typeof title === 'string' ? title : String(title ?? ''),
      content: typeof content === 'string' ? content : String(content ?? ''),
    });
  };

  globalThis.log = (...args) => {
    emit({ type: 'log', message: args.map(format).join(' ') });
  };
}

async function runScript(script) {
  try {
    installGlobals();
    const code = typeof script === 'string' ? script : '';
    const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
    await import(url);
    emit({ type: 'done' });
  } catch (error) {
    emit({ type: 'error', message: describe(error) });
  } finally {
    finish();
  }
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start') {
    if (started) return;
    started = true;
    void runScript(message.script);
    return;
  }
  if (message.type === 'ask-result') {
    const waiter = askWaiters.get(message.requestId);
    if (!waiter) return;
    askWaiters.delete(message.requestId);
    if (typeof message.error === 'string' && message.error.length > 0) {
      waiter.reject(new Error(message.error));
      return;
    }
    const result = message.result;
    waiter.resolve(typeof result === 'string' ? result : String(result ?? ''));
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  // cancel/结束时会 destroy stdin，忽略随之而来的错误。
});
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // 非 JSON 行或非法消息：忽略。
      }
    }
    index = buffer.indexOf('\n');
  }
});

process.on('unhandledRejection', (error) => {
  if (finished) return;
  emit({ type: 'error', message: describe(error) });
  finish();
});

process.on('uncaughtException', (error) => {
  if (finished) return;
  emit({ type: 'error', message: describe(error) });
  finish();
});
