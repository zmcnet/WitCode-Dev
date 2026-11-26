// 临时视觉验收脚本：用 mocked WebSocket 注入演示会话，截三张 v2 布局图并做尺寸断言。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-session-01';
const SESSIONS = [
  { id: SESSION_ID, title: '梳理项目结构与工具调用', updatedAt: Date.now() - 8 * 60_000 },
  { id: 'demo-session-02', title: '设计新的工作台布局', updatedAt: Date.now() - 3 * 3_600_000 },
  { id: 'demo-session-03', title: '排查 WebSocket 重连', updatedAt: Date.now() - 26 * 3_600_000 },
];
const PROVIDERS = [
  {
    id: 'demo-provider',
    name: 'Demo Provider',
    baseUrl: 'https://api.example.com/v1',
    modelIds: ['demo-chat', 'demo-mini'],
    enabled: true,
    hasApiKey: true,
    apiKeyHint: 'sk-…a1b2',
  },
];
const MODELS = [
  { providerId: 'demo-provider', providerName: 'Demo Provider', id: 'demo-chat' },
  { providerId: 'demo-provider', providerName: 'Demo Provider', id: 'demo-mini' },
];
const USAGE = {
  totalRequests: 128,
  totalInputTokens: 45231,
  totalOutputTokens: 18903,
  byProvider: [
    { providerId: 'demo-provider', requests: 128, inputTokens: 45231, outputTokens: 18903 },
  ],
};
const HISTORY = [
  { role: 'user', content: '帮我看一下项目结构，顺便读一下 README.md 的前几行。' },
  {
    role: 'assistant',
    content:
      '项目是一个 pnpm workspace，前端、服务端与共享类型分开存放。\n\n```text\napps/web      前端工作台\napps/server   WebSocket 服务\npackages/     共享包（protocol / kernel / tools 等）\n```\n\nREADME 里说明用 `pnpm dev` 同时启动前后端。',
    toolCalls: [
      { id: 'c1', name: 'read_file', input: { path: 'README.md', limit: 40 } },
      { id: 'c2', name: 'run_command', input: { command: 'git status --short' } },
    ],
  },
  {
    role: 'tool',
    content: '# WitCode\n\nWeb 优先的 Coding Harness。\n\n启动：pnpm dev',
    toolCallId: 'c1',
    toolName: 'read_file',
  },
  {
    role: 'tool',
    content: 'ERROR: not a git repository',
    toolCallId: 'c2',
    toolName: 'run_command',
  },
  { role: 'user', content: '工具调用能收成一行吗？我想点开再看参数。' },
  {
    role: 'assistant',
    content:
      '可以。工具调用在消息流里显示为一行内联摘要，点开后才展开参数与结果；助手正文保持全宽、无气泡、无头像，只有用户消息是右对齐气泡。',
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('pageerror', (error) => console.error('[pageerror]', error.message));

await page.routeWebSocket(/ws:\/\/localhost:8787/, (ws) => {
  ws.onMessage((message) => {
    let data;
    try {
      data = JSON.parse(typeof message === 'string' ? message : message.text());
    } catch {
      return;
    }
    if (data.type === 'providers:list') {
      ws.send(JSON.stringify({ type: 'providers', items: PROVIDERS }));
    }
    if (data.type === 'usage:list') {
      ws.send(JSON.stringify({ type: 'usage', items: [], summary: USAGE }));
    }
    if (data.type === 'list-sessions') {
      ws.send(JSON.stringify({ type: 'sessions', items: SESSIONS }));
    }
  });
  ws.send(JSON.stringify({ type: 'ready', sessionId: SESSION_ID, model: 'demo-chat' }));
  ws.send(JSON.stringify({ type: 'sessions', items: SESSIONS }));
  ws.send(JSON.stringify({ type: 'history', sessionId: SESSION_ID, messages: HISTORY }));
  ws.send(JSON.stringify({ type: 'models', items: MODELS }));
  ws.send(
    JSON.stringify({
      type: 'selection',
      selection: { providerId: 'demo-provider', model: 'demo-chat' },
    }),
  );
});

const fail = (message) => {
  throw new Error(`[check failed] ${message}`);
};

const metrics = () =>
  page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.getBoundingClientRect() : null;
    };
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      topbarHeight: rect('.topbar')?.height ?? 0,
      sidebarWidth: rect('.sidebar')?.width ?? 0,
      messagesWidth: rect('.messages')?.width ?? 0,
      assistantWidth: rect('.msg-row.assistant')?.width ?? 0,
      toolHeight: rect('.tool-summary')?.height ?? 0,
      bubbleWidth: rect('.bubble.user')?.width ?? 0,
    };
  });

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

try {
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.msg-row.assistant', { timeout: 15000 });
  await page.waitForSelector('.tool-summary', { timeout: 15000 });
  await page.waitForTimeout(500);

  const desktop = await metrics();
  console.log('[metrics:1440]', JSON.stringify(desktop));
  if (desktop.scrollWidth > desktop.innerWidth) fail('1440 出现横向溢出');
  if (desktop.bodyScrollWidth > desktop.innerWidth) fail('1440 body 出现横向溢出');
  if (desktop.topbarHeight !== 48) fail(`顶栏高度应为 48，实际 ${desktop.topbarHeight}`);
  if (desktop.sidebarWidth !== 264) fail(`左栏应为 264，实际 ${desktop.sidebarWidth}`);
  if (desktop.assistantWidth < desktop.messagesWidth * 0.85) fail('助手消息未全宽');
  if (desktop.toolHeight > 36) fail(`工具摘要行应单行（<=36px），实际 ${desktop.toolHeight}`);
  await shot('01-home-1440.png');

  await page.click('.topbar-right button[aria-label="设置"]');
  await page.waitForSelector('.settings-overlay', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.click('.settings-nav-item:has-text("模型")');
  await page.waitForSelector('.settings-subtabs', { timeout: 5000 });
  await page.waitForTimeout(200);
  await shot('02-settings-1440.png');
  const settings = await metrics();
  console.log('[metrics:settings]', JSON.stringify(settings));
  if (settings.scrollWidth > settings.innerWidth) fail('设置页出现横向溢出');

  await page.click('.settings-back');
  await page.waitForSelector('.msg-row.assistant', { timeout: 5000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobile = await metrics();
  console.log('[metrics:390]', JSON.stringify(mobile));
  if (mobile.scrollWidth > mobile.innerWidth) fail('390 出现横向溢出');
  if (mobile.messagesWidth < 340) fail(`390 消息区宽度应 >=340，实际 ${mobile.messagesWidth}`);
  await shot('03-chat-390.png');

  console.log('[done] 3 张截图 ->', OUT);
} finally {
  await browser.close();
}
