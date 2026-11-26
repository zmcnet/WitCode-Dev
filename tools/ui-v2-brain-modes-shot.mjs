// 临时视觉验收脚本：mock brains（official + 15 个脑子），截分组下拉与设置页 Brains 分组。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-brain-modes-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-session-01';
const OFFICIAL = ['coding', 'standard', 'profession'];
const SUBTITLES = [
  '编码专精：先读再改、小步验证',
  '全能：规划、执行、交付',
  '专业严谨：证据优先、边界优先',
];
const BRAINS = [
  { id: 'coding', name: 'Coding 编码脑', description: '编码专精：先读再改、最小改动、改完即验。', bestFor: ['代码编辑', '小步改动', '工程实现'] },
  { id: 'standard', name: 'Standard 全能脑', description: '融合十二脑的全能工作法：规划到交付。', bestFor: ['通用任务', '长任务续轮', '规划到交付'] },
  { id: 'profession', name: 'Profession 严谨脑', description: '专业严谨：证据优先、边界优先。', bestFor: ['严格审批场景', '代码审查', '高风险交付'] },
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

const fail = (message) => {
  throw new Error(`[check failed] ${message}`);
};

const browser = await chromium.launch();

async function mockPage(withOfficial) {
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
        ws.send(JSON.stringify({
          type: 'brains',
          items: BRAINS,
          active: 'standard',
          ...(withOfficial ? { official: OFFICIAL } : {}),
        }));
      }
      if (data.type === 'brain:select') {
        const brain = BRAINS.find((item) => item.id === data.brainId);
        if (brain) ws.send(JSON.stringify({ type: 'brain', brain }));
      }
      if (data.type === 'providers:list') ws.send(JSON.stringify({ type: 'providers', items: [] }));
      if (data.type === 'usage:list') ws.send(JSON.stringify({ type: 'usage', items: [], summary: null }));
    });
    ws.send(JSON.stringify({ type: 'ready', sessionId: SESSION_ID, model: 'demo-chat', brain: 'standard' }));
    ws.send(JSON.stringify({ type: 'models', items: [] }));
    ws.send(JSON.stringify({ type: 'sessions', items: [{ id: SESSION_ID, title: '脑子模式分组', updatedAt: Date.now() }] }));
    ws.send(JSON.stringify({
      type: 'brains',
      items: BRAINS,
      active: 'standard',
      ...(withOfficial ? { official: OFFICIAL } : {}),
    }));
  });
  return page;
}

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

try {
  const page = await mockPage(true);
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.brain-selector-button', { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector('.brain-selector-label')?.textContent === 'Standard 全能脑',
    { timeout: 10000 },
  );

  await page.click('.brain-selector-button');
  await page.waitForSelector('.brain-menu', { timeout: 5000 });
  const titles = await page.locator('.brain-menu-title').allTextContents();
  if (JSON.stringify(titles) !== JSON.stringify(['模式', '自定义'])) fail(`下拉分组标题不符：${titles}`);
  if ((await page.locator('.brain-menu-sep').count()) !== 1) fail('缺少分组分隔线');
  if ((await page.locator('.brain-menu-item').count()) !== 15) fail('下拉应共 15 项');
  const officialNames = await page.locator('.brain-menu-item').evaluateAll((nodes) =>
    nodes.slice(0, 3).map((node) => node.querySelector('.brain-menu-name')?.textContent),
  );
  if (JSON.stringify(officialNames) !== JSON.stringify(['Coding 编码脑', 'Standard 全能脑', 'Profession 严谨脑'])) {
    fail(`官方模式顺序不符：${officialNames}`);
  }
  const subtitles = await page.locator('.brain-menu-item').evaluateAll((nodes) =>
    nodes.slice(0, 3).map((node) => node.querySelector('.brain-menu-desc')?.textContent),
  );
  if (JSON.stringify(subtitles) !== JSON.stringify(SUBTITLES)) fail(`官方副标题不符：${subtitles}`);
  const checkedIndex = await page.locator('.brain-menu-item').evaluateAll((nodes) =>
    nodes.findIndex((node) => node.getAttribute('aria-checked') === 'true'),
  );
  if (checkedIndex !== 1) fail(`当前项应在官方段第 2 位，实际 ${checkedIndex}`);
  const overflow1 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow1 > 0) fail(`首页横向溢出 ${overflow1}px`);
  await page.waitForTimeout(300);
  await shot(page, '10-brain-modes-dropdown-1440.png');

  await page.keyboard.press('Escape');
  await page.waitForSelector('.brain-menu', { state: 'detached', timeout: 5000 });
  await page.click('.topbar-right button[aria-label="设置"]');
  await page.waitForSelector('.settings-overlay', { timeout: 5000 });
  await page.click('.settings-nav-item:has-text("Brains")');
  await page.waitForSelector('.brain-official-grid', { timeout: 5000 });
  const groupTitles = await page.locator('.brain-group-title').allTextContents();
  if (JSON.stringify(groupTitles) !== JSON.stringify(['官方模式', '参照大脑'])) fail(`设置页分组标题不符：${groupTitles}`);
  if ((await page.locator('.brain-official-grid .brain-card').count()) !== 3) fail('官方模式应有 3 张卡');
  if ((await page.locator('.brain-list .brain-card').count()) !== 12) fail('参照大脑应有 12 张卡');
  const activeOfficial = await page.locator('.brain-official-grid .brain-card.active .brain-card-name').textContent();
  if (activeOfficial !== 'Standard 全能脑') fail(`当前卡应在官方段：${activeOfficial}`);
  const cardSubtitles = await page.locator('.brain-official-grid .brain-card-desc').allTextContents();
  if (JSON.stringify(cardSubtitles) !== JSON.stringify(SUBTITLES)) fail(`卡片副标题不符：${cardSubtitles}`);
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow2 > 0) fail(`设置页横向溢出 ${overflow2}px`);
  await page.waitForTimeout(300);
  await shot(page, '11-settings-brain-modes-1440.png');

  // 当前切到参照脑时：勾选与高亮都落在「自定义」段。
  await page.click('.settings-back');
  await page.waitForSelector('.composer-wrap', { timeout: 5000 });
  await page.click('.brain-selector-button');
  await page.waitForSelector('.brain-menu', { timeout: 5000 });
  await page.click('.brain-menu-item:has-text("ZCode 工程脑")');
  await page.waitForSelector('.brain-menu', { state: 'detached', timeout: 5000 });
  await page.click('.brain-selector-button');
  await page.waitForSelector('.brain-menu', { timeout: 5000 });
  const checkInfo = await page.locator('.brain-menu-item').evaluateAll((nodes) => {
    const index = nodes.findIndex((node) => node.getAttribute('aria-checked') === 'true');
    return { index, hasCheck: Boolean(nodes[index]?.querySelector('.brain-menu-check')) };
  });
  if (checkInfo.index < 3 || !checkInfo.hasCheck) fail(`参照脑应在自定义段打勾：${JSON.stringify(checkInfo)}`);
  console.log('[reference-brain:dropdown]', JSON.stringify(checkInfo));
  await page.keyboard.press('Escape');
  await page.click('.topbar-right button[aria-label="设置"]');
  await page.waitForSelector('.settings-overlay', { timeout: 5000 });
  await page.click('.settings-nav-item:has-text("Brains")');
  await page.waitForSelector('.brain-official-grid', { timeout: 5000 });
  const customActive = await page.locator('.brain-list .brain-card.active .brain-card-name').textContent();
  if (customActive !== 'ZCode 工程脑') fail(`参照脑应在参照大脑段高亮：${customActive}`);
  if ((await page.locator('.brain-official-grid .brain-card.active').count()) !== 0) {
    fail('参照脑不应在官方段高亮');
  }
  console.log('[reference-brain:settings]', customActive);

  // official 缺失时降级为单列表，不崩。
  const fallback = await mockPage(false);
  await fallback.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await fallback.waitForSelector('.brain-selector-button', { timeout: 15000 });
  await fallback.click('.brain-selector-button');
  await fallback.waitForSelector('.brain-menu', { timeout: 5000 });
  const fallbackTitles = await fallback.locator('.brain-menu-title').allTextContents();
  if (JSON.stringify(fallbackTitles) !== JSON.stringify(['切换脑子'])) fail(`降级标题不符：${fallbackTitles}`);
  if ((await fallback.locator('.brain-menu-item').count()) !== 15) fail('降级应仍显示 15 项');
  if ((await fallback.locator('.brain-menu-sep').count()) !== 0) fail('降级不应有分组分隔线');
  await fallback.keyboard.press('Escape');
  await fallback.click('.topbar-right button[aria-label="设置"]');
  await fallback.waitForSelector('.settings-overlay', { timeout: 5000 });
  await fallback.click('.settings-nav-item:has-text("Brains")');
  await fallback.waitForSelector('.brain-list', { timeout: 5000 });
  if ((await fallback.locator('.brain-group-title').count()) !== 0) fail('降级不应有分组标题');
  if ((await fallback.locator('.brain-card').count()) !== 15) fail('降级应显示 15 张卡');
  console.log('[fallback] official 缺失 -> 单列表 15 项');
  await fallback.close();
  await page.close();

  console.log('[done] 2 张截图 ->', OUT);
} finally {
  await browser.close();
}
