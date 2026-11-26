// 端到端冒烟：连上服务端，发一句话，确认能收到流式回复。
// 用法：node scripts/ws-smoke.mjs
import WebSocket from 'ws';

const url = process.env.WS_URL ?? 'ws://localhost:8787';
const text = process.env.PROMPT ?? '你好，WitCode';

const socket = new WebSocket(url);
let full = '';
let deltas = 0;

const timer = setTimeout(() => {
  console.error('timeout: 15s 内没有收到 done');
  process.exit(1);
}, 15000);

socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'prompt', text }));
});

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());

  if (message.type === 'ready') {
    console.log(`[smoke] session=${message.sessionId}`);
    return;
  }

  if (message.type === 'delta') {
    full += message.text;
    deltas += 1;
    return;
  }

  if (message.type === 'done') {
    clearTimeout(timer);
    console.log(`[smoke] deltas=${deltas} chars=${full.length}`);
    console.log(`[smoke] reply=${full}`);
    socket.close();
    process.exit(0);
  }

  if (message.type === 'error') {
    clearTimeout(timer);
    console.error(`[smoke] error: ${message.message}`);
    process.exit(1);
  }
});

socket.on('error', (error) => {
  clearTimeout(timer);
  console.error('[smoke] socket error:', error.message);
  process.exit(1);
});
