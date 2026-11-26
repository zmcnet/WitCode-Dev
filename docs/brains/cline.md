# Cline（`main` 分支）脑子拆解

只描述"是什么、怎么用"，不作优劣评价。所有 `文件:行号` 相对于仓库根 `D:\Files\Projects\WitCode\resources\agents\cline`。
许可证 Apache-2.0。行为层在 `sdk/packages/shared/src/prompt`（system prompt 模板、模式契约、用户消息封装）与
`sdk/packages/core/src/extensions`（工具定义、命令闸门、压缩）；运行时编排在 `sdk/packages/core/src/runtime`。

---

## 1. 它的"脑子"由什么组成

| 成分 | 文件 | 一句话 |
|---|---|---|
| 身份 / 规则 | `sdk/packages/shared/src/prompt/system/act.ts:1-36`；`yolo.ts:1-40` | 两套完整长模板：Act 与 YOLO |
| 模式契约 | `sdk/packages/shared/src/prompt/cline.ts:15-53` | plan/act 标签说明 + plan 行为契约（含手动切换版） |
| 上下文 | `cline.ts:79-120,200-212`；`format.ts:1-41` | `<env>`、`<user_input mode>`、`<mode_notice>`、工作区元数据 |
| 工具纪律 | `sdk/packages/core/src/extensions/tools/definitions.ts` | 每个工具的 description 写用途+并行纪律+边界 |
| 压缩 | `sdk/packages/core/src/extensions/context/compaction-shared.ts:694-728` | 五节摘要请求 + basic/agentic 两策略 |
| 子代理 | `sdk/packages/core/src/extensions/tools/team/subagent-prompts.ts` | 复用 Cline system prompt 包一层 teammate 角色 |
| 硬闸门 | `extensions/tools/command-guard.ts:1-16`；`runtime/orchestration/runtime-builder.ts:580-595` | plan 模式命令黑名单，beforeTool 钩子硬拦截 |

**关键结论：Cline 的"脑子"= 三段模板（Act/YOLO/Plan 契约）+ 占位符注入 + 工具级并行纪律，
并由"模式开关 + 命令闸门 + 审批"三层保证落地。** 人格文本不算特别长，但"无工具调用视为完成"
"提交前必须验证"这类终止条件写得很硬（`act.ts:30-32`；`yolo.ts:31-38`）。

---

## 2. system prompt 的结构与顺序

### 2.1 装配管线

`buildClineSystemPrompt()`（`cline.ts:152-213`）是唯一装配点：
- 若有 `overridePrompt` 且非空，直接返回它（Cline provider 会补工作区元数据段），
  即"整体替换"（`:169-179`）；
- 否则按 mode 选 `DEFAULT_CLINE_SYSTEM_PROMPTS.YOLO` 或 `.ACT`（`:181-184`；`system/index.ts:4-9`）；
- 规则段 = 调用方 `rules` + plan/act 标签说明（非 yolo）+ plan 契约（plan 时，按 host 是否暴露
  `switch_to_act_mode` 选自动/手动版），用空行拼接（`:186-198`）；
- 最后替换五个占位符：`{{PLATFORM_NAME}}`、`{{CWD}}`、`{{CURRENT_DATE}}`、`{{IDE_NAME}}`、
  `{{CLINE_METADATA}}`、`{{CLINE_RULES}}`（`:200-212`）。

### 2.2 分节表

| # | 分节 | 内容 | 来源 |
|---|---|---|---|
| 1 | 身份句 | Act: "你是 Cline，AI 编码 agent"；YOLO: "后台工作的谨慎 agent，无法与用户直接沟通" | `act.ts:1`；`yolo.ts:1-3` |
| 2 | 工作法 | 先收集上下文、核对约定/库/命令、结尾验证 | `act.ts:3-5,24-26`；`yolo.ts:29-35` |
| 3 | `<env>` | 平台、日期、IDE、工作目录 | `act.ts:7-13`；`yolo.ts:20-26` |
| 4 | Remember 条款 | 用现有约定、完整代码、绝对路径、并行调用、写完核对 | `act.ts:15-24`；`yolo.ts:5-18` |
| 5 | 终止条件 | "响应里必须带工具调用直到完成；无工具调用视为最终答复完成" | `act.ts:30`；`yolo.ts:36-38` |
| 6 | `{{CLINE_RULES}}` | 调用方规则 + 模式标签说明 + plan 契约 | `cline.ts:186-198` |
| 7 | `{{CLINE_METADATA}}` | `# Workspace Configuration` JSON：工作区路径、hint、远程 URL（脱敏）、git 分支/commit | `cline.ts:55-120,205-210` |

### 2.3 动态注入 / 缓存锚点

**没有 stable/dynamic 标记，也没有 cache-control 锚点。**
每次请求由 `buildClineSystemPrompt()` 整体重建；模式切换时重建运行时（`runtime-builder.ts:580-595`）。
用户消息在 outbound 前经 `formatUserInputBlock()` 包成 `<user_input mode="act|plan|yolo">`（`format.ts:5-9`），
模式切换点前置 `<mode_notice>`（`:35-41`），并在显示层剥离。
**结论：Cline 的"动态"靠消息包装与模式重建，不是靠 system 段 diff。**

---

## 3. 工具描述写法

共同结构：**用途句 → 何时用/批量并行 → 边界与参数细节 → 错误/截断语义**。示例与格式规范内嵌在描述里。

- **read_files**（`definitions.ts:274-283`）：用途"按绝对路径读文本/图片，可给 1-based 行区间"；
  何时用——已知多个文件就一次全读、与其他独立调用同轮发出；边界——单次上限行数/字符数、超长报总行数并翻页、
  非图片二进制与超大文件不支持。
- **search_codebase**（`definitions.ts:371-381`）：用途"全库正则搜索"；何时用——找模式/函数定义/类名/import，
  多个独立模式合并一次调用；边界——每查询超 ~N k 字符中间截断，"窄模式胜于宽模式"；
  执行器可重试一次（`:380-381`）。
- **run_commands**（`definitions.ts:421-435,530-531`）：用途"列文件、查 git、构建、测试"；
  纪律——命令必须非交互（用 `git --no-pager` 等绕开 pager）；
  PowerShell 专段：反引号转义、路径用单引号、用 `Remove-Item -LiteralPath` 而非 `cmd /c`、
  递归删除前用 `-WhatIf` 核对目标——"模型默认用 bash 转义，会把 `\` 误当转义致删到盘根"（`:425-435`）。
- **editor / apply_patch**（`definitions.ts:719-724,619-641`）：editor 用途"精确小改动或新建，优先于 shell"；
  多处不重叠改动同轮发多个调用；apply_patch 用规范自由格式补丁语法，`@@` 消歧、拒绝空改动、不回滚。

---

## 4. 模式（Act / Plan / YOLO）

三种模式同时改提示词、工具集与运行时钩子，**是最完整的"软+硬"组合**：

| 模式 | 提示词层 | 工具集 | 硬约束 |
|---|---|---|---|
| act | 长模板 `act.ts:1-36` + 标签说明 | 全量：read/search/bash/web/editor/skills/question/agent（`presets.ts:25-37`） | 默认审批 |
| plan | Act 模板 + `# Plan Mode` 契约（`cline.ts:28-53`） | 同 act 但 `enableEditor:false`（`presets.ts:45-57`） | 命令黑名单 + beforeTool 硬拦（`command-guard.ts:1-16`；`runtime-builder.ts:580-595`） |
| yolo | 独立长模板 `yolo.ts:1-40`，去掉 plan/act 标签说明（`cline.ts:186-190`） | 精简：有 `submit_and_exit`、无 question/web/派代理（`presets.ts:98-110`） | 工具策略全 `auto-approved`（`presets.ts:137-152`） |

Plan 契约细读（`cline.ts:28-43`）：只读探查、可问澄清、给结构化计划与权衡；明确禁止编辑/破坏性命令；
`run_commands` 保留但仅只读，文件编辑类命令（rm/mv/cp、sed -i、重定向到 /tmp 外、改工作树的 git、安装）
**被硬阻断并返回工具错误**；用户明确批准后才调用 `switch_to_act_mode`，且**不得在提交计划的同一轮调用**。
不暴露该工具的 host（VS Code）用手动版，让用户拨 Plan/Act 开关（`:45-53`）。
YOLO 强调"验证靠执行不靠假设"、"修不好就停手换思路"、"只有 evidence 满足才 `submit_and_exit` 且 verified 填 true"
（`yolo.ts:10-14,29-38`）。

---

## 5. 提示词怎么落地

| 提示词要求 | 落地机制 | 位置 |
|---|---|---|
| plan 只读 | 工具预设去掉 editor + 命令黑名单 beforeTool 钩子 + 审批前拦截 | `presets.ts:45-57`；`command-guard.ts:1-16`；`runtime-builder.ts:580-595` |
| 模式切换语义 | 每条用户消息带 `<user_input mode>`，切换点带 `<mode_notice>`，契约解释"最新消息模式为准" | `format.ts:5-9,35-41`；`cline.ts:15-17` |
| "别问、直接做" | 写在 Act 模板；权限/审批由运行时工具策略决定 | `act.ts:28`；`presets.ts:137-152` |
| 完成才收尾 | YOLO 用 `submit_and_exit` 工具 + verified 字段强制证据 | `yolo.ts:36-38` |
| 并行调用 | 工具 description 里写"独立调用同轮发" | `definitions.ts:277-279,375,724` |
| PowerShell 安全 | 工具 description 专段 + `-WhatIf` 建议 | `definitions.ts:425-435` |
| 压缩不丢事实 | 摘要生成禁工具、超长判失败、不完整 done 标记 | `summary-generation.ts:18-44` |

**踩空逻辑**：Cline 的 plan 约束有三重保险（提示词、工具集、命令闸门），
这是"提示词不踩空"的教科书案例；只搬 `# Plan Mode` 文本而不接命令黑名单，模型照样能 `rm`。

---

## 6. 模型适配

### 6.1 Provider 无关，带统一推理/缓存设置

`provider-settings.ts` 把 reasoning 抽成 `effort` 与 `budgetTokens`（`:74-75`），
并有 `cacheTtlMs`（`:135`）、`reasoning` 开关（`:155,267-269`）。
统一 `unifiedReasoningLevel` 默认 `none`，再映射到各家 `reasoningEffort`（`:211-269`）。
模型能力通过 provider handler 转换（`apihandler-agent-model-adapter.ts`）。

### 6.2 思考 / 工具格式 / 缓存

- **思考**：流式 `reasoning` chunk 映射为 `reasoning-delta`，并保留 `thoughtSignature` 到 metadata
  以免下游丢弃（`apihandler-agent-model-adapter.ts:37-60`）；usage 单列 reasoning token（`:75`）。
- **工具格式**：工具用 Zod → JSON Schema（`definitions.ts:282,378`），
  `apply_patch` 走自由格式字符串（`:619-641`）；外部 tool call id 归一化有测试覆盖。
- **缓存**：usage 里有 `cacheReadTokens`/`cacheWriteTokens`（`:73-74`），provider 可设 `cacheTtlMs`（`:135`）。
- **子代理**：仅 Cline provider 复用主 system prompt 包 teammate 角色，其他 provider 直接用传入 prompt
  （`subagent-prompts.ts:5-33`）。

### 6.3 一句话总结

Cline 不为某个模型写专用提示词，而为"各家 reasoning effort + 工具 JSON Schema + 缓存 TTL"做统一适配，
提示词保持稳定。只搬文本不接 provider 适配，签名/思考与缓存字段会丢。

---

## 7. 踩空点（只搬提示词会缺什么）

1. **命令闸门**：Plan 文本没有 `command-guard.ts` 的黑名单与 beforeTool 钩子，等于只读承诺无实现。
2. **模式运行时重建**：工具预设与 `switch_to_act_mode` 随模式切换重建（`runtime-builder.ts:580-595`）；
   没有它，提示词提到的工具可能不在工具面里。
3. **用户消息包装**：`<user_input mode>` 与 `<mode_notice>` 由 `format.ts` 注入；缺了它，模型无法判断"当前模式以最新消息为准"。
4. **压缩两策略**：basic 用 `<SYSTEM_NOTICE>` 桥接被丢的工具活动（`basic-compaction.ts:82-91`），
   agentic 用 LLM 摘要（`agentic-compaction.ts`）；摘要生成禁工具、超长/不完整判失败（`summary-generation.ts:18-44`）都没了。
5. **终止协议**：YOLO 的 `submit_and_exit` + verified 是"完成"的硬信号，纯文本没有等价物。

---

## 8. Brain 草案（可做成 `packages/brains/src/cline.ts` 的提炼）

**identity**（3-6 行）
```
你是 WitCode 的编码 agent，用工具推进用户目标；Act 下先收集上下文、跟随现有约定，结尾验证改动。
Plan 下只探查、分析与规划，给出可执行步骤与权衡，不编辑文件；用户明确批准后才进入 Act。
YOLO 下后台自主完成：验证靠执行证据，不满足就不收尾。
引用文件用绝对路径；独立调用放在同一轮并行发出。
```

**rules**（4-8 条）
1. 动手前读相关文件、确认命名/框架/库/测试命令；只用代码库里确认在用的库。
2. 局部改动用精确替换/补丁，多处不重叠改动同轮发；新建或整体重写才用 write。
3. 写完核对：运行测试或实际执行，读回输出确认；"应该能用"不算完成。
4. Plan 只读：run_commands 仅用于只读探查；文件编辑类命令会被硬阻断，改需求写进计划。
5. 用户消息带模式标签，以最新消息的模式为准；模式切换点会显式标注。
6. 有限重试：同类修复连续失败且无新证据，停下做一次最小复现再换思路。
7. 不为没改过的东西做回退/重置；破坏性命令先核对确切目标。

**tools.descriptions**（4 个）
- `read_files`：用途"按绝对路径读文本/图片，可给 1-based 行区间"；何时用——已知多文件一次读、与其他独立调用同轮；不用——超长文件先翻页；上限与截断写在参数。
- `search_codebase`：用途"全库正则搜索"；何时用——找模式/定义/import，多模式合并一次；不用——宽模式会中间截断，收窄再搜。
- `run_commands`：用途"列目录/查 git/构建/测试"；纪律——必须非交互；PowerShell 用反引号与单引号、`Remove-Item -LiteralPath`、递归删除前 `-WhatIf`。
- `editor`：用途"对已有文件做精确小改动或新建，优先于 shell"；何时用——已知多处不重叠改动同轮发；不用——大段重写用 write/patch。

**modes**：`plan`（软契约 + editor 关闭 + 命令黑名单硬拦 + 需用户批准才切 act）；`act`（全量工具 + 审批）；`yolo`（精简工具 + 自动批准 + `submit_and_exit`/verified 终止协议）。

**prompts.compact**（要点）
- 摘要请求五节：Goal（一句）/ State（Done, In Progress, Blocked）/ Highlights（关键技术选择）/ Next（立即下一步）/ Files（Read, Edited 列表）。
- 附"上一份摘要"与序列化对话；摘要生成禁工具，超 maxOutputChars 或不完整结束判失败。
- basic 策略把丢弃的工具活动压成 `<SYSTEM_NOTICE>` 桥接块；agentic 策略用可配置 summarizer 重新生成。

**flow**：`tool.resolveBeforePermission` 未显式提供（权限在运行时工具策略 + beforeTool 钩子）；`compaction.strategy='agentic'`（默认，另有 basic）；`approval='ask'`（yolo 为 auto-approved）。

**modelProfile**：`preferredModels` 不设（provider 无关）；`reasoning='separate'`（effort/budgetTokens 映射 + thoughtSignature 保留）；
`toolCallFormat='openai'`（Zod→JSON Schema，apply_patch 自由格式）；`cache='prefix'`（cacheTtlMs + cacheRead/Write token）；`emptyResponseRetry` 未内置（摘要走流式失败标记）。
