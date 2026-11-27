/**
 * 组件级 CSS 字号缩放 / 浅色主题验收截图。
 * 运行：export PATH="/d/env/sdk/fnm-data/node-versions/v24.9.0/installation:$PATH"
 *      node tools/component-parity-shots.cjs
 * 输出到 docs/screenshots/parity-component-*.png 与 docs/visual/.parity-component.json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:21004';
const SHOTS = path.resolve(__dirname, '..', 'docs', 'screenshots');
const RESULT = path.resolve(__dirname, '..', 'docs', 'visual', '.parity-component.json');
fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }];
const SCALES = ['0.85', '1', '1.3'];
const THEMES = ['dark', 'light'];
const PANELS = [
  { key: 'general', label: '常规' },
  { key: 'appearance', label: '外观' },
  { key: 'models', label: '模型' },
  { key: 'plugins', label: '插件' },
];
const EXTRA_PANELS = [
  { key: 'automations', label: '自动化' },
  { key: 'mcp', label: 'MCP 服务器' },
  { key: 'skills', label: '技能' },
  { key: 'hooks', label: '钩子' },
  { key: 'commands', label: '命令' },
];

const results = [];

async function newPage(browser, vp, scale, theme) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // 服务端设置是主题/字号真源，会在加载后回写 --font-scale 与 .theme-light。
  // 在脚本执行前拦截 setProperty 并持续强制 class，确保截图处在目标档位。
  await page.addInitScript(({ scale }) => {
    const orig = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
      if (name === '--font-scale') return orig.call(this, name, scale, priority);
      return orig.call(this, name, value, priority);
    };
    if (document.documentElement) {
      document.documentElement.style.setProperty('--font-scale', scale);
    }
  }, { scale });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // 主题经 WS 回写，需等应用初始化结束后再强制，否则会被服务端设置覆盖。
  await page.waitForTimeout(1200);
  await page.evaluate(({ theme, scale }) => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
    document.documentElement.style.setProperty('--font-scale', scale);
  }, { theme, scale });
  const applied = await page.evaluate(() => ({
    scale: getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim(),
    rootFont: getComputedStyle(document.documentElement).fontSize,
    light: document.documentElement.classList.contains('theme-light'),
  }));
  if (applied.scale !== scale) {
    throw new Error(`font-scale not applied: expected ${scale}, got ${applied.scale}`);
  }
  if (applied.light !== (theme === 'light')) {
    throw new Error(`theme not applied: expected ${theme}, light=${applied.light}`);
  }
  return { page, errors, applied };
}

async function clickBySelector(page, selector) {
  await page.locator(selector).first().evaluate((el) => el.click());
  await page.waitForTimeout(250);
}

async function clickNav(page, label) {
  await page.locator('.settings-nav-item').filter({ hasText: label }).first().evaluate((el) => el.click());
  await page.waitForTimeout(300);
}

async function inspect(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const bad = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      // only elements whose text is directly owned (no text-bearing children)
      const childHasText = Array.from(el.children).some((c) => (c.textContent || '').trim());
      if (childHasText) continue;
      if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
          cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) {
        bad.push({ t: 'x', cls: String(el.className).slice(0, 50), text: txt.slice(0, 36),
                   got: el.scrollWidth, limit: el.clientWidth });
      }
      if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') &&
          el.scrollHeight > el.clientHeight + 2) {
        bad.push({ t: 'y', cls: String(el.className).slice(0, 50), text: txt.slice(0, 36),
                   got: el.scrollHeight, limit: el.clientHeight });
      }
    }
    return {
      scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth,
      fontScale: getComputedStyle(root).getPropertyValue('--font-scale').trim(),
      fontSize: getComputedStyle(root).fontSize,
      clipped: bad,
    };
  });
}

async function capture(browser, vp, scale, theme, view, label, shotName) {
  const { page, errors } = await newPage(browser, vp, scale, theme);
  try {
    if (view === 'workflow') {
      await clickBySelector(page, 'button[aria-label="右栏"]');
      await page.locator('.dock__tab').filter({ hasText: '工作流' }).first().evaluate((el) => el.click());
      await page.waitForTimeout(350);
    } else if (view === 'settings') {
      await clickBySelector(page, 'button[aria-label="设置"]');
      await clickNav(page, label);
    }
    const info = await inspect(page);
    const file = path.join(SHOTS, shotName);
    await page.screenshot({ path: file });
    results.push({ file: path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/'),
                   viewport: vp.w, scale, theme, view, label,
                   errors: errors.length, errorSamples: errors.slice(0, 3), ...info });
    console.log(`${shotName}: errors=${errors.length} scroll=${info.scrollWidth}/${info.innerWidth} scale=${info.fontScale} rootFont=${info.fontSize} clipped=${info.clipped.length}`);
    if (info.clipped.length) console.log('   clipped sample:', JSON.stringify(info.clipped.slice(0, 2)));
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of VIEWPORTS) {
      for (const scale of SCALES) {
        for (const theme of THEMES) {
          const tag = `${theme}-${vp.w}-${scale.replace('.', '_')}`;
          await capture(browser, vp, scale, theme, 'main', '', `parity-component-main-${tag}.png`);
          await capture(browser, vp, scale, theme, 'workflow', '', `parity-component-workflow-${tag}.png`);
          for (const p of PANELS) {
            await capture(browser, vp, scale, theme, 'settings', p.label,
                          `parity-component-${p.key}-${tag}.png`);
          }
        }
        // 浅色主题下其余含配色修复的面板：三档缩放全覆盖验证。
        for (const p of EXTRA_PANELS) {
          await capture(browser, vp, scale, 'light', 'settings', p.label,
                        `parity-component-${p.key}-light-${vp.w}-${scale.replace('.', '_')}.png`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(RESULT, JSON.stringify(results, null, 2) + '\n', 'utf8');
  const totalErrors = results.reduce((a, r) => a + r.errors, 0);
  const overflow = results.filter((r) => r.scrollWidth > r.innerWidth);
  const clipped = results.filter((r) => r.clipped.length);
  console.log(`\nSUMMARY shots=${results.length} errors=${totalErrors} overflow=${overflow.length} clipped=${clipped.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
