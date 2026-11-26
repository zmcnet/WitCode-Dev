// 临时视觉验收脚本：mock 12 个脑子（active=zcode），截 Brain 下拉与设置页 Brains 列表。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-brain-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-session-01';
const BRAINS = [
  { id: 'native', name: '原生工程脑', description: '遵循仓库现有约定，最小化改动', bestFor: ['保守改动', '存量项目'] },
  { id: 'zcode', name: 'ZCode 工程脑', description: '任务拆解清晰，工具调用稳健', bestFor: ['复杂重构', '多步任务', '类型安全'] },
  { id: 'dsh', name: 'DSH 产品脑', description: '从产品视角审视体验与信息架构', bestFor: ['需求分析', '交互设计'] },
  { id: 'opencode', name: 'OpenCode 开源脑', description: '开源社区风格，偏好可读实现', bestFor: ['代码评审', '文档'] },
  { id: 'pi', name: 'Pi 极简脑', description: '极简推理，快速给出结论', bestFor: ['快速问答', '短任务'] },
  { id: 'cline', name: 'Cline 协作脑', description: '逐步确认，强调人类审阅', bestFor: ['高风险改动', '结对编程'] },
  { id: 'codex', name: 'Codex 代码脑', description: '代码优先，重视测试与类型', bestFor: ['单元测试', '类型修复'] },
  { id: 'goose', name: 'Goose 探索脑', description: '广泛搜索，擅长陌生代码库', bestFor: ['代码考古', '定位问题'] },
  { id: 'herdr', name: 'Herdr 牧群脑', description: '并行调度，适合多代理协作', bestFor: ['并行任务', '大批量改动'] },
  { id: 'hermes', name: 'Hermes 信使脑', description: '擅长总结、沟通与文档', bestFor: ['周报', '技术写作'] },
  { id: 'autogpt', name: 'AutoGPT 自治脑', description: '自主规划长任务，持续自检', bestFor: ['长链路任务', '自动验收'] },
  { id: 'openclaw', name: 'OpenClaw 爪脑', description: '激进重构，善于清理技术债', bestFor: ['重构', '依赖升级'] },
];
const ACTIVE = 'zcode';
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
  { role: 'user', content: '帮我把这个模块改成可配置的。' },
  { role: 'assistant', content: '可以。我先确认现有配置入口，再给出最小改动方案。' },
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
    if (data.type === 'brains:list') {
      ws.send(JSON.stringify({ type: 'brains', items: BRAINS, active: ACTIVE }));
    }
    if (data.type === 'brain:select') {
      const brain = BRAINS.find((item) => item.id === data.brainId);
      if (brain) ws.send(JSON.stringify({ type: 'brain', brain }));
    }
    if (data.type === 'providers:list') {
      ws.send(JSON.stringify({ type: 'providers', items: PROVIDERS }));
    }
    if (data.type === 'usage:list') {
      ws.send(JSON.stringify({ type: 'usage', items: [], summary: USAGE }));
    }
  });
  ws.send(JSON.stringify({ type: 'ready', sessionId: SESSION_ID, model: 'demo-chat', brain: ACTIVE }));
  ws.send(JSON.stringify({ type: 'brains', items: BRAINS, active: ACTIVE }));
  ws.send(JSON.stringify({ type: 'models', items: MODELS }));
  ws.send(JSON.stringify({ type: 'selection', selection: { providerId: 'demo-provider', model: 'demo-chat' } }));
  ws.send(JSON.stringify({ type: 'sessions', items: [{ id: SESSION_ID, title: '模块配置化', updatedAt: Date.now() }] }));
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
  await page.waitForSelector('.brain-selector-button', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.brain-selector-label')?.textContent?.includes('ZCode'),
    { timeout: 10000 },
  );
  await page.waitForTimeout(400);

  const homeOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (homeOverflow > 0) fail(`首页横向溢出 ${homeOverflow}px`);
  console.log('[brain:topbar]', await page.locator('.topbar-brain').textContent());
  console.log('[brain:composer]', await page.locator('.brain-selector-label').textContent());

  await page.click('.brain-selector-button');
  await page.waitForSelector('.brain-menu', { timeout: 5000 });
  const itemCount = await page.locator('.brain-menu-item').count();
  if (itemCount !== 12) fail(`下拉应有 12 个脑子，实际 ${itemCount}`);
  const checked = await page.locator('.brain-menu-item[aria-checked="true"] .brain-menu-name').textContent();
  if (checked !== 'ZCode 工程脑') fail(`当前项应为 ZCode 工程脑，实际 ${checked}`);
  await page.waitForTimeout(250);
  await shot('04-brain-dropdown-1440.png');

  await page.keyboard.press('Escape');
  await page.waitForSelector('.brain-menu', { state: 'detached', timeout: 5000 });
  const focusLabel = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  console.log('[brain:focus-after-esc]', focusLabel);

  await page.click('.topbar-right button[aria-label="设置"]');
  await page.waitForSelector('.settings-overlay', { timeout: 5000 });
  await page.click('.settings-nav-item:has-text("Brains")');
  await page.waitForSelector('.brain-list', { timeout: 5000 });
  const cardCount = await page.locator('.brain-card').count();
  if (cardCount !== 12) fail(`Brains 列表应有 12 张卡，实际 ${cardCount}`);
  const activeCards = await page.locator('.brain-card.active').count();
  if (activeCards !== 1) fail(`应只有 1 个当前脑子标记，实际 ${activeCards}`);
  const desc = await page.locator('.panel-desc').first().textContent();
  if (!desc?.includes('换脑子不换身体')) fail('缺少说明文案');
  const settingsOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (settingsOverflow > 0) fail(`设置页横向溢出 ${settingsOverflow}px`);
  await page.waitForTimeout(250);
  await shot('05-settings-brains-1440.png');

  await page.click('.brain-card:has-text("Codex 代码脑")');
  await page.waitForFunction(
    () => document.querySelector('.brain-card.active .brain-card-name')?.textContent === 'Codex 代码脑',
    { timeout: 5000 },
  );
  await page.click('.settings-back');
  await page.waitForSelector('.composer-wrap', { timeout: 5000 });
  const syncedTopbar = await page.locator('.topbar-brain').textContent();
  const syncedComposer = await page.locator('.brain-selector-label').textContent();
  console.log('[brain:synced]', syncedTopbar, '/', syncedComposer);
  if (!syncedTopbar?.includes('Codex') || !syncedComposer?.includes('Codex')) {
    fail('设置页切换脑子后，顶栏或输入区未同步');
  }

  console.log('[done] 2 张截图 ->', OUT);
} finally {
  await browser.close();
}
