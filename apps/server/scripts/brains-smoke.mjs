// 只读验证：brains:list / brain:select 链路。
// 注意：连接建立时服务端会主动推一次 brains（active=默认），必须和切换后的结果区分开。
import WebSocket from 'ws';

const socket = new WebSocket(process.env.WS_URL ?? 'ws://localhost:8787');
let requested = false;
const timer = setTimeout(() => {
  console.error('[brains-smoke] timeout');
  process.exit(1);
}, 10000);

socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'brains:list' }));
});

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());

  if (message.type === 'brains') {
    const ids = message.items.map((item) => item.id).join(',');
    console.log(`[brains-smoke] brains=${ids} active=${message.active}`);

    if (!requested) {
      requested = true;
      socket.send(JSON.stringify({ type: 'brain:select', brainId: 'zcode' }));
      return;
    }

    if (message.active === 'zcode') {
      console.log('[brains-smoke] switch ok');
      clearTimeout(timer);
      socket.close();
      process.exit(0);
    }
    return;
  }

  if (message.type === 'brain') {
    console.log(`[brains-smoke] selected=${message.brain.id} (${message.brain.name})`);
  }
});

socket.on('error', (error) => {
  clearTimeout(timer);
  console.error('[brains-smoke] socket error:', error.message);
  process.exit(1);
});
