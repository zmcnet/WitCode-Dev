// Temporary measurement tool for ZCode parity audit.
// Usage: node tools/_parity-measure.mjs <out.json>
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.PARITY_URL ?? 'http://127.0.0.1:21004/';
const OUT = process.argv[2] ?? 'parity.json';

const PROBES = [
  { key: 'body', html: '<div id="probe-body">text</div>', target: '#probe-body', from: 'body' },
  { key: 'topbar', cls: 'topbar' },
  { key: 'sidebar', cls: 'sidebar' },
  { key: 'composer-shell', cls: 'composer-shell' },
  { key: 'workspace-popover', cls: 'workspace-popover' },
  { key: 'side-row.active', html: '<button class="side-row active">New session</button>', target: '.side-row.active' },
  { key: 'side-row.hover-bg-var', cls: 'side-row' },
  { key: 'tool-row', cls: 'tool-row' },
  { key: 'tool-section pre', html: '<div class="tool-section"><pre>code</pre></div>', target: '.tool-section pre' },
  { key: 'bubble.user', html: '<div class="msg-row user"><div class="bubble user">hi</div></div>', target: '.bubble.user' },
  { key: 'btn.primary', cls: 'btn primary' },
  { key: 'btn.ghost', cls: 'btn ghost' },
  { key: 'send-btn', cls: 'send-btn' },
  { key: 'msg-text', cls: 'msg-text' },
  { key: 'assistant-text', cls: 'assistant-text' },
  { key: 'side-row-label', cls: 'side-row-label' },
  { key: 'panel-desc', cls: 'panel-desc' },
  { key: 'pref-row', cls: 'pref-row' },
  { key: 'form-field', cls: 'form-field' },
  { key: 'settings-nav-item', cls: 'settings-nav-item' },
  { key: 'settings-panel h2', html: '<div class="settings-panel"><h2>Title</h2></div>', target: '.settings-panel h2' },
  { key: 'settings-panels__head h2', html: '<div class="settings-panels__head"><h2>Title</h2></div>', target: '.settings-panels__head h2' },
  { key: 'settings-panels__desc', cls: 'settings-panels__desc' },
  { key: 'md-body', cls: 'md-body' },
  { key: 'md-body h1', html: '<div class="md-body"><h1>Heading</h1></div>', target: '.md-body h1' },
  { key: 'md-body h2', html: '<div class="md-body"><h2>Heading</h2></div>', target: '.md-body h2' },
  { key: 'md-body h3', html: '<div class="md-body"><h3>Heading</h3></div>', target: '.md-body h3' },
  { key: 'md-body code', html: '<div class="md-body"><code>inline</code></div>', target: '.md-body code' },
  { key: 'md-body .md-code code', html: '<div class="md-body"><div class="md-code"><pre><code>code</code></pre></div></div>', target: '.md-body .md-code code' },
  { key: 'brain-menu', cls: 'brain-menu' },
  { key: 'permission-menu', cls: 'permission-menu' },
  { key: 'error-banner', cls: 'error-banner' },
  { key: 'settings-search input', html: '<div class="settings-search"><input /></div>', target: '.settings-search input' },
  { key: 'pref-select', cls: 'pref-select' },
  { key: 'composer-input', cls: 'composer-input' },
];

const PROPS = [
  'backgroundColor', 'color', 'borderColor', 'borderTopColor', 'borderLeftColor',
  'borderRadius', 'fontSize', 'lineHeight', 'height', 'minHeight', 'maxWidth',
  'padding', 'paddingTop', 'paddingLeft', 'boxShadow',
];

function pickStyle(cs) {
  const out = {};
  for (const p of PROPS) out[p] = cs[p];
  return out;
}

function readRoot() {
  const cs = getComputedStyle(document.documentElement);
  const vars = [
    '--bg', '--header', '--panel', '--panel-2', '--panel-3', '--border', '--border-soft',
    '--text', '--muted', '--faint', '--brand', '--brand-soft', '--hover', '--selected',
    '--surface', '--input', '--focus', '--user', '--user-border', '--ok', '--warn',
    '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl',
    '--font-scale', '--ui-font-size', '--text-ui-base', '--text-ui-caption', '--text-ui-sm',
    '--text-ui-settings-title', '--text-ui-settings-title-lg',
  ];
  const values = {};
  for (const v of vars) values[v] = cs.getPropertyValue(v).trim();
  return values;
}

async function measurePage(page, theme, viewport) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.addInitScript((t) => {
    localStorage.setItem('witcode:theme', t);
    localStorage.removeItem('witcode:sidebar-width');
  }, theme);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-shell', { timeout: 15000 });
  await page.waitForTimeout(900);
  // Server settings are authoritative for theme; force the CSS class for a pure token measurement.
  if (theme === 'light') {
    await page.evaluate(() => {
      document.documentElement.classList.add('theme-light');
      document.documentElement.dataset.theme = 'light';
    });
  }
  const isMobile = viewport.startsWith('390');
  if (isMobile) await page.locator('.topbar-menu').click({ timeout: 5000 }).catch(() => {});

  const base = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: +r.width.toFixed(1), height: +r.height.toFixed(1), top: +r.top.toFixed(1) };
    };
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const font = (sel) => {
      const c = cs(sel);
      return c ? c.fontSize : null;
    };
    const shell = document.querySelector('.app-shell');
    const messages = document.querySelector('.messages');
    const composer = document.querySelector('.composer-wrap');
    return {
      draft: shell?.classList.contains('is-draft') ?? false,
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      sidebarRect: rect('.sidebar'),
      topbarRect: rect('.topbar'),
      topbarDisplay: cs('.topbar')?.display ?? null,
      topbarComputedHeight: cs('.topbar')?.height ?? null,
      messageListRect: rect('.message-list'),
      messagesPaddingTop: messages ? getComputedStyle(messages).paddingTop : null,
      composerWrapMaxWidth: composer ? getComputedStyle(composer).maxWidth : null,
      composerWrapRect: rect('.composer-wrap'),
      composerShellRect: rect('.composer-shell'),
      settingsNavItemHeight: font('.settings-nav-item') ? null : null,
      vars: (() => {
        const s = getComputedStyle(document.documentElement);
        const keys = ['--bg', '--header', '--panel', '--panel-2', '--border', '--hover', '--selected', '--text', '--muted', '--font-scale', '--ui-font-size'];
        const o = {};
        for (const k of keys) o[k] = s.getPropertyValue(k).trim();
        return o;
      })(),
    };
  });

  await page.locator('.side-new').click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const draftMetrics = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    const messages = document.querySelector('.messages');
    const composer = document.querySelector('.composer-wrap');
    const greeting = document.querySelector('.empty-greeting');
    return {
      draft: shell?.classList.contains('is-draft') ?? false,
      messagesPaddingTop: messages ? getComputedStyle(messages).paddingTop : null,
      composerWrapMaxWidth: composer ? getComputedStyle(composer).maxWidth : null,
      greetingFontSize: greeting ? getComputedStyle(greeting).fontSize : null,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });

  const probeResult = await page.evaluate(({ probes, props }) => {
    const host = document.createElement('div');
    host.id = 'parity-probe-host';
    host.style.cssText = 'position:absolute;left:-10000px;top:0;width:1200px;height:800px;';
    document.body.appendChild(host);
    const out = {};
    for (const probe of probes) {
      let el;
      if (probe.html) {
        host.insertAdjacentHTML('beforeend', probe.html);
        el = host.querySelector(probe.target);
      } else {
        el = document.createElement('div');
        el.className = probe.cls;
        el.textContent = 'Sample text';
        host.appendChild(el);
      }
      if (!el) { out[probe.key] = null; continue; }
      const cs = getComputedStyle(el);
      const obj = {};
      for (const p of props) obj[p] = cs[p];
      out[probe.key] = obj;
    }
    host.remove();
    return out;
  }, { probes: PROBES, props: PROPS });

  if (isMobile) await page.locator('.topbar-menu').click({ timeout: 5000 }).catch(() => {});
  await page.locator('.footer-settings').click({ timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.settings-layout', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const settings = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const c = (sel) => (q(sel) ? getComputedStyle(q(sel)) : null);
    const r = (sel) => {
      const el = q(sel);
      if (!el) return null;
      const x = el.getBoundingClientRect();
      return { width: +x.width.toFixed(1), height: +x.height.toFixed(1) };
    };
    return {
      open: !!q('.settings-layout'),
      navRect: r('.settings-nav'),
      navItemHeight: c('.settings-nav-item')?.height ?? null,
      navItemFontSize: c('.settings-nav-item')?.fontSize ?? null,
      scrollRect: r('.settings-scroll'),
      scrollMaxWidth: c('.settings-scroll')?.maxWidth ?? null,
      panelRect: r('.settings-panel'),
      panelH2FontSize: c('.settings-panel h2')?.fontSize ?? null,
      realTitleFontSize: c('.settings-panels__head h2')?.fontSize ?? null,
      realDescFontSize: c('.settings-panels__desc')?.fontSize ?? null,
      breadcrumbHeight: c('.settings-breadcrumb')?.height ?? null,
      navTopPaddingTop: c('.settings-nav-top')?.paddingTop ?? null,
      rowHeight: c('.pref-row')?.minHeight ?? null,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });

  return {
    theme,
    viewport,
    consoleErrors: errors,
    horizontalOverflow: {
      chat: base.docScrollWidth > base.innerWidth,
      draft: draftMetrics.docScrollWidth > draftMetrics.innerWidth,
      settings: settings.docScrollWidth > settings.innerWidth,
      widths: {
        chat: [base.docScrollWidth, base.innerWidth],
        draft: [draftMetrics.docScrollWidth, draftMetrics.innerWidth],
        settings: [settings.docScrollWidth, settings.innerWidth],
      },
    },
    rootVars: base.vars,
    chat: base,
    draft: draftMetrics,
    probes: probeResult,
    settings,
  };
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const theme of ['dark', 'light']) {
    const page = await context.newPage();
    results.push(await measurePage(page, theme, '1440x900'));
    await page.close();
  }
  await context.close();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  for (const theme of ['dark', 'light']) {
    const page = await mobile.newPage();
    results.push(await measurePage(page, theme, '390x844'));
    await page.close();
  }
  await mobile.close();
} finally {
  await browser.close();
}
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`wrote ${OUT} with ${results.length} results`);
