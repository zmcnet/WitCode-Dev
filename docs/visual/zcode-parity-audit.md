# WitCode × ZCode 视觉对齐审计（2026-11-26）

## 方法与口径

- **ZCode 侧（读源码，不运行）**：`resources/src/ZCode-4.0.0/packages/ui/src/styles.css`
  的 `:root`、`--ui-font-size`/`@theme` 的 `text-ui-*` 阶梯、`.theme-zai-dark`、`.theme-zai-light`；
  设置页排版取自 `settings/SettingsPage.tsx`、`settings/SettingsPageParts.tsx`、`settings/settingsPageConfig.ts`。
- **WitCode 侧（实测 computed style）**：Playwright 1.65 / Chromium 159，视口 **1440×900** 与 **390×844**，
  分别 dark / light。服务端在 `127.0.0.1:21004`（托管 `apps/web/dist`）。
  用探针元素在真实页面内读取 `getComputedStyle`，同时读取真实 DOM 的布局矩形。
- **主题口径**：WitCode 主题由服务端设置经 WS 下发并覆盖 localStorage，因此测量时在页面加载后
  强制加 `document.documentElement.classList.add('theme-light')`，只测 CSS token 本身。
- **baseline** = 本次改动前的构建实测；**final** = 改动后重新构建实测。
  原始 JSON：`docs/visual/.parity-baseline.json`、`docs/visual/.parity-final.json`。
- 说明：当前工作树里已有一次「ZCode 外观对齐层」，故下表大量项目 **baseline 就已经是 0 差值**；
  本报告不把这些算作本次修复的功劳，只如实列出。

## 1. 颜色 token 对比

下列数值为 computed style（rgb/alpha 已按浏览器返回值书写）。ZCode 目标值直接摘自对应主题块。

### 1.1 Dark

| 项目 | ZCode 目标 | WitCode baseline | WitCode final | 差值（final − 目标） |
|---|---|---|---|---|
| 页面背景 `--color-background` / `--bg` | `#161616` | `rgb(22,22,22)` | `rgb(22,22,22)` | 0 |
| 侧栏 `--color-sidebar` | `#161616` | `rgb(22,22,22)` | `rgb(22,22,22)` | 0 |
| 顶栏 `--color-header` | `#202020` | `rgb(32,32,32)` | `rgb(32,32,32)` | 0 |
| 面板 `--color-panel` | `#202020` | `rgb(32,32,32)` | `rgb(32,32,32)` | 0 |
| 弹层/菜单/卡片 `--color-popover` | `#2b2b2b` | `rgb(43,43,43)` | `rgb(43,43,43)` | 0 |
| 边框 `--color-border` | `rgba(255,255,255,.1)` | 同 | 同 | 0 |
| hover `--color-hover` | `rgba(255,255,255,.05)` | 同 | 同 | 0 |
| selected `--color-selected` | `rgba(255,255,255,.1)` | `rgba(255,255,255,.1)` | 同 | 0 |
| 主按钮 `--color-primary` / fg | `#ffffff` / `#000000` | 白底黑字 | 白底黑字 | 0 |
| 用户气泡 `--color-user-message-bubble` | `rgba(255,255,255,.08)` | 同 | 同 | 0 |
| 代码块背景/前景 | `#161616` / `#f5f5f5` | `#161616` / `#f5f5f5` | 同 | 0 |
| 危险/错误面 `--color-destructive-surface` | `rgba(255,92,92,.16)` / `#ff8585` | `#33191c` / `#ffc4c4` | `rgba(255,92,92,.16)` / `rgb(255,133,133)` | **已闭合**（原偏差明显） |
| 圆角 composer / 用户气泡 / 导航行 / 工具行 | 16 / 12 / 8 / 6 px | 同 | 同 | 0 |

### 1.2 Light

| 项目 | ZCode 目标 | WitCode baseline | WitCode final | 差值（final − 目标） |
|---|---|---|---|---|
| 页面背景 `--color-background` | `#f8f8f8` | `rgb(248,248,248)` | `rgb(248,248,248)` | 0 |
| 侧栏 `--color-sidebar` | `#f0f0f0` | `rgb(248,248,248)` | `rgb(240,240,240)` | **原 +8/255，已闭合** |
| 顶栏/面板 `--color-header` / `--color-panel` | `#ffffff` | `rgb(255,255,255)` | 同 | 0 |
| 弹层/菜单 `--color-popover` | `#ffffff` | `rgb(255,255,255)` | 同 | 0 |
| 边框 `--color-border` | `rgba(13,13,13,.1)` | 同 | 同 | 0 |
| hover `--color-hover` | `rgba(13,13,13,.05)` | 同 | 同 | 0 |
| selected `--color-selected` | `rgba(13,13,13,.05)` | `rgba(13,13,13,.08)` | `rgba(13,13,13,.05)` | **原 +0.03，已闭合** |
| surface `--color-surface` | `rgba(13,13,13,.03)` | `rgba(13,13,13,.04)` | `rgba(13,13,13,.03)` | **原 +0.01，已闭合** |
| 主按钮 bg / fg | `#000000` / `#ffffff` | 黑底 **黑字**（不可读） | 黑底白字 | **P0 已修复** |
| 用户气泡 | `rgba(13,13,13,.05)` | 同 | 同 | 0 |
| 代码块 `--color-background` / fg | `#f8f8f8` / `#0d0d0d` | 同 | 同 | 0 |
| 错误面 `--color-destructive-surface` | 浅红面 + 深红字 | 深红面 + 浅红字 | `#fff0f0` / `#b42020` | **已闭合** |
| 链接 `--color-interaction-ask-foreground` 量级 | `#0b7fff` | `#80beff`（暗色链接色漏到浅色） | `#0b7fff` | **已闭合** |
| 滚动条 thumb（WebKit / Firefox） | 深色 18% / 13% | WebKit 已覆盖，Firefox 仍白 | 两者均按主题 | 已闭合 |
| 圆角 | 16 / 12 / 8 / 6 px | 同 | 同 | 0 |

## 2. 字号与布局对比

`font-size` 列均为 computed px；`scale=1`（默认）下实测。缩放验证见第 4 节。

| 项目 | ZCode 目标 | baseline | final | 差值 |
|---|---|---|---|---|
| 基础字号 `--ui-font-size` | 14px | 未定义（写死 `14px`） | `calc(14px * var(--font-scale,1))` → 14px | 结构补齐 |
| 正文 `.msg-text` / `.md-body` | `text-ui-base` 14px | 14px | 14px | 0 |
| 说明文字 `.panel-desc` | `text-ui-base` 14px | 12px | 14px | **原 −2，已闭合** |
| 设置导航项 `.settings-nav-item` | `text-ui-base` 14px | 13px | 14px | **原 −1，已闭合** |
| 设置分区标题 `.settings-nav-title` | `text-ui-sm` 12px | 11px | 12px（阶梯变量） | **原 −1，已闭合** |
| 设置页标题（1440 / 390） | `text-ui-settings-title(-lg)` 24 / 30px | 实际标题 16px；`.settings-panel h2` 24px | 实际标题 30 / 24px | **原 −14 / −8，已闭合** |
| 设置说明 `.settings-panels__desc` | `text-ui-base` 14px | 13px | 14px | **原 −1，已闭合** |
| 设置行文字 `.pref-row` | `text-ui-base` 14px | 13px | 14px | **原 −1，已闭合** |
| 设置搜索输入 | `text-ui-base` 14px | 12px | 14px | **原 −2，已闭合** |
| 草稿问候语（1440 / 390） | 30 / 24px | **14px**（被 `.empty p` 覆盖） | 30 / 24px | **原 −16 / −10，已闭合** |
| 侧栏宽度 | 264px | 264px | 264px | 0 |
| 顶栏高度 | 48px | 48px | 48px | 0 |
| 会话列最大宽 `max-w-6xl` | 1152px | 1152px | 1152px | 0 |
| 设置导航 / 内容列 | 268 / 896px | 268 / 896px | 268 / 896px | 0 |
| 草稿留白 `before:basis-[29dvh]` | 29dvh（900px 视口 = 261px） | 261px | 261px | 0 |
| 草稿输入列 `max-w-2xl` | 672px | 672px | 672px | 0 |
| 按钮 / 输入高度 | ZCode Button `h-7/h-8` 28–32px，Input lg 32px | `.btn` 32；`.pref-select`/搜索 28 | `.btn` 32；`.pref-select`/搜索 32 | 输入 −4 已闭合 |
| 设置行上下留白 | `py-3` 12px | 12px | 12px | 0 |

> 390 宽下侧栏为抽屉（320px，关闭时 `translateX(-100%)`）、设置导航转为 48px 横条，
> 属于 ZCode `compact-web` 的同一降级模式；实测无横向溢出。

## 3. 修改清单

### `apps/web/src/styles.css`
1. 对齐层 `:root` 新增 `--ui-font-size: calc(14px * var(--font-scale, 1))` 与 ZCode 同构的
   `--text-ui-xl/lg/base/caption/sm/xs/2xs`、`--text-ui-settings-title(-lg)`；
   根 `font-size` 改为 `var(--ui-font-size)`。项目内无 rem 布局，故不影响任何布局尺寸。
2. 新增派生语义 token：dark `--code-bg/--code-fg/--link/--danger-*`/`--secondary`/`--disabled-surface`；
   light 同名对应 ZCode light 值；`--sidebar`（dark `#161616` / light `#f0f0f0`）；
   light 的 `--selected` 0.08→0.05、`--surface` 0.04→0.03。
3. **152 条** UI 文本 `font-size` 从硬编码 px 改为 `calc(Npx * var(--font-scale, 1))`
   （覆盖顶栏、侧栏、消息、工具行、输入区、设置页、Markdown、菜单、弹窗、斜杠提示等）。
   装饰性尺寸保持原值：`.icon-btn` 16px、各 `*-glyph`/`*-chev`/`*-check`、`-dot`/`context-ring`、
   `empty-mark`/`empty-watermark`（`min(30vw,420px)`）、`send-btn`（`font-size:0`）均未缩放。
   另单独把 `.md-body` 设为 `var(--text-ui-base)`。
4. 末尾新增「对齐补齐」段：代码块/链接/错误面使用语义 token；
   `.theme-light .btn.primary` 补白字（修复黑底黑字）、浅色危险面/风险标签/弹层投影、Firefox 滚动条色；
   设置页文字对齐 `text-ui-*` 阶梯；输入高度 28→32px；
   `.draft-empty .empty-greeting` 用更高优先级恢复 30/24px；
   默认设置面板真实类 `.settings-panels__head h2/__p/__label/__desc/__group-title/__block` 用同一 token 覆盖。

### `apps/web/src/font-scale.ts`（新建）
- `FONT_SCALE_MIN=0.85`、`FONT_SCALE_MAX=1.3`；
- `clampFontScale(value)`（非有限数回落 1）；
- `applyFontScale(scale)` 写根变量 `--font-scale`。
App 现有的 `chat.appSettings.fontScale` 副作用也写同一个变量（服务端已 clamp 0.85–1.3），二者一致。
未改动任何 `.tsx`、`App.tsx`、`useChat.ts` 或其他 CSS 文件。

## 4. 验证

- `pnpm --filter @witcode/web typecheck`：通过。
- `pnpm --filter @witcode/web build`：通过（仅有既存的 >500 kB chunk 提示）。
- **console error = 0**：1440/390 × dark/light × 会话/草稿/设置，共 12 组，全部为 0。
- **横向溢出 = 0**：每组 `document.documentElement.scrollWidth === window.innerWidth`（1440 / 390）。
- **字号缩放压力测试**（Playwright 直接写 `--font-scale`，1440 与 390）：
  - 0.85 → 根字号 11.9px、`.side-row` 11.9px；
  - 1.0 → 14px / 14px；
  - 1.3 → 18.2px / 18.2px；
  - `.icon-btn` 始终 16px（装饰未缩放）；两种视口、三档缩放下 `scrollWidth === innerWidth`，console error 0。
- 截图（12 张）：`docs/screenshots/parity-{chat,draft,settings}-{dark,light}-{1440,390}.png`。

## 5. 残余差距

**P0（阻断体验/明显错位）：无。** 浅色主按钮黑底黑字已修复；深浅色主要 token 与实测值一致。

**P1（需后续处理，受本次改动范围限制）**
1. 组件级 CSS 文件（`components/settings/**/*.css`、`dock/*.css`、`todo.css`、`workflow.css` 等）
   仍有大量硬编码 px 字号，不随 `--font-scale` 变化；本次只允许改 `styles.css`，仅覆盖了默认设置面板
   `.settings-panels__*` 与已有全局类，其它设置子页（模型/插件/技能/自动化/MCP/Hooks/命令/用量等）
   与右侧 Dock 的字号缩放尚未生效。
2. 服务端设置是主题真源：Playwright 测 light 时须在页面加载后强制 `theme-light` class；
   若通过 UI 切主题，会经 WS 回写服务端设置（属功能链路，本次未改）。

**P2（低优先级 / 设计取舍）**
1. ZCode light `--color-selected` 已对齐到 0.05，但导航选中态的视觉权重比旧版 0.08 略轻，
   如需维持旧观感可回退该 token（不指定则按 ZCode）。
2. ZCode 设置行使用 `grid-cols-[1fr_280px]`（宽控件）/ `192px`（窄控件）并带 `detail` 行；
   WitCode 默认面板是 `1fr 192px`，没有 280px 宽控件与 detail 区。布局骨架一致但控件列不具备宽档。
   该项需要改组件结构，本次禁止改 `.tsx`，未处理。
3. ZCode 草稿水印是 SVG `ZCodeEmptyStateLogo`（`min(72vw,25rem)`），WitCode 是字母 `W`
   （`min(30vw,420px)` / 26vw）；尺寸量级接近但图形不同，品牌元素按要求未复制。
4. 移动端草稿态顶栏在 WitCode 强制显示（ZCode compact-web 亦为顶部条），但 WitCode 侧栏关闭时
   阴影在左边缘留下约 8px 浅色条，属既有抽屉样式，未改布局。

## 6. P1 组件 CSS 修复（第二轮，本次交付）

针对第 5 节 P1-1：把组件级 CSS 接入 `--font-scale`，并补齐浅色主题下的硬编码深色。
仅改 `apps/web/src/components/**/*.css`，未动 `styles.css` / `.tsx` / App / useChat / protocol。

### 6.1 字号改造（229 条 selector 声明）

所有 `font-size: <N>px` → `font-size: calc(<N>px * var(--font-scale, 1))`，保留原值作默认（scale=1 外观不变）。
装饰性尺寸（图标宽高、圆点、间距、命运环）与全部 `line-height`（本批文件均为无单位比例）保持原值，未放大布局。

| 文件（绝对路径前缀 `apps/web/src/components/`） | 改写 font-size 数 |
|---|---|
| `todo.css` | 2 |
| `dock/dock.css` | 16 |
| `dock/workflow.css` | 23 |
| `settings/automations/automations.css` | 22 |
| `settings/commands/commands.css` | 17 |
| `settings/hooks/hooks.css` | 22 |
| `settings/mcp/mcp.css` | 22 |
| `settings/model/model-settings.css` | 32 |
| `settings/panels/settings-panels.css` | 15 |
| `settings/plugins/plugins.css` | 39 |
| `settings/skills/skills.css` | 19 |
| **合计** | **229** |

实测组件字号随档位变化（1440，插件页 / 右栏）：`.plugins-title` 13.6 / 16 / 20.8px，
`.plugins-btn` 11.05 / 13 / 16.9px，`.dock__tab` 10.625 / 12.5 / 16.25px（对应 0.85 / 1 / 1.3）。

### 6.2 浅色主题硬编码深色修复

- 6 个设置子页（automations / commands / hooks / mcp / plugins / skills）的主按钮保留深色档
  `color: #06131c`（深色档 `--brand-strong` 为亮色，需深字），并在各自 CSS 末尾追加
  `.theme-light .<prefix>-btn-primary { color: #ffffff; }`，与 `styles.css` 中 `.theme-light .btn.primary`
  的黑底白字口径一致；浅色下「安装插件 / 新增」按钮实测白字可读。
- 同 6 个文件的危险按钮：`border-color: #5c2b2b` / `color: #ffb4b4` / `border: 1px solid #5c2b2b`
  分别改为主题感知的 `var(--danger-border)` / `var(--danger-fg)`（共 15 处）。
- 状态色染色改为从主题 token 派生（11 处）：`rgba(74,222,128,…)` / `rgba(248,113,113,…)`
  → `color-mix(in srgb, var(--ok) <N>%, transparent)` /
  `color-mix(in srgb, var(--warn) <N>%, transparent)`，分布为
  automations 5、mcp 4、`dock.css` 2。
- 保留未改：模态遮罩 `rgba(0,0,0,.55/.6)` 与黑色 `box-shadow` 属跨主题通用的压暗/投影，浅色下可读，非文字色。

### 6.3 验证与截图

- `pnpm --filter @witcode/web typecheck`：通过；`pnpm --filter @witcode/web build`：通过（仅既存 >500 kB chunk 提示）。
- Playwright 1.65 / Chromium headless，服务端 `127.0.0.1:21004`。视口 **1440×900 / 390×844**，
  字号 **0.85 / 1 / 1.3**，主题 **dark / light**，页面：主界面、右栏工作流、设置页
  常规 / 外观 / 模型 / 插件，另含自动化 / MCP / 技能 / 钩子 / 命令三档浅色配色复核。
- 共 **102 张**截图：`docs/screenshots/parity-component-{main,workflow,general,appearance,models,plugins,automations,mcp,skills,hooks,commands}-{dark,light}-{1440,390}-{0_85,1,1_3}.png`；
  明细 JSON：`docs/visual/.parity-component.json`，脚本：`tools/component-parity-shots.cjs`。
- **console error = 0**（102/102）；**横向溢出 = 0**（每组 `scrollWidth === innerWidth`，1440 / 390）；
  按元素级 `scrollWidth/clientWidth`、`scrollHeight/clientHeight` 与 `overflow/text-overflow`
  的裁切探针命中 **0**。根字号实测 11.9 / 14 / 18.2px，确认三档真实生效。
- 注意测试口径：服务端设置经 WS 覆盖主题与字号，脚本须在 `addInitScript` 拦截
  `--font-scale` 的 `setProperty`，并在应用初始化后强制 `.theme-light` class，否则测到的是服务端默认值。
  元素截图前另有一次显式写回，避免被回写覆盖。

### 6.4 残余问题

- **P0：无。** 浅色主按钮由黑底黑字修复为黑底白字，危险按钮/状态标签浅色下可读；三档缩放下无溢出、无裁切、0 console error。
- **P1（仍需后续，受本次范围限制）：**
  1. 主按钮深色档前景色 `#06131c` 仍为字面量（靠 `.theme-light` 覆盖解决）。若后续在 `styles.css`
     增加 `--brand-contrast` 语义 token，可替换为 `var(--brand-contrast)` 并删除 6 条覆盖规则。
  2. 状态色使用 `color-mix(in srgb, …)`，需 Chromium 111+ / Safari 16.2+；目标环境 Chromium 159 无问题，
     如需更老浏览器兼容应改为预计算色值或显式 `.theme-light` 覆盖。
  3. 390 下设置导航为 48px 横向滚动条，末项在右边缘被截断属该降级模式既有设计
     （文档级 `scrollWidth` 仍等于 `innerWidth`，可横向滚动），未改组件结构。
  4. 自动化/MCP/插件的确认框仍用黑色半透明遮罩与阴影；已确认两主题下可读，未改。
- **P2：** `tools/fontscale-components.mjs`、`tools/fix-component-colors.mjs`、
  `tools/fix-component-colors-2.mjs` 为一次性转换脚本，保留供审计复现，不参与构建。
