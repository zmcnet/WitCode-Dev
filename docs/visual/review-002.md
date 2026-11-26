# 视觉评审 002 — P2 设置页（模型管家）

评审人：Visual-1
日期：2026-11-26
方式：静态代码审阅（未运行浏览器自动化）
范围：
- `apps/web/src/App.tsx`
- `apps/web/src/useChat.ts`
- `apps/web/src/components/ModelSelector.tsx`
- `apps/web/src/components/settings/SettingsView.tsx`
- `apps/web/src/components/settings/ProvidersPanel.tsx`
- `apps/web/src/components/settings/UsagePanel.tsx`
- `apps/web/src/styles.css`
参照：`packages/protocol/src/index.ts`、`docs/p2-acceptance.md`、`docs/visual/review-001.md`

结论：P2 的骨架与视觉层次已经成形，但**「保存/删除的结果反馈」与「表单校验可见性」两条链路是断的**——设置页不渲染错误条，保存后表单立即关闭且不等待结果，`modelIds` 可空提交。这三项直接卡住验收单 C 与 F。下面按 P0/P1/P2 列出 15 个具体问题，全部给出 `文件:行号` 与改法。

## 严重度汇总

| 编号 | 严重度 | 位置 | 问题一句话 |
|---|---|---|---|
| P0-01 | P0 | `App.tsx:36-44,55`、`SettingsView.tsx:11-18,33-80` | 错误条只挂在聊天视图，设置页无任何错误/断线提示通道 |
| P0-02 | P0 | `ProvidersPanel.tsx:64-76,78-81`、`useChat.ts:309-317` | 保存/删除无 pending 与结果态，失败被静默吞掉 |
| P0-03 | P0 | `ProvidersPanel.tsx:28-33,64-76,129-139` | `modelIds` 为空可提交，违反验收单 C「至少一个」 |
| P0-04 | P0 | `ProvidersPanel.tsx:101-118` | 仅有 HTML5 `required`，无可见错误文案与 `aria-invalid`，纯空格可绕过 |
| P1-05 | P1 | `ProvidersPanel.tsx:78-81,194-201` | 删除用原生 `confirm`，且按钮无可读名称，无法区分删的是谁 |
| P1-06 | P1 | `styles.css:925-931,961-966`、`ProvidersPanel.tsx:170,177,186-188` | 长 baseUrl / key hint 换行撑高卡片，截断策略不一致且无 `title` |
| P1-07 | P1 | `styles.css:1018-1036`、`UsagePanel.tsx:110-117` | 用量表格长模型名靠整表横向滚动，768 下要拖很久才看到结果列 |
| P1-08 | P1 | `SettingsView.tsx:30`、`App.tsx:36-44`、`ProvidersPanel.tsx:36-38` | 与聊天视图来回切换后 tab 归位、未提交表单丢失 |
| P1-09 | P1 | `ModelSelector.tsx:16-23`、`ProvidersPanel.tsx:58-62` | 模型菜单与 Provider 表单都不支持 Esc 关闭 |
| P1-10 | P1 | `SettingsView.tsx:44-63` | tablist 缺 `aria-controls`/`tabpanel` 与左右方向键导航 |
| P1-11 | P1 | `useChat.ts:54,66-69,228-231`、`ProvidersPanel.tsx:160-164`、`UsagePanel.tsx:68-73,103-108` | 加载中与真空态无法区分，首开即闪「还没有提供商」 |
| P2-12 | P2 | `ModelSelector.tsx:63-76`、`styles.css:660-665` | 菜单项长模型名截断后无 `title`，读不到完整名称 |
| P2-13 | P2 | `styles.css:635-649,671-721,769-788` | 无统一 `:focus-visible`，按钮键盘焦点只靠浏览器默认 |
| P2-14 | P2 | `UsagePanel.tsx:15-23,118-125` | 记录时间无年份、失败原因只在 `title`，读屏与跨年对账都不可用 |
| P2-15 | P2 | `styles.css:993-997,1104-1108` | 768 下三张统计卡强制单列堆叠，浪费纵向空间 |

---

## P0 — 阻塞验收

### P0-01 设置页没有错误与连接状态展示通道

- **位置**：`apps/web/src/App.tsx:36-44`（settings 分支）、`apps/web/src/App.tsx:55`（`ErrorBanner` 位于 `else` 的聊天分支内）；`apps/web/src/components/settings/SettingsView.tsx:11-18`（Props 无 `error`）、`33-80`（渲染树无错误条）
- **问题**：
  1. `useChat.ts:88` 的 `socket.onerror` 与 `useChat.ts:207-215` 的服务端 `error` 消息都会写入 `state.error`，但 `ErrorBanner` 只在聊天视图渲染。用户在设置页保存失败、断线时**看不到任何文字反馈**。
  2. `connected` 虽传入 `SettingsView`（`App.tsx:40`），但只被 `ProvidersPanel` 用来禁用按钮（`ProvidersPanel.tsx:150,197`），设置页没有「未连接」说明，禁用态形同静默失败。
  3. 验收单 C「保存」与 F「表单错误有明确提示」无法满足。
- **改法**：把 `error`、`connected` 提升为 `SettingsView` 的 Props，在 `settings-head` 下方渲染 `<ErrorBanner message={error} onClose={...} role="alert" />`；断开时在该区域显示常驻文案「连接已断开，保存/删除暂不可用」并给出「重连」入口；`useChat` 中 `openSettings` 时清掉上一次残留错误，避免旧错误误导。

### P0-02 保存/删除无 pending 与结果态，失败被静默吞掉

- **位置**：`apps/web/src/components/settings/ProvidersPanel.tsx:64-76`（`submit` 调用 `onSave` 后立刻 `closeForm()`）、`78-81`（`remove` 仅 `confirm` 后发消息）；`apps/web/src/useChat.ts:309-312`（`saveProvider` 只 `sendMessage`）、`314-317`（`deleteProvider` 同上）
- **问题**：
  1. 点击「保存」后表单立即关闭（`ProvidersPanel.tsx:75`），用户失去正在编辑的内容，但既没有「保存中」，也没有「保存成功/失败」。服务端返回 `error` 时（`useChat.ts:207-215`）界面看起来像什么都没发生。
  2. 删除点击确认后按钮仍可点击，没有「删除中」禁用，连点会发多条 `providers:delete`；服务端拒绝时列表不变且无提示。
  3. 请求与响应无关联 id：同时保存/删除多个条目时无法把回包对应到具体行。
- **改法**：在 `useChat` 增加 `pending: Record<string, 'saving'|'deleting'>` 与 `actionError`，`providers:save`/`providers:delete` 携带 `requestId`，收到 `providers` 回包或 `error` 后按 id 结算；`ProvidersPanel` 的保存按钮显示「保存中…」并 `disabled`，删除行显示「删除中…」且整行禁用；只有成功后才 `closeForm()`，失败保留表单内容并在表单内显示错误（配合 P0-01）。`window.confirm` 期间也应锁住按钮，防止重复提交。

### P0-03 `modelIds` 为空可提交

- **位置**：`apps/web/src/components/settings/ProvidersPanel.tsx:28-33`（`parseModelIds` 对空串返回 `[]`）、`64-76`（`submit` 无校验直接 `onSave`）、`129-139`（textarea 无 `required`、无错误提示）
- **问题**：模型 ID 输入框可以完全留空，`parseModelIds('')` 返回 `[]`，`ProviderInput.modelIds` 以空数组发给服务端（`useChat.ts:309-312`）。验收单 C 明确要求「modelIds 至少一个」，当前实现直接不通过；空 `modelIds` 的 provider 在顶栏模型选择器（`ModelSelector.tsx:55-57`）里也永远不贡献可选模型。
- **改法**：在 `submit` 中先 `const modelIds = parseModelIds(form.modelIdsText); if (!modelIds.length) { setFieldError('modelIds', '请至少填写一个模型 ID'); return; }`；给 textarea 加 `aria-invalid` 与 `aria-describedby`，并在其下方渲染红字错误行。建议同时在前端去重（与后端 `modelIds 去重、去空` 的约定保持一致）。

### P0-04 表单无可见校验错误，纯空格可绕过 `required`

- **位置**：`apps/web/src/components/settings/ProvidersPanel.tsx:101-108`（name `required`）、`110-118`（baseUrl `required`）、`64-72`（`submit` 里 `trim()` 后才提交）
- **问题**：
  1. 只有浏览器原生 `required` 气泡，没有字段旁的持久错误文本、没有 `aria-invalid`、没有错误态边框；验收单 F「表单错误有明确提示」不通过。
  2. 输入 `"   "` 能通过 `required`（非空字符串），但 `submit` 的 `form.name.trim()` / `form.baseUrl.trim()` 会得到空串并照常提交，产生名为空的 provider（卡片回退显示「未命名提供商」，`ProvidersPanel.tsx:170`）。
  3. baseUrl 未校验格式，`abc` 也能保存。
- **改法**：把校验收口到 `submit`：分别 `name = form.name.trim()`、`baseUrl = form.baseUrl.trim()`，为空则写 `fieldErrors` 并 `return`；`baseUrl` 用 `new URL()` 校验协议为 `http(s):`。新增 `fieldErrors: { name?: string; baseUrl?: string; modelIds?: string }` 状态，在每个 `.form-field` 内渲染 `<span className="form-error" role="alert">`，输入框加 `aria-invalid={Boolean(...)}` 与 `aria-describedby`，CSS 增加 `.form-field.invalid input { border-color: var(--warn) }`。不要用 `alert()`。

---

## P1 — 影响验收质量

### P1-05 删除确认不清晰，且按钮无可读名称

- **位置**：`apps/web/src/components/settings/ProvidersPanel.tsx:78-81`（`window.confirm`）、`194-201`（`删除` 按钮）
- **问题**：确认文案「确定删除提供商「X」吗？此操作不可撤销。」只说了不可撤销，没说该 provider 下模型会从顶栏消失、历史用量不会被清除，用户无法判断影响范围；原生 `confirm` 与暗色主题割裂，无焦点管理，Playwright 需额外处理 dialog。所有删除按钮的可读名称都是「删除」，读屏用户在列表里连续听到同名按钮，无法分辨目标。
- **改法**：改用页内确认弹层（`<dialog>` 或受控 div），标题写明 provider 名，正文列出影响项，主按钮文案改为「确认删除「X」」并默认聚焦「取消」；按钮补 `aria-label={`删除提供商 ${provider.name}`}`；确认框支持 Esc 关闭并把焦点还给原删除按钮。

### P1-06 长文本截断策略不一致

- **位置**：`apps/web/src/styles.css:925-931`（`.provider-name` ellipsis）、`961-966`（`.provider-value { overflow-wrap: anywhere }`）；`apps/web/src/components/settings/ProvidersPanel.tsx:170`（name）、`177`（baseUrl）、`186-188`（apiKeyHint）
- **问题**：名称截断成省略号但没有 `title`，鼠标悬停看不到全名；baseUrl 与 key hint 用 `overflow-wrap: anywhere` 换行，超长 URL/hint 会把卡片撑成多行、同排卡片高度参差；三种文本表现不一致。768 以下卡片单列时尤为明显。
- **改法**：给 `.provider-name`/`.provider-value` 统一 `display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`，并在 JSX 上补 `title={provider.name}`、`title={provider.baseUrl}`、`title={provider.apiKeyHint}`；确需展示完整 baseUrl 时改为「省略 + 点击展开」，不要无声换行。key hint 可限定最大宽度并提前在服务端生成短串。

### P1-07 用量表格长模型名导致整表横向滚动

- **位置**：`apps/web/src/styles.css:1018-1022`（`.table-wrap { overflow-x:auto }`）、`1030-1036`（`td { white-space:nowrap }`）；`apps/web/src/components/settings/UsagePanel.tsx:110-117`（`record.model` 直接输出）
- **问题**：7 列表格在 `white-space:nowrap` 下由最长模型名决定总宽，768 视口用户必须横向拖动整个表格才能看到「耗时/结果」列；单元格也没有 `title`，长模型名即使滚动也难以阅读。
- **改法**：给「模型」「提供商」列设 `max-width` + ellipsis + `title`；结果列固定在右侧（或缩短表头与 token 列宽）；768 下改为卡片式记录列表，避免 7 列横滚。

### P1-08 与聊天视图切换时状态丢失

- **位置**：`apps/web/src/components/settings/SettingsView.tsx:30`（`tab` 为组件内 state）、`apps/web/src/App.tsx:36-44`（条件渲染导致卸载）、`apps/web/src/components/settings/ProvidersPanel.tsx:36-38`（`formOpen`/`editing`/`form`）
- **问题**：`SettingsView` 在切回聊天时整体卸载，`tab` 回到 `'providers'`；用户停在 Usage 看数据、回聊天发一条消息再进设置，会被强制送回 Providers。未提交的表单内容也一并丢失，且没有「有未保存修改，确认离开吗」提示。
- **改法**：把 `tab` 提升到 `useChat` 或 `App`（与 `view` 同级持久化）；`SettingsView` 始终挂载、用 `hidden` 切换两块内容，避免卸载；表单未提交时用 `dirty` 标志拦截返回或在切回时保留草稿。

### P1-09 Esc 关闭缺失

- **位置**：`apps/web/src/components/ModelSelector.tsx:16-23`（只监听 `mousedown`）、`apps/web/src/components/settings/ProvidersPanel.tsx:58-62`（`closeForm` 仅由取消按钮触发）
- **问题**：模型菜单打开后按 Esc 无效，表单打开后按 Esc 也无效；键盘用户只能 Tab 到「取消」或点击外部，违背常见弹层预期；菜单关闭后焦点没有回到触发按钮。
- **改法**：在两个组件各加 `useEffect`，`open`/`formOpen` 时监听 `keydown`，`event.key === 'Escape'` 则关闭；关闭时 `triggerRef.current?.focus()`；菜单打开时给菜单容器 `role="menu"`，并把焦点移到第一项，配合上下键导航。

### P1-10 Tabs 的无障碍契约不完整

- **位置**：`apps/web/src/components/settings/SettingsView.tsx:44-63`（`role="tablist"` + 两个 `role="tab"`，`aria-selected` 已有）
- **问题**：缺少 `aria-controls`，内容区没有 `role="tabpanel"` / `aria-labelledby`；按左右方向键不会切 tab，只能 Tab 遍历两个按钮。读屏用户无法感知「tab 控制哪块内容」，也不符合 WAI-ARIA Tabs 模式。
- **改法**：给两个 tab 加 `id` 与 `aria-controls`，给 `.settings-scroll` 内容加 `role="tabpanel" id aria-labelledby` 并按需 `tabIndex={0}`；在 tablist 上监听 `ArrowLeft`/`ArrowRight`/`Home`/`End` 切换聚焦并激活；未激活 tab 设 `tabIndex={-1}`（roving tabindex）。

### P1-11 加载态与空态无法区分

- **位置**：`apps/web/src/useChat.ts:54`（`usage` 初值）、`66-69`（`requestSettingsData`）、`228-231`（`usage` 回包）；`apps/web/src/components/settings/ProvidersPanel.tsx:160-164`（空态）；`apps/web/src/components/settings/UsagePanel.tsx:68-73,103-108`（表格空态）
- **问题**：首次打开设置时 `providers=[]`、`usage.summary=null`，界面立刻显示「还没有提供商，先加一个」和统计卡片的 `0`；如果数据尚未回包或回包失败，这就是**误报的空态**。`summary=null`（未加载）与真实零用量在 UI 上完全一样，用户无法判断是否还要等待。
- **改法**：增加 `settingsLoading: boolean`（`openSettings`/`requestSettingsData` 时置 true，收到 `providers` + `usage` 后置 false），加载中显示骨架屏或「加载中…」；空态只在 `!loading && list.length===0` 时出现；统计卡在 `summary===null` 时显示「—」而不是 `0`。

---

## P2 — 打磨项

### P2-12 模型菜单项截断后不可读

- **位置**：`apps/web/src/components/ModelSelector.tsx:63-76`（`.model-menu-item` 内仅文本）、`apps/web/src/styles.css:660-665`（`.model-menu-name` ellipsis）
- **问题**：`providerName / id` 组合过长时被省略号截断，菜单项没有 `title`，用户无法读到完整模型 ID；顶栏按钮虽有 `title`（`ModelSelector.tsx:44`）但菜单项没有。
- **改法**：给 `.model-menu-item` 加 `title={`${model.providerName} / ${model.id}`}`；长名称可改为两行展示（provider 名小字 + 模型 ID 主行）。

### P2-13 无统一 `:focus-visible`

- **位置**：`apps/web/src/styles.css:635-649`（`.model-menu-item`）、`671-721`（`.btn`）、`769-788`（`.settings-tab`）
- **问题**：按钮样式只在 `:hover` 改变边框，没有显式 `:focus-visible`；输入框用 `outline:none` 仅靠 border-color（`styles.css:869-876`），对比度不足。键盘焦点依赖浏览器默认环，部分按钮 border 变化不明显。
- **改法**：全局补 `:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px }`，并把输入框的 `outline:none` 替换为 `:focus-visible` 专属样式，保证 2px 以上可见焦点。

### P2-14 时间无年份，失败原因仅存在于 `title`

- **位置**：`apps/web/src/components/settings/UsagePanel.tsx:15-23`（`formatTime` 只输出月/日/时/分/秒）、`118-125`（`title={record.error}`）
- **问题**：跨年记录会显示成相同时间；失败行的具体错误只在 `title` 悬停可见，读屏软件读不到，用户也无法复制。
- **改法**：`formatTime` 加入 `year: 'numeric'`（或在跨年时显示年份）；失败行在「结果」下方追加可展开的 `sr-only` 文本或 `aria-label={`失败：${record.error}`}`，必要时提供复制按钮。

### P2-15 768 下统计卡强制单列

- **位置**：`apps/web/src/styles.css:993-997`（`.stat-grid { grid-template-columns: repeat(3, 1fr) }`）、`1104-1108`（媒体查询改为 `1fr`）
- **问题**：768 宽度把三张统计卡压成单列，占满约 250px 纵向空间，用户要滚动才能看到「按提供商」表格；同时 `.panel-head` 改为纵向后（`:1110-1112`）标题与按钮间距偏紧。
- **改法**：768 下保留三列但缩小字号与 padding（如 `grid-template-columns: repeat(3, minmax(0,1fr))`，`.stat-value` 降到 20px），或改为 `1fr 1fr` 加一张跨列卡；给 `.panel-head` 纵向布局补 `gap: 12px`。

---

## 建议修复顺序

1. P0-01 / P0-02（错误通道 + 保存/删除结果态，二者共用一套 requestId/actionError）→ 2. P0-03 / P0-04（校验与可见错误）→ 3. P1-11（加载态）→ 4. P1-08 / P1-09 / P1-10（视图切换与键盘）→ 5. P1-05 / P1-06 / P1-07（删除确认与长文本/表格）→ 6. P2 项。

## 需跨角色确认

- **Coding-3（设置页）**：P0-01/02 需要 `useChat` 暴露 `error`、`connected`、`pending` 与带 `requestId` 的 save/delete；P0-03/04 的字段级错误状态归 `ProvidersPanel`；P1-08 的 `tab` 是否上提到 `useChat` 需与 `view` 一并决定。
- **Coding-1（Provider 注册表）**：确认 `providers:save` 的响应是否回传完整 `ProviderPublic`（含 `apiKeyHint`）；前端目前靠服务端推 `providers` 列表刷新（`useChat.ts:218-221`），若改为请求-响应回包需同步协议 `packages/protocol/src/index.ts:204`。
- **后端 / 集成**：`providers:save`、`providers:delete` 失败时是否稳定发 `{ type:'error', message }`（`packages/protocol/src/index.ts:203`）；这是 P0-01/02 能否闭环的前提。
