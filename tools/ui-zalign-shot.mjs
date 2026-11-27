import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

await page.goto('http://127.0.0.1:21004/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /新建会话/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'docs/screenshots/z-align-draft-1440.png' });

// 折叠 rail
await page.getByRole('button', { name: /收起会话列表/ }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/screenshots/z-align-collapsed-1440.png' });
await page.getByRole('button', { name: /展开会话列表/ }).click();
await page.waitForTimeout(400);

// 会话
await page.locator('.session-row').filter({ hasText: '你是谁' }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: 'docs/screenshots/z-align-chat-1440.png' });

// 设置
await page.getByRole('button', { name: '设置' }).last().click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/screenshots/z-align-settings-1440.png' });
await page.keyboard.press('Escape');

// 移动端
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(700);
const overflow390 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await page.screenshot({ path: 'docs/screenshots/z-align-mobile-390.png' });

console.log('OVERFLOW_390', overflow390);
console.log('ERRORS', errors.length ? errors.join('\n') : '(none)');
await browser.close();
