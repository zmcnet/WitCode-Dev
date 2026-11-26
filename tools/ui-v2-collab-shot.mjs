// 临时视觉验收脚本：mock 伙伴 / 子智能体事件，截协作卡片 1440。
// 用法：先启动 `pnpm --filter @witcode/web dev`，再运行 `node tools/ui-v2-collab-shot.mjs`。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots/ui-v2');
mkdirSync(OUT, { recursive: true });

const SESSION_ID = 'demo-collab-01';
const fail = (message) => {
  throw new Error(`[check failed] ${message}`);
};

const PARTNER_HISTORY = [
  { role: 'user', content: '帮我审查一下缓存方案，顺手把测试补上。' },
  { role: 'assistant', content: '我先把方案交给伙伴看看，再安排执行。' },
];
const SUBAGENT_HISTORY = [
  { role: 'user', content: '把这次改动补上测试，再跑一遍 lint。' },
  { role: 'assistant', content: '我派两个子智能体分头处理。' },
];

const browser = await chromium.launch();

async function mockPage(events) {
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
      if (data.type === 'providers:list') ws.send(JSON.stringify({ type: 'providers', items: [] }));
      if (data.type === 'usage:list') {
        ws.send(JSON.stringify({ type: 'usage', items: [], summary: null }));
      }
      if (data.type === 'brains:list') {
        ws.send(JSON.stringify({ type: 'brains', items: [], active: '' }));
      }
    });
    ws.send(JSON.stringify({
      type: 'ready',
      sessionId: SESSION_ID,
      model: 'demo-chat',
      permission: 'normal',
    }));
    ws.send(JSON.stringify({ type: 'models', items: [] }));
    ws.send(JSON.stringify({
      type: 'sessions',
      items: [{ id: SESSION_ID, title: '协作卡片验收', updatedAt: Date.now() }],
    }));
    ws.send(JSON.stringify({ type: 'history', sessionId: SESSION_ID, messages: events.history }));
    for (const event of events.messages) {
      ws.send(JSON.stringify(event));
    }
  });
  return page;
}

async function shot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log(`[shot] ${file}`);
}

async function checkNarrow(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    card: document.querySelector('.collab-card')?.getBoundingClientRect().width ?? 0,
  }));
  if (metrics.overflow > 0) fail(`390 横向溢出 ${metrics.overflow}px`);
  if (metrics.card > 390) fail(`390 下卡片过宽：${metrics.card}px`);
  console.log('[narrow]', metrics);
}

async function checkWidth(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 0) fail(`1440 横向溢出 ${overflow}px`);
  const widths = await page.evaluate(() => ({
    card: document.querySelector('.collab-card')?.getBoundingClientRect().width ?? 0,
    column: document.querySelector('.assistant-text')?.getBoundingClientRect().width ?? 0,
  }));
  if (Math.abs(widths.card - widths.column) > 1) {
    fail(`卡片宽度与消息列不一致：${widths.card} vs ${widths.column}`);
  }
  console.log('[card-width]', widths);
}

try {
  // ---- 伙伴卡片 ----
  const partnerPage = await mockPage({
    history: PARTNER_HISTORY,
    messages: [
      {
        type: 'partner:start',
        brainId: 'profession',
        question: '从边界条件和错误处理角度审查这个缓存方案，指出容易被忽略的风险。',
      },
      {
        type: 'partner:done',
        brainId: 'profession',
        answer: [
          '主要风险有三点：',
          '1. 缓存键未包含权限维度，跨租户命中会泄露数据。',
          '2. 过期时间固定 10 分钟，热点 key 在刷新窗口有击穿风险。',
          '3. 降级路径直接返回空值，建议保留上一次有效结果并标记 stale。',
          '',
          '整体方案可行，但上线前至少要补齐第 1 点的隔离。',
        ].join('\n'),
      },
      { type: 'delta', text: '伙伴意见已收到，我继续整合。' },
      {
        type: 'partner:start',
        brainId: 'coding',
        question: '有没有更简单的缓存失效实现方式？',
      },
      { type: 'done', text: '', sessionId: SESSION_ID },
    ],
  });
  await partnerPage.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await partnerPage.waitForSelector('.collab-card.partner', { timeout: 15000 });
  await partnerPage.waitForFunction(
    () => document.querySelectorAll('.collab-card.partner').length === 2,
    { timeout: 15000 },
  );

  const partnerTitles = await partnerPage.locator('.collab-card.partner .collab-title').allTextContents();
  if (!partnerTitles[0]?.includes('伙伴 1 · profession')) fail(`伙伴标题不符：${partnerTitles[0]}`);
  const statuses = await partnerPage.locator('.collab-card.partner .collab-status').allTextContents();
  if (statuses[0]?.trim() !== '已完成' || statuses[1]?.trim() !== '咨询中') {
    fail(`伙伴状态不符：${statuses.join(' / ')}`);
  }
  if (!(await partnerPage.locator('.collab-card.partner.running').count())) fail('缺少运行中的伙伴卡片');
  if (!(await partnerPage.locator('.collab-card.partner.running').textContent())?.includes('正在思考…')) {
    fail('运行中伙伴未显示“正在思考…”');
  }
  const questionOpen = await partnerPage.locator('.collab-card.partner').first().locator('.collab-fold').first().evaluate(
    (el) => el.open,
  );
  if (questionOpen) fail('问题默认不应展开');

  // 展开回答全文后再截图，验证“完成后可展开”。
  await partnerPage.locator('.collab-card.partner').first()
    .locator('.collab-fold.answer summary').click();
  const answer = await partnerPage.locator('.collab-card.partner').first().locator('.fold-body').last().textContent();
  if (!answer?.includes('跨租户命中')) fail('展开后未看到完整回答');

  const feedOrder = await partnerPage.evaluate(() =>
    [...document.querySelectorAll('.message-list > .msg-row')].map((el) => {
      const label = el.querySelector('.collab-title')?.textContent?.trim()
        ?? (el.classList.contains('user') ? 'user' : 'assistant');
      return `${label}#${el.getAttribute('data-order')}`;
    }),
  );
  console.log('[partner:feed-order]', feedOrder);
  if (!feedOrder[0]?.startsWith('user') || !feedOrder[1]?.startsWith('assistant')) fail('消息顺序异常');
  if (!feedOrder[2]?.startsWith('伙伴 · profession')) fail('伙伴卡片未排在首条助手消息之后');
  if (!feedOrder[3]?.startsWith('assistant') || !feedOrder[4]?.startsWith('伙伴 · coding')) {
    fail('卡片未按到达顺序与消息并列');
  }
  await checkWidth(partnerPage);
  await partnerPage.waitForTimeout(200);
  await shot(partnerPage, '12-partner-card-1440.png');
  await checkNarrow(partnerPage);

  // ---- 子智能体卡片 ----
  const subagentPage = await mockPage({
    history: SUBAGENT_HISTORY,
    messages: [
      {
        type: 'subagent:start',
        id: 'sub-8f3a21c4',
        task: '为缓存模块补充单元测试，覆盖命中、未命中与过期三条路径。',
      },
      {
        type: 'subagent:done',
        id: 'sub-8f3a21c4',
        status: 'done',
        output: [
          '已新增 cache.test.ts，共 12 个用例全部通过。',
          '- 命中：不调用下游',
          '- 未命中：回源后写入缓存',
          '- 过期：重新拉取并刷新 TTL',
          '',
          'pnpm --filter @witcode/web test 通过。',
        ].join('\n'),
      },
      {
        type: 'subagent:start',
        id: 'sub-b7e19d02',
        task: '运行 lint 并修复本批次改动引入的告警。',
      },
      {
        type: 'subagent:start',
        id: 'sub-cc0491ab',
        task: '把 README 的接入说明同步到最新接口。',
      },
      {
        type: 'subagent:done',
        id: 'sub-cc0491ab',
        status: 'failed',
        output: "执行失败：工作区没有写权限，无法更新 README.md。\nEACCES: permission denied, open 'README.md'",
      },
      { type: 'done', text: '', sessionId: SESSION_ID },
    ],
  });
  await subagentPage.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await subagentPage.waitForFunction(
    () => document.querySelectorAll('.collab-card.subagent').length === 3,
    { timeout: 15000 },
  );

  const subTitles = await subagentPage.locator('.collab-card.subagent .collab-title').allTextContents();
  if (!subTitles[0]?.includes('子智能体 · sub-8f3a')) fail(`子智能体标题不符：${subTitles[0]}`);
  const subStatuses = await subagentPage.locator('.collab-card.subagent .collab-status').allTextContents();
  if (subStatuses.map((item) => item.trim()).join('/') !== '完成/运行中/失败') {
    fail(`子智能体状态不符：${subStatuses.join(' / ')}`);
  }
  const failedColor = await subagentPage.locator('.collab-card.subagent.failed').evaluate(
    (el) => getComputedStyle(el).borderLeftColor,
  );
  if (failedColor !== 'rgb(248, 113, 113)') fail(`失败卡片未用红色：${failedColor}`);
  if (!(await subagentPage.locator('.collab-card.subagent.running').textContent())?.includes('正在执行…')) {
    fail('运行中子智能体未显示“正在执行…”');
  }
  await subagentPage.locator('.collab-card.subagent.done summary').first().click();
  const subOutput = await subagentPage.locator('.collab-card.subagent.done .fold-body').textContent();
  if (!subOutput?.includes('cache.test.ts')) fail('展开后未看到子智能体完整输出');

  await checkWidth(subagentPage);
  await subagentPage.waitForTimeout(200);
  await shot(subagentPage, '13-subagent-card-1440.png');
  await checkNarrow(subagentPage);

  console.log('[done] 2 张截图 ->', OUT);
} finally {
  await browser.close();
}
