// Screenshot + console/overflow check for parity audit.
// Usage: node tools/_parity-shots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.PARITY_URL ?? 'http://127.0.0.1:21004/';
const DIR = 'docs/screenshots';
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const viewport of [{ width: 1440, height: 900, tag: '1440' }, { width: 390, height: 844, tag: '390' }]) {
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript((t) => localStorage.setItem('witcode:theme', t), theme);
      await page.goto(URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.app-shell');
      await page.waitForTimeout(800);
      if (theme === 'light') {
        await page.evaluate(() => {
          document.documentElement.classList.add('theme-light');
          document.documentElement.dataset.theme = 'light';
        });
      }
      const shot = async (name) => {
        const path = `${DIR}/parity-${name}-${theme}-${viewport.tag}.png`;
        await page.screenshot({ path, animations: 'disabled' });
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        report.push({ path, theme, viewport: viewport.tag, page: name, errors: errors.length, overflow });
      };

      await shot('chat');

      if (viewport.width < 768) await page.locator('.topbar-menu').click().catch(() => {});
      await page.locator('.side-new').click().catch(() => {});
      await page.waitForTimeout(250);
      await shot('draft');

      if (viewport.width < 768) await page.locator('.topbar-menu').click().catch(() => {});
      await page.locator('.footer-settings').click().catch(() => {});
      await page.waitForSelector('.settings-layout', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(350);
      await shot('settings');

      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
