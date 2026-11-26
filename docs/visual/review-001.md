# 视觉评审 001 — P0 Web 骨架

评审人：Visual-1
日期：2026-11-26
方式：静态代码审阅（未运行浏览器自动化）
范围：`apps/web/src/App.tsx`、`apps/web/src/styles.css`
参照：`apps/web/index.html`、`apps/web/src/main.tsx`、`apps/server/src/index.ts`、`packages/protocol/src/index.ts`

结论：P0 聊天链路可用，但**离 P1「工作台」还有结构性缺口**：连接生命周期不完整、工具消息完全未渲染、无响应式与无障碍基础设施。下面按严重程度列出 12 个具体问题，全部给出位置与改法。

## 严重度汇总

| 编号 | 严重度 | 位置 | 问题一句话 |
|---|---|---|---|
| P0-01 | P0 | `App.tsx:19` | WebSocket 地址硬编码为 `ws://localhost:8787` |
| P0-02 | P0 | `App.tsx:14,18-24,92-94` | 无「连接中/重连」态，断线后 `busy`/流式状态卡死 |
| P0-03 | P0 | `App.tsx:25-64` | `tool-call`/`tool-result` 消息未处理，工具卡片不存在 |
| P0-04 | P0 | `App.tsx:97-115`、`styles.css:84-91` | 流式输出无自动跟随与滚动锁定 |
| P1-05 | P1 | `App.tsx:109`、`styles.css:120` | 无 Markdown/代码块渲染，围栏代码按纯文本显示 |
| P1-06 | P1 | `App.tsx:53-63` | 错误被塞进普通 assistant 气泡，无错误标识与重试 |
| P1-07 | P1 | `App.tsx:118-132`、`styles.css:179-184` | 无障碍缺失：`aria-live`、输入框标签、焦点可见 |
| P1-08 | P1 | `styles.css:31-37` | 无媒体查询与侧栏布局，三档视口无法适配 |
| P1-09 | P1 | `App.tsx:69-82,130-132` | `send()` 静默失败，禁用按钮无原因提示 |
| P2-10 | P2 | `App.tsx:26` | `JSON.parse` 无保护，畸形消息会打断消息处理 |
| P2-11 | P2 | `App.tsx:48-51` | `done.text`/`sessionId` 被丢弃，最终文本无法校准 |
| P2-12 | P2 | `App.tsx:39,58,78,79` | `crypto.randomUUID` 在非安全上下文不可用 |

---

## P0 — 阻塞 P1

### P0-01 WebSocket 地址硬编码

- **位置**：`apps/web/src/App.tsx:19` — `new WebSocket('ws://localhost:8787')`
- **问题**：页面从任意非本机地址访问时必然连到用户自己的 localhost；HTTPS 部署下浏览器会因 mixed content 直接阻断。验收清单的「已连接/断开」在三档视口之外的任何环境都无法成立。
- **改法**：由当前页面推导地址并允许注入覆盖：
  `const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';`
  `new WebSocket(`${proto}//${location.host}/ws`)`（服务端 `ws` 挂在 HTTP server 上，`location.host` 已含端口）；或 `import.meta.env.VITE_WS_URL ?? ...`。
- **配套**：服务端 `apps/server/src/index.ts:17` 目前读 `PORT`，前端不该再写死 8787。

### P0-02 连接生命周期不完整（状态机缺两态，断线卡死）

- **位置**：`App.tsx:14`（`connected` 仅 boolean）、`18-24`（effect）、`23`（`onclose`）、`92-94`（状态渲染）
- **问题**：
  1. 初始 `connected=false` 直接显示「未连接」，没有「连接中」；服务端 `ready` 消息（`apps/server/src/index.ts:28`）也被忽略，无法作为握手完成信号。
  2. `onclose` 只 `setConnected(false)`，**不复位 `busy`，也不把正在流式的 assistant 消息置为 `streaming:false`**。断网时按钮停在「生成中…」、光标永久闪烁，用户无法重试。
  3. 没有重连逻辑，一旦断开只能刷新页面。
- **改法**：把 `connected: boolean` 升级为 `status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting'`；`onclose` 中同时 `setBusy(false)` 并将所有消息 `streaming:false`；加入带指数退避的 `reconnect()`，并提供「重新连接」按钮（验收清单第 4 节四态即据此断言）。

### P0-03 工具消息完全未渲染（P1 核心能力缺失）

- **位置**：`App.tsx:25-64` 的 `onmessage` 只分支 `delta` / `done` / `error`；协议已定义 `tool-call`、`tool-result`（`packages/protocol/src/index.ts:117-118`）
- **问题**：服务端发来的工具事件被静默丢弃，消息流里看不到任何调用中/成功/失败卡片；验收清单第 6 节 7 条全部无法通过。当前 `Message` 接口（`App.tsx:4-9`）也没有工具消息的建模空间。
- **改法**：扩展 `Message` 为联合类型（`text | tool-call | tool-result`），按 `message.type` 入列；新增工具卡片组件，至少包含工具名、状态标签、可折叠参数/结果、长内容滚动与 `aria-expanded`。注意服务端 `apps/server/src/index.ts` 当前也未发出工具事件，需与 Coding-3 约定字段后再联调。

### P0-04 流式输出无自动跟随 / 滚动锁定

- **位置**：`App.tsx:97-115`（`<main className="messages">` 无 ref/effect），`styles.css:84-91`（`.messages { overflow-y:auto }`）
- **问题**：消息追加后视口不会滚到底部，长回复（尤其是代码块/工具结果）会把最新内容留在可视区外；用户上滚查看历史时也会被下一次 delta 打断，无法阅读。
- **改法**：给容器加 `ref`，用 `useLayoutEffect` 在 `messages` 变化时滚到底；维护 `isPinnedToBottom` 标志（监听 `scroll`，距底部 < 24px 视为跟随），仅在该标志为真时自动滚动；新会话/发送时强制回到底部。

---

## P1 — 影响验收质量

### P1-05 无 Markdown / 代码块渲染

- **位置**：`App.tsx:109`（`{message.text}` 直接文本插值）；`styles.css:120`（`white-space: pre-wrap`）
- **问题**：` ```ts ` 围栏、行内代码、链接全部按字面文本显示；长代码无等宽字体、无横向滚动、无复制按钮。验收清单第 3 节代码块项不通过。
- **改法**：引入轻量 Markdown 渲染（如 `react-markdown` + `remark-gfm`），对 `pre/code` 增加 `overflow-x:auto`、`font-family: ui-monospace, ...`，并为代码块加复制按钮；渲染器需对流式中的不完整围栏做容错，避免每帧闪烁重排。

### P1-06 错误态与普通消息无区分

- **位置**：`App.tsx:53-63`
- **问题**：错误被构造为 `role:'assistant'` 的普通气泡，仅文本前缀「出错了：」。无错误图标/颜色/标签，无法与正常回复区分；网络断开和模型报错视觉表现相同；也没有重试入口。
- **改法**：在 `Message` 上加 `kind?: 'error'`，渲染独立 `.bubble.error`（警示色左边框 + 图标 + 「重试」按钮）；错误信息做脱敏，避免把后端堆栈原文展示给用户。

### P1-07 无障碍基础设施缺失

- **位置**：`App.tsx:97-115`（消息区无 `aria-live`）、`118-129`（textarea 仅 placeholder）、`130-132`（button 有文本但无统一焦点样式）；`styles.css:179-184`（`textarea { outline:none }` + 仅 `border-color` 变化）
- **问题**：读屏软件不会播报流式增量；输入框没有程序化可读名称；键盘焦点仅靠 1px 边框变化，对比不足；后续新增的图标按钮（侧栏开关、复制）若不补 `aria-label` 将不可读。
- **改法**：消息容器加 `aria-live="polite" aria-atomic="false"`；textarea 加 `aria-label="输入消息"` 或关联 `<label>`；统一 `:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px }`，替换 `outline:none`。

### P1-08 无响应式布局与侧栏结构

- **位置**：`styles.css:31-37`（`.app { max-width:920px; margin:0 auto }`），整个文件**没有任何 `@media` 规则**
- **问题**：1440/1280 下内容固定 920px 居中，无左侧会话列表；768 下只是缩窄的同一列，没有抽屉/折叠策略。P1 工作台的三区结构无处落位。
- **改法**：`.app` 改为 `display:grid; grid-template-columns: 260px minmax(0,1fr)`，消息区 `min-width:0`；增加断点 `@media (max-width: 1024px)` 收窄侧栏、`@media (max-width: 768px)` 改为抽屉并加遮罩与 Esc 关闭；用 CSS 变量统一间距/圆角/色阶（对应验收清单第 1、9 节）。

### P1-09 发送路径静默失败

- **位置**：`App.tsx:69-82`（`if (!text || busy || !socket || socket.readyState !== OPEN) return;`）、`130-132`（按钮 `disabled={busy || !connected}`）
- **问题**：Enter 在空输入或断开时完全无反馈；按钮禁用也没有说明原因，用户会以为界面卡住。与 P0-02 叠加时尤为明显。
- **改法**：按钮加 `title`/`aria-describedby` 说明禁用原因；断开时把按钮文案改为「未连接，点击重连」并绑定重连动作；空输入时给输入框 `aria-invalid` 或轻量提示（不弹 alert）。

---

## P2 — 打磨项

### P2-10 消息解析无保护

- **位置**：`App.tsx:26` — `JSON.parse(event.data as string) as ServerMessage`
- **问题**：服务端或代理发来非 JSON 帧时抛异常，整个 `onmessage` 中断，后续消息也受影响。
- **改法**：用 `try/catch` 包裹解析，失败时记录并走统一的 `error` 展示路径；对未知 `type` 做 no-op 兜底。

### P2-11 `done` 携带的最终文本被丢弃

- **位置**：`App.tsx:48-51`；服务端 `apps/server/src/index.ts:41` 发送 `done.text`
- **问题**：前端只用 `done` 关闭流式状态，若增量拼接与最终文本不一致（重连、截断、重复 chunk），界面会停留在错误文本且无法校正。
- **改法**：`done` 到达时把最后一条 assistant 的 `text` 校准为 `message.text`，并保存 `sessionId` 供 P1 会话列表关联。

### P2-12 `crypto.randomUUID` 的安全上下文限制

- **位置**：`App.tsx:39,58,78,79`
- **问题**：`localhost` 是安全上下文所以当前可用，但通过 LAN IP / HTTP 访问时 `crypto.randomUUID` 可能是 `undefined`，首次发送即崩溃。
- **改法**：封装 `newId()`，优先 `crypto.randomUUID?.()`，否则回退到时间戳 + 随机数（如 `Date.now().toString(36) + Math.random().toString(36).slice(2)`）。

---

## 建议修复顺序

1. P0-01 / P0-02（连接可用性）→ 2. P0-03（工具卡片，与 Coding-3 定协议）→ 3. P0-04（流式可读性）→ 4. P1-08（三档布局）→ 5. P1-05/06/07 → 6. P2 项。

## 需跨角色确认

- **Coding-3**：`tool-call`/`tool-result` 的服务端触发时机与字段（`input` 序列化方式、`ok/content/error` 映射）；`ready`/`done.sessionId` 与会话列表的关联键。
- **后端**：WebSocket 路径与端口是否收敛到 `location.host`（对应 P0-01），以及是否提供 500 错误到 `ServerMessage.error` 的稳定映射（对应验收清单第 5 节）。
