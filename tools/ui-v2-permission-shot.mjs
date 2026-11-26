// 临时视觉验收脚本：mock WebSocket 注入 permission 消息，截权限下拉与设置页通用 tab 权限行。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-permission-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-session-01';
const INITIAL_MODE = 'normal';
const PROVIDERS = [
  {
    id: 'demo-provider',
    name: 'Demo Provider',
    baseUrl: 'https://api.example.com/v1',
    modelIds: ['demo-chat'],
    enabled: true,
    hasApiKey: true,
    apiKeyHint: 'sk-…a1b2',
  },
];
const MODELS = [
  { providerId: 'demo-provider', providerName: 'Demo Provider', id: 'demo-chat' },
];
const USAGE = {
  totalRequests: 42,
  totalInputTokens: 12000,
  totalOutputTokens: 4300,
  byProvider: [],
};
const HISTORY = [
  { role: 'user', content: '帮我确认一下当前的权限模式。' },
  { role: 'assistant', content: '当前是普通模式：使用原生工具，危险动作会先询问确认。' },
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
    if (data.type === 'permission:set') {
      ws.send(JSON.stringify({ type: 'permission', mode: data.mode }));
    }
    if (data.type === 'providers:list') {
      ws.send(JSON.stringify({ type: 'providers', items: PROVIDERS }));
    }
    if (data.type === 'usage:list') {
      ws.send(JSON.stringify({ type: 'usage', items: [], summary: USAGE }));
    }
    if (data.type === 'brains:list') {
      ws.send(JSON.stringify({ type: 'brains', items: [], active: '' }));
    }
  });
  ws.send(JSON.stringify({ type: 'ready', sessionId: SESSION_ID, model: 'demo-chat', permission: INITIAL_MODE }));
  ws.send(JSON.stringify({ type: 'permission', mode: INITIAL_MODE }));
  ws.send(JSON.stringify({ type: 'models', items: MODELS }));
  ws.send(JSON.stringify({ type: 'selection', selection: { providerId: 'demo-provider', model: 'demo-chat' } }));
  ws.send(JSON.stringify({ type: 'sessions', items: [{ id: SESSION_ID, title: '权限模式演示', updatedAt: Date.now() }] }));
  ws.send(JSON.stringify({ type: 'history', sessionId: SESSION_ID, messages: HISTORY }));
});

const fail = (message) => {
  throw new Error(`[check failed] ${message}`);
};

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

try {
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.permission-selector-button', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.permission-selector-label')?.textContent === '普通',
    { timeout: 10000 },
  );
  await page.waitForTimeout(400);

  const homeOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (homeOverflow > 0) fail(`首页横向溢出 ${homeOverflow}px`);
  console.log('[permission:button]', await page.locator('.permission-selector-button').getAttribute('aria-label'));

  await page.click('.permission-selector-button');
  await page.waitForSelector('.permission-menu', { timeout: 5000 });
  const itemCount = await page.locator('.permission-menu-item').count();
  if (itemCount !== 4) fail(`下拉应有 4 个模式，实际 ${itemCount}`);
  const checked = await page.locator('.permission-menu-item[aria-checked="true"] .permission-menu-name').textContent();
  if (checked !== '普通') fail(`当前项应为普通，实际 ${checked}`);
  const descCount = await page.locator('.permission-menu-item .permission-menu-desc').count();
  if (descCount !== 4) fail(`4 个模式都应带说明，实际 ${descCount}`);
  await page.waitForTimeout(250);
  await shot('06-permission-dropdown-1440.png');

  await page.keyboard.press('Escape');
  await page.waitForSelector('.permission-menu', { state: 'detached', timeout: 5000 });
  const focusLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  console.log('[permission:focus-after-esc]', focusLabel);
  if (!focusLabel?.includes('权限模式')) fail('Esc 关闭后焦点未回到权限按钮');

  await page.click('.topbar-right button[aria-label="设置"]');
  await page.waitForSelector('.settings-overlay', { timeout: 5000 });
  await page.click('.settings-nav-item:has-text("通用")');
  await page.waitForSelector('.permission-pref', { timeout: 5000 });
  const optionCount = await page.locator('.permission-option').count();
  if (optionCount !== 4) fail(`设置页应有 4 个模式，实际 ${optionCount}`);
  const activeCount = await page.locator('.permission-option.active').count();
  if (activeCount !== 1) fail(`设置页应只有 1 个当前模式，实际 ${activeCount}`);
  const desc = await page.locator('.permission-pref-desc').textContent();
  if (!desc?.includes('危险动作先询问')) fail('设置页缺少当前模式说明');
  const settingsOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (settingsOverflow > 0) fail(`设置页横向溢出 ${settingsOverflow}px`);
  await page.waitForTimeout(250);
  await shot('07-settings-permission-1440.png');

  await page.click('.permission-option:has-text("自主")');
  await page.waitForFunction(
    () => document.querySelector('.permission-pref-current')?.textContent === '自主',
    { timeout: 5000 },
  );
  await page.click('.settings-back');
  await page.waitForSelector('.composer-wrap', { timeout: 5000 });
  const synced = await page.locator('.permission-selector-label').textContent();
  console.log('[permission:synced]', synced);
  if (synced !== '自主') fail(`设置页切换后输入区未同步，实际 ${synced}`);

  console.log('[done] 2 张截图 ->', OUT);
} finally {
  await browser.close();
}
