/**
 * WitCode 视觉验收脚本（P2 设置页 / 模型管家）
 *
 * 依赖：pnpm add -D @playwright/test
 *      pnpm exec playwright install chromium
 * 运行：先启动前端 `pnpm dev:web`，再执行
 *      pnpm exec playwright test docs/visual/playwright-settings.spec.ts
 *
 * 设计说明：沿用 docs/visual/playwright.spec.ts 的 addInitScript 方案，注入一个
 * 可控的 FakeWebSocket，覆盖 providers:list / providers:save / providers:delete /
 * usage:list，因此不依赖真实后端即可确定性通过。若要连本地真实服务，删掉
 * beforeEach 里的 installSettingsSocket() 调用即可，断言逻辑无需改动。
 *
 * 注意：本文件只做交付，不在本次任务中运行。
 */

import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

const BASE_URL = process.env.WITCODE_BASE_URL ?? 'http://localhost:5173';

/**
 * 在页面初始化前替换 window.WebSocket。
 * 假服务端状态挂在 window.__mockState，便于用例直接 seed / 断言。
 */
async function installSettingsSocket(page: Page) {
  await page.addInitScript(() => {
    const OPEN = 1;
    const CLOSED = 3;

    const state: {
      providers: any[];
      usage: { summary: any; items: any[] };
      models: any[];
    } = {
      providers: [],
      usage: {
        summary: {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          byProvider: [],
        },
        items: [],
      },
      models: [],
    };
    (window as any).__mockState = state;

    // 异步回包，给 React 留出绑定 onmessage 的时间
    function emit(this: any, payload: unknown) {
      const socket = this;
      setTimeout(() => {
        if (socket.readyState === OPEN && typeof socket.onmessage === 'function') {
          socket.onmessage({ data: JSON.stringify(payload), target: socket });
        }
      }, 5);
    }

    function FakeWebSocket(this: any, url: string) {
      const socket = this;
      socket.url = url;
      socket.readyState = 0;
      socket.onopen = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      (window as any).__lastWs = socket;

      setTimeout(() => {
        socket.readyState = OPEN;
        if (typeof socket.onopen === 'function') socket.onopen({ target: socket });
        // 模拟服务端在握手后主动推送的初始数据
        emit.call(socket, { type: 'ready', sessionId: 'mock-session' });
        emit.call(socket, { type: 'models', items: state.models });
        emit.call(socket, { type: 'providers', items: state.providers });
        emit.call(socket, {
          type: 'usage',
          summary: state.usage.summary,
          items: state.usage.items,
        });
      }, 0);
    }

    FakeWebSocket.prototype.send = function (this: any, raw: string) {
      const socket = this;
      if (socket.readyState !== OPEN) return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg?.type) {
        case 'providers:list':
          emit.call(socket, { type: 'providers', items: state.providers });
          break;

        case 'usage:list':
          emit.call(socket, {
            type: 'usage',
            summary: state.usage.summary,
            items: state.usage.items,
          });
          break;

        case 'providers:save': {
          const input = msg.provider ?? {};
          const saved = {
            id: `mock-${Date.now()}-${state.providers.length}`,
            name: String(input.name ?? ''),
            baseUrl: String(input.baseUrl ?? ''),
            modelIds: Array.isArray(input.modelIds) ? input.modelIds : [],
            enabled: input.enabled !== false,
            hasApiKey: Boolean(input.apiKey),
            apiKeyHint: input.apiKey
              ? `sk-…${String(input.apiKey).slice(-4)}`
              : '',
          };
          state.providers = [...state.providers, saved];
          emit.call(socket, { type: 'providers', items: state.providers });
          break;
        }

        case 'providers:delete': {
          state.providers = state.providers.filter((item) => item.id !== msg.id);
          emit.call(socket, { type: 'providers', items: state.providers });
          break;
        }

        case 'selection:set':
          emit.call(socket, { type: 'selection', selection: msg.selection });
          break;

        default:
          break;
      }
    };

    FakeWebSocket.prototype.close = function (this: any) {
      const socket = this;
      socket.readyState = CLOSED;
      if (typeof socket.onclose === 'function') socket.onclose({ target: socket });
    };

    (FakeWebSocket as any).CONNECTING = 0;
    (FakeWebSocket as any).OPEN = OPEN;
    (FakeWebSocket as any).CLOSING = 2;
    (FakeWebSocket as any).CLOSED = CLOSED;

    (window as any).WebSocket = FakeWebSocket;
  });
}

async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '模型管家' })).toBeVisible();
}

async function addMockProvider(page: Page, name = 'Mock Provider') {
  await page.getByRole('button', { name: /新增提供商/ }).click();
  await page.getByLabel('名称').fill(name);
  await page.getByLabel('Base URL').fill('https://mock.invalid/v1');
  await page.getByLabel(/模型 ID/).fill('mock-chat, mock-reasoner');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  return page.locator('.provider-card', { hasText: name });
}

test.describe('P2 设置页视觉与交互验收', () => {
  test.use({ baseURL: BASE_URL });

  test.beforeEach(async ({ page }) => {
    await installSettingsSocket(page);
  });

  test('打开设置并切换到 Providers tab', async ({ page }) => {
    await openSettings(page);

    await expect(page.getByRole('tab', { name: '提供商' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tab', { name: '用量' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await expect(page.getByRole('heading', { name: '提供商' })).toBeVisible();
    await expect(page.getByText('还没有提供商，先加一个')).toBeVisible();
  });

  test('新增 provider 保存后列表出现该条目', async ({ page }) => {
    await openSettings(page);

    const card = await addMockProvider(page);

    await expect(card).toHaveCount(1);
    await expect(card).toContainText('https://mock.invalid/v1');
    await expect(card).toContainText('2 个');
    await expect(card).toContainText('未设置'); // 未填 API Key 时的提示
  });

  test('切到 Usage 后断言空态或汇总可见', async ({ page }) => {
    await openSettings(page);
    await addMockProvider(page);

    await page.getByRole('tab', { name: '用量' }).click();

    await expect(page.getByRole('tab', { name: '用量' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { name: '用量' })).toBeVisible();
    // 假服务端 seed 的是空用量，因此应看到空态与 0 汇总
    await expect(page.getByText('暂无用量数据')).toBeVisible();
    await expect(page.getByText('暂无调用记录')).toBeVisible();
    await expect(page.locator('.stat-card')).toHaveCount(3);
    await expect(page.locator('.stat-card').first()).toContainText('0');
  });

  test('删除 provider 需确认，取消保留、确认后移除', async ({ page }) => {
    await openSettings(page);
    const card = await addMockProvider(page);

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Mock Provider');
      await dialog.dismiss();
    });
    await card.getByRole('button', { name: '删除' }).click();
    await expect(card).toHaveCount(1);

    page.once('dialog', async (dialog) => {
      await dialog.accept();
    });
    await card.getByRole('button', { name: '删除' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText('还没有提供商，先加一个')).toBeVisible();
  });

  test('768 视口无横向溢出并保存设置页截图', async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await openSettings(page);
    await addMockProvider(page);

    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);

    const cardsPath = testInfo.outputPath('settings-768-cards.png');
    await page.screenshot({ path: cardsPath, fullPage: true });
    console.log(`768 列表截图已保存：${cardsPath}`);

    await page.locator('.provider-card').first().getByRole('button', { name: '编辑' }).click();
    await expect(page.locator('.provider-form')).toBeVisible();

    const formPath = testInfo.outputPath('settings-768-form.png');
    await page.screenshot({ path: formPath, fullPage: true });
    console.log(`768 表单截图已保存：${formPath}`);
  });

  // 已知缺口：当前实现没有 Esc 关闭逻辑，见 docs/visual/review-002.md P1-09。
  // 修复后把 fixme 改成 test 即可启用。
  test.fixme(
    'Esc 可关闭模型菜单与 Provider 表单（待 Coding-3 修复 P1-09）',
    async ({ page }) => {
      await openSettings(page);
      await page.getByRole('button', { name: /新增提供商/ }).click();
      await expect(page.locator('.provider-form')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.provider-form')).toHaveCount(0);
    },
  );
});
