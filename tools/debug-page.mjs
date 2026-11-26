// 诊断：打开页面，打印控制台错误与页面结构，并截一张图。
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('console', (message) => {
  console.log(`[console:${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => {
  console.log(`[pageerror] ${error.message}`);
});
page.on('requestfailed', (request) => {
  console.log(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`);
});

const response = await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
console.log('[status]', response?.status());

await page.waitForTimeout(4000);
console.log('[title]', await page.title());
console.log('[body]', (await page.locator('body').innerHTML()).slice(0, 1200));

await page.screenshot({ path: 'docs/screenshots/debug.png' });
console.log('[shot] docs/screenshots/debug.png');

await browser.close();
