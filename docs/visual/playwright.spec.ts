/**
 * WitCode 视觉验收脚本（P1）
 *
 * 依赖：pnpm add -D @playwright/test
 *      pnpm exec playwright install chromium
 * 运行：先启动前端 `pnpm dev:web`，再执行
 *      pnpm exec playwright test docs/visual/playwright.spec.ts
 *
 * 设计说明：用 addInitScript 注入一个可控的 WebSocket mock，使用例不依赖
 * 真实后端即可确定性通过。若要做真机/真后端联调，删掉 installMockSocket()
 * 的调用即可，断言逻辑无需改动。
 */

import { expect, test } from '@playwright/test';

const BASE_URL = process.env.WITCODE_BASE_URL ?? 'http://localhost:5173';

async function installMockSocket(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const OPEN = 1;
    const CLOSED = 3;

    function FakeWebSocket(this: any, url: string) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onclose = null;
      this.onmessage = null;
      this.onerror = null;
      (window as any).__lastWs = this;
      // 异步 open，模拟真实握手，让 React 有机会绑定事件处理器
      setTimeout(() => {
        this.readyState = OPEN;
        if (typeof this.onopen === 'function') this.onopen({ target: this });
      }, 0);
    }

    FakeWebSocket.prototype.send = function (this: any, raw: string) {
      if (this.readyState !== OPEN) return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || msg.type !== 'prompt') return;

      const emit = (payload: unknown) => {
        setTimeout(() => {
          if (this.readyState === OPEN && typeof this.onmessage === 'function') {
            this.onmessage({ data: JSON.stringify(payload), target: this });
          }
        }, 10);
      };

      emit({ type: 'delta', text: '你好' });
      emit({ type: 'delta', text: '，世界' });
      emit({ type: 'done', text: '你好，世界', sessionId: 'mock-session' });
    };

    FakeWebSocket.prototype.close = function (this: any) {
      this.readyState = CLOSED;
      if (typeof this.onclose === 'function') this.onclose({ target: this });
    };

    (FakeWebSocket as any).CONNECTING = 0;
    (FakeWebSocket as any).OPEN = OPEN;
    (FakeWebSocket as any).CLOSING = 2;
    (FakeWebSocket as any).CLOSED = CLOSED;

    (window as any).WebSocket = FakeWebSocket;
  });
}

test.describe('WitCode 视觉验收', () => {
  test.use({ baseURL: BASE_URL });

  test.beforeEach(async ({ page }) => {
    await installMockSocket(page);
  });

  test('打开首页并断言标题与空态', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle('WitCode');
    await expect(page.getByRole('heading', { name: 'WitCode', level: 1 })).toBeVisible();
    await expect(page.locator('.bubble')).toHaveCount(0);
  });

  test('输入并发送后出现 assistant 气泡', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.status')).toHaveText('已连接');

    const input = page.locator('.composer textarea');
    await input.fill('你好');
    await input.press('Enter'); // Enter 发送（Shift+Enter 应换行，另见人工清单）

    await expect(page.locator('.bubble.user')).toHaveCount(1);
    await expect(page.locator('.bubble.assistant')).toHaveCount(1);
    await expect(page.locator('.bubble.assistant .text')).toContainText('你好，世界');

    // done 之后光标必须消失，发送按钮恢复可用
    await expect(page.locator('.bubble.assistant .caret')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  test('断线后状态显示为未连接且发送按钮禁用', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.status')).toHaveText('已连接');

    // 触发服务端主动关闭
    await page.evaluate(() => {
      const ws = (window as any).__lastWs;
      if (!ws) throw new Error('WebSocket 实例未创建');
      ws.close();
    });

    await expect(page.locator('.status')).toHaveText('未连接');
    await expect(page.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  test('移动端视口无横向溢出并保存截图', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'WitCode', level: 1 })).toBeVisible();

    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);

    const path = testInfo.outputPath('mobile-home.png');
    await page.screenshot({ path, fullPage: true });
    console.log(`移动端截图已保存：${path}`);
  });
});
