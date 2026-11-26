// 临时视觉验收脚本：mock WebSocket 注入高风险 approval:request，截确认弹窗 1440 / 390。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-approval-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-session-01';
const APPROVAL = {
  id: 'approval-demo-01',
  tool: 'run_command',
  title: '执行 shell 命令',
  detail: [
    '$ rm -rf ./dist',
    '$ pnpm --filter @witcode/web build',
    'cwd: D:\\Files\\Projects\\WitCode',
    'timeout: 60000ms',
    '',
    '该命令会删除构建产物并重新构建，影响当前工作区文件。',
  ].join('\n'),
  riskLevel: 'high',
  reason: '命令包含删除操作，属于破坏性工具调用。普通模式下需要你确认后才会执行。',
};
const HISTORY = [
  { role: 'user', content: '帮我重新构建一下前端。' },
  { role: 'assistant', content: '我先清理旧的构建产物，再重新构建；这一步会删除文件，需要你确认。' },
];

const responses = [];
let mockWs;
const fail = (message) => {
  throw new Error(`[check failed] ${message}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => console.error('[pageerror]', error.message));

await page.routeWebSocket(/ws:\/\/localhost:8787/, (ws) => {
  mockWs = ws;
  ws.onMessage((message) => {
    let data;
    try {
      data = JSON.parse(typeof message === 'string' ? message : message.text());
    } catch {
      return;
    }
    if (data.type === 'approval:response') {
      responses.push(data);
      console.log('[approval:response]', data.id, data.decision);
    }
    if (data.type === 'providers:list') {
      ws.send(JSON.stringify({ type: 'providers', items: [] }));
    }
    if (data.type === 'usage:list') {
      ws.send(JSON.stringify({ type: 'usage', items: [], summary: null }));
    }
    if (data.type === 'brains:list') {
      ws.send(JSON.stringify({ type: 'brains', items: [], active: '' }));
    }
  });
  ws.send(JSON.stringify({ type: 'ready', sessionId: SESSION_ID, model: 'demo-chat', permission: 'normal' }));
  ws.send(JSON.stringify({ type: 'models', items: [] }));
  ws.send(JSON.stringify({ type: 'sessions', items: [{ id: SESSION_ID, title: '重新构建前端', updatedAt: Date.now() }] }));
  ws.send(JSON.stringify({ type: 'history', sessionId: SESSION_ID, messages: HISTORY }));
  ws.send(JSON.stringify({ type: 'approval:request', request: APPROVAL }));
});

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

try {
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.approval-dialog[role="dialog"][aria-modal="true"]', { timeout: 15000 });

  const tool = await page.locator('.approval-tool').textContent();
  const title = await page.locator('#approval-title').textContent();
  const detail = await page.locator('.approval-detail').textContent();
  const risk = await page.locator('.approval-risk').textContent();
  const reason = await page.locator('#approval-reason').textContent();
  if (tool?.trim() !== APPROVAL.tool) fail(`工具名不符：${tool}`);
  if (title?.trim() !== APPROVAL.title) fail(`标题不符：${title}`);
  if (!detail?.includes('rm -rf ./dist')) fail('detail 未展示命令');
  if (risk?.trim() !== '高风险') fail(`风险徽章不符：${risk}`);
  if (!(await page.locator('.approval-risk.risk-high').count())) fail('高风险徽章未使用 risk-high 样式');
  if (!reason?.includes('破坏性工具')) fail('未展示 reason');
  if ((await page.locator('.approval-allow.primary').count())) fail('高风险允许按钮不应是主样式');
  if (!(await page.locator('.approval-allow.approval-allow-secondary').count())) fail('高风险允许按钮应为次级样式');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  if (focused !== '拒绝执行此工具') fail(`默认焦点不在拒绝按钮：${focused}`);
  console.log('[approval:focus]', focused);

  const overflow1440 = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow1440 > 0) fail(`1440 横向溢出 ${overflow1440}px`);
  await page.waitForTimeout(300);
  await shot('08-approval-dialog-1440.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow390 = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow390 > 0) fail(`390 横向溢出 ${overflow390}px`);
  const cardWidth = await page.evaluate(
    () => document.querySelector('.approval-dialog')?.getBoundingClientRect().width ?? 0,
  );
  if (cardWidth > 390) fail(`390 下弹窗过宽：${cardWidth}px`);
  const direction = await page.evaluate(
    () => getComputedStyle(document.querySelector('.approval-actions')).flexDirection,
  );
  if (direction !== 'column') fail(`390 按钮未纵向堆叠：${direction}`);
  console.log('[approval:card-width]', cardWidth, 'actions:', direction);
  await shot('09-approval-dialog-390.png');

  // 截图完成后验证交互：Esc = 拒绝
  await page.keyboard.press('Escape');
  await page.waitForSelector('.approval-dialog', { state: 'detached', timeout: 5000 });
  if (!responses.some((item) => item.id === APPROVAL.id && item.decision === 'deny')) {
    fail('Esc 未发出 deny 回包');
  }

  // 点遮罩 = 拒绝
  mockWs.send(JSON.stringify({ type: 'approval:request', request: { ...APPROVAL, id: 'approval-demo-02' } }));
  await page.waitForSelector('.approval-dialog', { timeout: 5000 });
  await page.mouse.click(4, 4);
  await page.waitForSelector('.approval-dialog', { state: 'detached', timeout: 5000 });
  if (!responses.some((item) => item.id === 'approval-demo-02' && item.decision === 'deny')) {
    fail('点遮罩未发出 deny 回包');
  }

  // 后到请求：覆盖并拒绝旧请求
  mockWs.send(JSON.stringify({ type: 'approval:request', request: { ...APPROVAL, id: 'approval-old' } }));
  await page.waitForSelector('.approval-dialog', { timeout: 5000 });
  mockWs.send(JSON.stringify({ type: 'approval:request', request: { ...APPROVAL, id: 'approval-new' } }));
  await page.waitForFunction(
    () => document.querySelector('.approval-tool')?.textContent !== '',
    { timeout: 5000 },
  );
  await page.waitForTimeout(200);
  if (!responses.some((item) => item.id === 'approval-old' && item.decision === 'deny')) {
    fail('后到请求未拒绝旧请求');
  }

  console.log('[done] 2 张截图 ->', OUT);
} finally {
  await browser.close();
}
