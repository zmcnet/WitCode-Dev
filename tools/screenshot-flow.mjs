// 用 Playwright 跑一遍真实流程并逐步截图。
// 用法：node tools/screenshot-flow.mjs
// 说明：会临时添加一个演示用 provider，结束后恢复原 providers.json。
import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots');
const DATA = path.join(os.homedir(), '.witcode', 'providers.json');
const BACKUP = `${DATA}.screenshot-bak`;

mkdirSync(OUT, { recursive: true });

const hadProviders = existsSync(DATA);
if (hadProviders) {
  copyFileSync(DATA, BACKUP);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let index = 0;
async function shot(name) {
  index += 1;
  const file = path.join(OUT, `${String(index).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[shot] ${path.basename(file)}`);
}

try {
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForSelector('.app');
  await page.waitForSelector('.composer textarea');
  await page.waitForTimeout(800);
  await shot('home');

  const newSession = page.locator('.new-session');
  if (await newSession.count()) {
    await newSession.click();
    await page.waitForTimeout(300);
  }
  await shot('new-session');

  await page.fill('.composer textarea', '你好，WitCode，先介绍一下你自己。');
  await page.click('.composer button');
  await page.waitForSelector('.bubble.assistant', { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const button = document.querySelector('.composer button');
      return Boolean(button && button.textContent?.includes('发送'));
    },
    { timeout: 30000 },
  );
  await shot('chat');

  await page.click('.settings-button');
  await page.waitForSelector('.settings');
  await page.waitForTimeout(400);
  await shot('settings-providers-empty');

  await page.click('button[aria-label="新增提供商"]');
  await page.waitForSelector('form.provider-form');
  await page.waitForTimeout(200);
  await shot('provider-form-empty');

  await page.click('form.provider-form button[type="submit"]');
  await page.waitForSelector('.field-error', { timeout: 5000 });
  await shot('provider-form-errors');

  await page.fill('input[aria-label="名称"]', '截图演示提供商');
  await page.fill('input[aria-label="Base URL"]', 'http://127.0.0.1:9/v1');
  await page.fill('input[aria-label="API Key"]', 'sk-screenshot-demo-123456');
  await page.fill(
    'textarea[aria-label="模型 ID（逗号或换行分隔）"]',
    'demo-model, demo-model-mini',
  );
  await shot('provider-form-filled');

  await page.click('form.provider-form button[type="submit"]');
  await page.waitForSelector('.provider-card', { timeout: 15000 });
  await page.waitForTimeout(400);
  await shot('provider-saved');

  await page.click('.model-selector-button');
  await page.waitForSelector('.model-menu');
  await shot('model-menu');
  await page.keyboard.press('Escape');

  await page.click('button[role="tab"]:has-text("用量")');
  await page.waitForTimeout(400);
  await shot('usage');

  await page.click('button[role="tab"]:has-text("提供商")');
  await page.waitForSelector('.provider-card');
  await page.click('button[aria-label^="删除提供商"]');
  await page.waitForSelector('.confirm-dialog');
  await shot('delete-confirm');
  await page.click('button[aria-label="取消删除"]');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('button:has-text("← 返回会话")');
  await page.waitForTimeout(500);
  await shot('mobile-chat');

  await page.click('.settings-button');
  await page.waitForTimeout(500);
  await shot('mobile-settings');
} finally {
  await browser.close();

  if (hadProviders) {
    copyFileSync(BACKUP, DATA);
  } else {
    rmSync(DATA, { force: true });
  }
  rmSync(BACKUP, { force: true });
}

console.log(`[done] ${index} 张截图 -> ${OUT}`);
