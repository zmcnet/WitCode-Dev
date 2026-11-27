/**
 * 设置页视觉验收：逐分区截图 + 主题切换 + 移动端。
 * 用法：node tools/ui-settings-shot.mjs（需服务端在 21004）
 */
import { chromium } from 'playwright';

const BASE = process.env.WITCODE_WEB_URL ?? 'http://127.0.0.1:21004';
const OUT = 'docs/screenshots';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`[console.error] ${message.text()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.getByRole('button', { name: '设置' }).last().click();
await page.waitForTimeout(600);

const TABS = [
  ['常规', 'settings-general'],
  ['外观', 'settings-appearance'],
  ['模型', 'settings-models'],
  ['键盘快捷键', 'settings-shortcuts'],
  ['Brains', 'settings-brains'],
  ['伙伴', 'settings-partners'],
  ['个性化', 'settings-personalization'],
  ['行为与工具', 'settings-behavior'],
  ['记忆', 'settings-memory'],
  ['子智能体', 'settings-subagents'],
  ['自动化', 'settings-automations'],
  ['钩子', 'settings-hooks'],
  ['插件', 'settings-plugins'],
  ['MCP 服务器', 'settings-mcp'],
  ['技能', 'settings-skills'],
  ['命令', 'settings-commands'],
  ['使用统计', 'settings-usage'],
  ['项目管理', 'settings-projects'],
  ['归档管理', 'settings-archive'],
  ['数据', 'settings-data'],
  ['关于', 'settings-about'],
];

for (const [tab, file] of TABS) {
  await page.getByRole('button', { name: tab, exact: true }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${file}.png` });
}

// 主题：深 → 浅 → 深
await page.getByRole('button', { name: '外观', exact: true }).click();
await page.waitForTimeout(300);
const theme = page.getByLabel('主题');
await theme.selectOption('light');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/settings-appearance-light.png` });
await theme.selectOption('dark');
await page.waitForTimeout(300);

// 模型编辑弹窗
await page.getByRole('button', { name: '模型', exact: true }).click();
await page.waitForTimeout(350);
const edit = page.getByRole('button', { name: /编辑提供商/ }).first();
if (await edit.count()) {
  await edit.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/settings-model-editor.png` });
  await page.keyboard.press('Escape');
}

// 移动端
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/settings-mobile.png` });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
console.log('OVERFLOW_390', overflow);
console.log('ERRORS', errors.length ? errors.join('\n') : '(none)');

await browser.close();
