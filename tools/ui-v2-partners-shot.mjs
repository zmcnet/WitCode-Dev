// 视觉验收脚本：mock partners / brains / models，截伙伴面板与设置页伙伴分区 1440。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-partners-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-partners-01';
const fail = (message) => {
  throw new Error(`[check failed] ${message}`);
};

const BRAINS = [
  { id: 'profession', name: 'Profession', description: '证据优先、边界优先', bestFor: [] },
  { id: 'coding', name: 'Codex', description: '最小改动、改完即验', bestFor: [] },
];
const MODELS = [
  { providerId: 'p-zhipu', providerName: 'Zhipu', id: 'glm-5' },
  { providerId: 'p-openai', providerName: 'OpenAI', id: 'gpt-6' },
];
const PARTNERS = [
  { slot: 1, enabled: true, brainId: 'profession', model: { providerId: 'p-zhipu', model: 'glm-5' } },
  { slot: 2, enabled: false, brainId: 'coding', model: { providerId: 'p-openai', model: 'gpt-6' } },
];
const HISTORY = [
  { role: 'user', content: '帮我看看缓存方案有没有边界问题，顺手补一下测试。' },
  { role: 'assistant', content: '我先梳理现有实现，再把方案交给伙伴做一轮独立审查。' },
];

const browser = await chromium.launch();

async function mockPage({ partnerConfigs = PARTNERS, events = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));

  let partners = partnerConfigs.map((item) => ({ ...item }));
  const sent = [];
  await page.routeWebSocket(/ws:\/\/localhost:21004\/ws/, (ws) => {
    const replyPartners = () => ws.send(JSON.stringify({ type: 'partners', items: partners }));
    ws.onMessage((message) => {
      let data;
      try {
        data = JSON.parse(typeof message === 'string' ? message : message.text());
      } catch {
        return;
      }
      sent.push(data);
      if (data.type === 'providers:list') ws.send(JSON.stringify({ type: 'providers', items: [] }));
      if (data.type === 'usage:list') {
        ws.send(JSON.stringify({ type: 'usage', items: [], summary: null }));
      }
      if (data.type === 'brains:list') {
        ws.send(JSON.stringify({ type: 'brains', items: BRAINS, active: 'profession', official: ['profession', 'coding'] }));
      }
      if (data.type === 'partners:list') replyPartners();
      if (data.type === 'partners:set') {
        partners = partners.map((item) => (item.slot === data.partner.slot ? data.partner : item));
        replyPartners();
      }
    });
    ws.send(JSON.stringify({
      type: 'ready',
      sessionId: SESSION_ID,
      model: 'glm-5',
      brain: 'profession',
      permission: 'normal',
    }));
    ws.send(JSON.stringify({ type: 'sessions', items: [{ id: SESSION_ID, title: '伙伴槽位验收', updatedAt: Date.now() }] }));
    ws.send(JSON.stringify({ type: 'models', items: MODELS }));
    ws.send(JSON.stringify({ type: 'history', sessionId: SESSION_ID, messages: HISTORY }));
    for (const event of events) ws.send(JSON.stringify(event));
    replyPartners();
  });
  return { page, sent: () => sent };
}

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 0) fail(`${label} 横向溢出 ${overflow}px`);
}

try {
  // ---- 14：输入区伙伴面板 ----
  const { page, sent } = await mockPage();
  await page.goto('http://localhost:21004', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.partner-slot-button', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.partner-slot-button')?.textContent?.includes('伙伴 1/2'),
    { timeout: 15000 },
  );
  if (!sent().some((item) => item.type === 'partners:list')) fail('连接后未请求 partners:list');

  await page.click('.partner-slot-button');
  await page.waitForSelector('.partner-panel', { timeout: 5000 });
  const rows = page.locator('.partner-slot-row');
  if ((await rows.count()) !== 2) fail(`面板应有两行，实际 ${await rows.count()}`);
  const checks = await page.locator('.partner-enable input').evaluateAll(
    (items) => items.map((item) => item.checked),
  );
  if (checks.join(',') !== 'true,false') fail(`勾选状态不符：${checks.join(',')}`);
  const brainLabels = await page.locator('.partner-brain .partner-select-label').allTextContents();
  const modelLabels = await page.locator('.partner-model .partner-select-label').allTextContents();
  if (brainLabels.join(',') !== 'Profession,Codex') fail(`脑子标签不符：${brainLabels.join(',')}`);
  if (modelLabels.join(',') !== 'glm-5,gpt-6') fail(`模型标签不符：${modelLabels.join(',')}`);
  if (await page.locator('.partner-panel-hint').count()) fail('启用伙伴时不应显示禁用提示');

  // 模型下拉用的是 mock 的 models 列表。
  await page.locator('.partner-model .partner-select-button').first().click();
  const modelItems = await page.locator('.partner-model .partner-select-item').allTextContents();
  if (!modelItems.some((text) => text.includes('跟随主模型'))) fail('模型下拉缺少跟随主模型');
  if (!modelItems.some((text) => text.includes('Zhipu / glm-5'))) fail('模型下拉缺少 glm-5');
  if (!modelItems.some((text) => text.includes('OpenAI / gpt-6'))) fail('模型下拉缺少 gpt-6');
  await page.keyboard.press('Escape');
  if ((await page.locator('.partner-panel').count()) !== 1) fail('Esc 关闭模型菜单时不应关闭整个面板');

  await noOverflow(page, '1440 伙伴面板');
  await page.waitForTimeout(200);
  await shot(page, '14-partners-panel-1440.png');

  // 390 下两行纵向堆叠，且无横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await noOverflow(page, '390 伙伴面板');
  const stacked = await rows.first().evaluate(
    (el) => getComputedStyle(el).flexDirection,
  );
  if (stacked !== 'column') fail(`390 槽位行未纵向堆叠：${stacked}`);

  // 两个都取消勾选时显示提示，并立即发送 partners:set。
  await page.locator('.partner-enable input').first().uncheck();
  await page.waitForSelector('.partner-panel-hint', { timeout: 5000 });
  const hint = await page.locator('.partner-panel-hint').textContent();
  if (!hint?.includes('未启用伙伴，主智能体不会咨询')) fail(`禁用提示不符：${hint}`);
  const setCount = sent().filter((item) => item.type === 'partners:set').length;
  if (setCount < 1) fail('取消勾选未发送 partners:set');
  await page.locator('.partner-enable input').first().check();
  await page.close();

  // ---- 15：设置页伙伴分区 ----
  const settings = await mockPage();
  await settings.page.goto('http://localhost:21004', { waitUntil: 'domcontentloaded' });
  await settings.page.waitForSelector('.partner-slot-button', { timeout: 15000 });
  await settings.page.click('.topbar-right button[aria-label="设置"]');
  await settings.page.waitForSelector('.settings-overlay', { timeout: 5000 });
  await settings.page.click('.settings-nav-item:has-text("伙伴")');
  await settings.page.waitForSelector('.partner-settings-grid', { timeout: 5000 });

  const cards = settings.page.locator('.partner-settings-card');
  if ((await cards.count()) !== 2) fail(`设置页应有两张伙伴卡，实际 ${await cards.count()}`);
  const desc = await settings.page.locator('.settings-panel .panel-desc').textContent();
  if (!desc?.includes('只读、只给建议；最多 2 个')) fail(`分区说明不符：${desc}`);
  const switches = await settings.page.locator('.partner-switch input').evaluateAll(
    (items) => items.map((item) => item.checked),
  );

  if (switches.join(',') !== 'true,false') fail(`设置页开关状态不符：${switches.join(',')}`);
  const cardBrains = await settings.page.locator('.partner-field .partner-select-label').allTextContents();
  if (cardBrains.join(',') !== 'Profession,glm-5,Codex,gpt-6') {
    fail(`设置页脑子/模型不符：${cardBrains.join(',')}`);
  }
  await noOverflow(settings.page, '1440 设置页');
  await settings.page.waitForTimeout(200);
  await shot(settings.page, '15-settings-partners-1440.png');

  await settings.page.setViewportSize({ width: 390, height: 844 });
  await settings.page.waitForTimeout(200);
  await noOverflow(settings.page, '390 设置页');
  const columns = await settings.page.locator('.partner-settings-grid').evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns,
  );
  if (columns.split(' ').length !== 1) fail(`390 设置页卡片未堆叠：${columns}`);
  await settings.page.close();

  // ---- 伙伴卡片标题：槽位 + 脑子 + 模型；无模型时只显示脑子 ----
  const cardPage = await mockPage({
    partnerConfigs: [
      PARTNERS[0],
      { slot: 2, enabled: false, brainId: 'coding' },
    ],
    events: [
      { type: 'partner:start', brainId: 'profession', question: '审查缓存方案' },
      { type: 'partner:start', brainId: 'coding', question: '补充一个对照视角' },
      { type: 'partner:done', brainId: 'profession', answer: '注意缓存键隔离' },
      { type: 'partner:done', brainId: 'coding', answer: '补充边界条件' },
    ],
  });
  await cardPage.page.goto('http://localhost:21004', { waitUntil: 'domcontentloaded' });
  await cardPage.page.waitForFunction(
    () => document.querySelectorAll('.collab-card.partner').length === 2,
    { timeout: 15000 },
  );
  const titles = await cardPage.page.locator('.collab-card.partner .collab-title').allTextContents();
  if (titles.join(' | ') !== '伙伴 1 · Profession / glm-5 | 伙伴 2 · Codex') {
    fail(`伙伴卡片标题不符：${titles.join(' | ')}`);
  }
  await cardPage.page.close();

  console.log('[done] 2 张截图 ->', OUT);
} finally {
  await browser.close();
}
