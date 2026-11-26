// 只读验证：连上服务端，请求 providers/models/selection，确认 P2 消息链路通。
// 不保存任何 provider，不污染真实数据。
import WebSocket from 'ws';

const url = process.env.WS_URL ?? 'ws://localhost:8787';
const socket = new WebSocket(url);

const timer = setTimeout(() => {
  console.error('[providers-smoke] timeout');
  process.exit(1);
}, 10000);

socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'providers:list' }));
});

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());

  if (message.type === 'providers') {
    console.log(`[providers-smoke] providers=${message.items.length}`);
  }
  if (message.type === 'models') {
    console.log(`[providers-smoke] models=${message.items.length}`);
  }
  if (message.type === 'selection') {
    console.log(`[providers-smoke] selection=${JSON.stringify(message.selection)}`);
    clearTimeout(timer);
    socket.close();
    process.exit(0);
  }
});

socket.on('error', (error) => {
  clearTimeout(timer);
  console.error('[providers-smoke] socket error:', error.message);
  process.exit(1);
});
