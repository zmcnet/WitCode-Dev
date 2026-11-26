# DeepSeek Harness 提示词体系拆解（DSH v0.2.3-alpha.2）

只描述"是什么、怎么运作"，不作优劣评价。**只看行为层**：提示词、工具纪律、模式、上下文、压缩、复盘。
架构层（Cordis / seam / projection）见 `docs/study/02a-dsh-core.md`，本文不重复。
`文件:行号` 相对于源码根 `D:\Files\Projects\WitCode\resources\src\deepseek-harness-dsh-v0.2.3-alpha.2`；
ZCode 对比行号相对于 `docs/ui/03-zcode-prompt-system.md`。

---

## 1. DSH 的"脑子"由什么组成

| 成分 | 文件 | 一句话 |
|---|---|---|
| 身份 | `packages/core/system-prompt/src/index.ts:513-519` | 仓库里只有一句固定 opener |
| 原则 / 纪律 | 各工具插件的 `systemPrompt.section()`，见第 3 节 | "工具纪律"是主体，价值观原则几乎没有 |
| 模式 | `plan/plan-mode/src/index.ts:195-222`；`goal/tool-goal/src/index.ts:189-194` | 只有 plan / goal 有提示词层 |
| 上下文 | `core/agent-loop/src/runtime-context.ts:15-88`；`core/system-prompt/src/index.ts:233-242,361-396` | 动态事实走 user 角色快照 |
| 压缩 | `compaction/compaction-basic/src/summarizer.ts:25-74` | 九节 Markdown 模板，追加为最后一条 user 消息 |
| 复盘 | `goal/tool-goal/src/wrapup.ts:4-35`；`core/session/src/repair.ts:34-39`；`experimental/auto-review/src/index.ts:55-77` | 收尾话术、不确定结果处置、授权复核 |

**关键结论：仓库里几乎没有"人格正文"。** 固定身份只有一句（`core/system-prompt/src/index.ts:517`）：

> You are an AI agent powered by DeepSeek Harness.

人格前缀/后缀是配置项，默认空字符串（`core/system-prompt/src/index.ts:315-337,520-530`）；
`preset/persona` 只注册成两个可覆盖 section（`preset/persona/src/index.ts:20-65`）。
测试里的 `You are DeepSeek Harness.` 来自测试 config（`core/system-prompt/tests/system-prompt.spec.ts:234,257`）。
`boot`/`preset` 目录没有内置人格正文，`profile` 只做插件装配（`boot/app-boot/src/profile-plugins.ts`）。
所以 DSH 的"脑子"是**几十个插件贡献的短段 + 运行时事实快照**，不是一段长 system prompt。

---

## 2. system prompt 的分节、组装与缓存

### 2.1 装配管线

唯一装配点 `SystemPrompt.assemble()`（`packages/core/system-prompt/src/index.ts:691-830`）：
收集全局+作用域层，同名取"最近作用域、最新注册"（`:702-716`）→ 已 dispose 且曾被接纳的段插入
retirement 通知（`:718-746`）→ 变量求值与工具 schema clone（`:748-772`）→ 按 `order` 再按名字排序，
`complete: true` 多于一个报错（`:774-778`）→ 跑 `system-prompt/assemble` waterfall（`:797-800`）→
恢复 complete 段为唯一 section（`:806-809`）→ 严格插值 `{{var}}`，空段丢弃，段间 `\n\n` 拼接
（`:348-354,398-436`）。接口字段：`name`/`order`/`text`/`interpolate: false`/`complete`/`replacement`/`retirement`（`:64-100`）。

### 2.2 分节表

顺序常量在 `SECTION_ORDERS`（`packages/core/system-prompt/src/index.ts:191-228`）。
DSH 没有显式 stable 标志，"常驻"按增量接纳后留在历史推断。

| # | order | 分节 | 内容 / 来源 | 常驻 | 缓存 |
|---|---|---|---|---|---|
| 1 | −1000 | `harness:identity` | 固定 opener，`core/system-prompt/src/index.ts:513-519` | 是 | 最长前缀，可关 |
| 2 | 0 / 10200 | persona 前/后缀 | 部署模板，`:520-530`；`preset/persona/src/index.ts:55-65` | 是 | 变了才追加 delta |
| 3 | 500 / 501 | `plan:policy` / `plan:status` | 模式正文 + 状态行，`plan/plan-mode/src/index.ts:195-222` | 否 | `replacement: ''` 抑制前缀 |
| 4 | 600 | `team:policy` | 协作规则，`team/tool-agent-team/src/index.ts:112-117` | 否 | 启用才出现 |
| 5 | 800 | `tools:ptc-only` | 唯一执行器，`core/tool-executor-ptc/src/index.ts:29` | 是 | `interpolate: false` |
| 6 | 900 | `context:file-reference` | 引用格式，`context/file-reference-local/src/index.ts:63-70` | 是 | 有 read 才出现 |
| 7 | 1000–1500 | `tool:bash/pwsh/read/write/edit/apply_patch/glob/grep` | 工具纪律，`shell/tool-*`、`fs/tool-*` | 是 | 变更才更新 |
| 8 | 1600–2300 | jobs / pty / web / lsp / session-query | 作业、联网、代码智能 | 是 | 同上 |
| 9 | 2400 | `tool:goal` | 目标政策，`goal/tool-goal/src/index.ts:189-194` | 是 | 同上 |
| 10 | 2500–2800 | schedule / `tool:workflow` / ralph / `tool:subagent` | 编排与委派，`workflow/tool-workflow/src/index.ts:328-333`；`subagent/tool-subagent/src/index.ts:367-381` | 是 | 同上 |
| 11 | 2900–3100 | report / computer-use / `MCP_SERVERS` | 汇报、GUI、连接列表 | 混合 | 连接变化才更新 |
| 12 | 5000 / 9000 / 9900 | `tools:sdk` / 交付物引用 / 结构化输出 | `core/tool-executor-ptc/src/index.ts:30`；`deliverables/deliverable-file-references/src/index.ts:13-29`；`subagent/subagent/src/structured.ts:112-114` | 混合 | 视平台 |
| 13 | 10000 / 10100 | `HARNESS_SOURCE` / `WEB_SURFACE` | 自研/Web 指引，`context/harness-dev-context/src/index.ts:147-171` | 否 | `interpolate: false` |

500→10200 间的大量空号是"稀疏命名位"（`core/system-prompt/README.md:62`）。

### 2.3 每步请求拼了什么

每步在 `agent/pre-step` 前 `assemble(context)`，传 Session/model selection/tool set
（`core/system-prompt/README.md:76`）。请求本体只有 `header.config` + `deriveMessages()` + `header.tools`，
**没有 system 字段**（`core/agent-loop/README.md:122`）；system 是历史里的 `system/message` 节点。
首次尝试写 `systemUpdates()` 增量，重试复用已提交历史（同文件 `:122`；
`core/system-prompt/src/index.ts:833-860`）。工具声明放 header，名字变化另发 `developer/message`（`:160`）。

### 2.4 运行时上下文是 user 快照

`CONTEXT_ORDERS` 七槽位（`core/system-prompt/src/index.ts:233-242`）：工作目录 100、沙箱 110、审批 115、
委派 120、harness 源 200、Web 210、插件 CLI 220。渲染首句固定（同文件 `:373-377`）：

> Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

循环再包一层 supersession 句（`core/agent-loop/src/runtime-context.ts:80-87`）：

> The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.

空集发 `Current runtime context: none. Earlier runtime-context snapshots no longer apply.`（同文件 `:19`）。
闭合标签被转义，但注释明说"格式约定，不是安全边界"（`core/agent-loop/README.md:126`）。

### 2.5 缓存策略

普通更新只追加变化段；压缩后下次尝试把当前指令 Consolidate 到头部（`core/system-prompt/README.md:177-183`）。
route 变化、resume、显式请求系列起点、schema 变化**不合并 section**，只有压缩重建（`:183`）。
前缀稳定条件是"可见 schema 集合、渲染与顺序都不变"，任一变化从首个 token 起失效（`:195-197`）。
adapter 可选原生消息 / reminder / 合并 system 字段，只有保前缀的表示能复用缓存（`:183`）。

---

## 3. 工具描述的写法（5 个样本）

"何时用/不用"分两个载体：`description` 字段与 `systemPrompt.section()` 短纪律段；后者由工具插件自己注册
（`workflow/tool-workflow/src/index.ts:326-327`）。

| 工具 | 用途 / 何时用 | 何时不用 | 参数写法 |
|---|---|---|---|
| `read` | "Read a UTF-8 text file and return line-numbered content."（`fs/tool-fs/src/read.ts:80`） | 点名 cat/sed/head/tail（`:69-75`） | `offset` 1-based、`limit` 带默认值（`:82-84`） |
| `write` | "Create or fully replace a UTF-8 text file."（`:76`） | 先 read 再覆盖；有 edit 优先 edit（`:63-72`） | 参数描述塞顺序：`file_path` before `content`（`:80-82`） |
| `edit` | 字面文本替换（`:88`） | "Read a file before editing it unless you just created or edited it in this session."（`:78-83`） | `old_string` 须唯一；空 `new_string` 即删除；`replace_all` 默认 false（`:95-97`） |
| `apply_patch` | 跨文件/跨区段改动优先它（`:28-29`） | 拒绝补丁零变更；应用后不回滚，失败前重读（`:18-25`） | `*** Begin Patch` 语法逐项说明 Add/Update/Move/Delete（`:31-37`） |
| `bash` | 执行命令返回 stdout/stderr（`shell/tool-bash/src/index.ts:122`） | 不用 `cd` 传 `workdir`；删除前核对绝对路径；沙箱拒绝不得绕过（`:123-129`） | `description` 先写，给 5–10 词主动语态示例（`shell/tool-pwsh/src/index.ts:434-440`） |

归纳：①用途一句在首句并给差异点；②"何时不用"多在独立 section——
`Use the read tool — not shell commands like cat…`（`read.ts:74`）、
`Use the glob tool — not shell find`（`glob.ts:317`）、`Use the grep tool — not shell grep or rg`（`grep.ts:282`）；
③参数级 description 承载调用纪律（`write.ts:80-82`、`grep.ts:294`）；
④结果自带诊断：`[exit code: N]` 必须检查（`shell/tool-bash/src/index.ts:294`），pwsh 解释 exit 1 终止语义（`:306-307`）；
⑤工具被限制时纪律段自动收空（`read.ts:72`、`write.ts:66`）并配 `retirement`（`:75`）；
⑥组合偏好显式写：grep 命中后用 read 看上下文（`grep.ts:283`）。

---

## 4. plan / goal / team / workflow：软提示还是硬约束

### 4.1 plan：软正文 + 工具硬门槛，正文不在仓库

正文来自部署配置 `PlanModeConfig.section`（`plan/plan-mode/src/index.ts:68-72`），插件只包一层（`:203-205`）：

> The following instructions apply only while plan mode is active.

状态行（`:218-220`）：

> Plan mode is active. Follow the plan-mode instructions.

硬的部分在工具准入与校验：`exit_plan_mode` 只在选中态出现（`:400`），plan 必须 `#` 开头（`:327-329`），
审批经用户问题通道（`:338-355`），描述写明 "Use only in plan mode"（`:83-86`）；沙箱/审批独立强制（`:4-7`）。
**结论：外部软提示 + 工具级硬闸门，仓库内没有 MUST NOT edit 式硬文本。**

### 4.2 goal：强提示 + 服务端硬阈值

工具描述教模型何时算长任务（`goal/tool-goal/src/index.ts:51-54`）：

> Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.

政策段（`:115-122`）：resume/fork 后目标 disarm，用户说"继续"要用 `update_goal resume` 重新武装；
真正完成才 complete；同一阻塞连续 N 轮（默认 3，`:39`）才 blocked。硬约束在服务端：轮数不足抛
`GOAL_TOOL_BLOCK_THRESHOLD`（`:287-293`），`edit/pause/resume` 要直接人类请求（`:245-247`）。
续轮 user 消息（`goal/goal-round-driver/src/prompt.ts:12-25`）：

> Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current.

### 4.3 team：纯软提示

`TEAM_POLICY`（`team/tool-agent-team/src/index.ts:27-33`）：

> The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

关键词 **advisory, not a lock**：重叠只警告不加锁。流程是 list/get/claim with revision/perform/complete，
Root 必须等队友（`:31`）；section 只在 enabled 时注入（`:112-117`）。

### 4.4 workflow：软闸门 + 硬沙箱

用法闸门（`workflow/tool-workflow/src/index.ts:331`）：

> Use the `workflow` tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration … For one or two delegations, prefer plain subagent calls.

工具描述即脚本 API 契约（`:160-168`）：`agent`/`pipeline`（无阶段间 barrier）/`parallel`（barrier）/
`phase`/`log`/`args`，限定 schema 子集。硬约束：脚本无 filesystem/network/timer/Node API，误用 hook 直接结束脚本（`:168`）。

| 模式 | 提示词层 | 硬约束落点 | 来源 |
|---|---|---|---|
| plan | 部署正文（仓库外）+ 状态行 | 工具准入、Markdown 校验、审批 | `plan/plan-mode/src/index.ts:195-222,327-355,400` |
| goal | 政策段 + 续轮/收尾 | blocked 轮数、动作权限 | `goal/tool-goal/src/index.ts:115-122,245-247,287-293` |
| team | 协作说明段 | 仅 revision 比较，无锁 | `team/tool-agent-team/src/index.ts:27-33` |
| workflow | 闸门 + API 契约 | 无 FS/网络 API、schema 白名单 | `workflow/tool-workflow/src/index.ts:160-168,331` |

---

## 5. 压缩提示词：保留什么、丢弃什么、格式

`COMPACTION_INSTRUCTION` 作为**最后一条 user 消息**追加在重放对话后，而非独立 summarizer system
（`compaction/compaction-basic/src/summarizer.ts:28-35,142-149`），理由（`:29-33`）：让辅助调用成为上次
路由请求的真前缀，**复用 KV cache**。开头（`:36-38`）：

> You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.
>
> Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.

九节固定顺序（`:40-62`）：Primary Request and Intent → Key Technical Concepts → Files and Code →
Errors and Fixes → Pending Jobs → Current Work → Next Step → Critical Context；
Next Step 要 single next action，否则 `(none)`（`:58-59`）。规则（`:64-69`）：

> - Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.
> - Capture user feedback and explicit instructions faithfully, especially corrections.
> - Do NOT mention this summarization request or that the context was compacted.
> - Output only the checkpoint text: do not call any tool or take any other action.
> - If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.

**保留**路径/命令/错误串/标识符/数值/签名/用户纠正（`:65-66`）；**丢弃**叙述段落、压缩自身的提及、
工具调用、旧 checkpoint 过期项（`:67-69`）。落盘用 `<compacted-summary>` 包裹（`:25-26`），前置
preamble（`:73-74`）："Treat the captured context as established background and build on it without restating it."
图片输出拒绝（`:211-219`），`max-tokens` 截断视为失败（`:194-209`），辅助调用带 `toolHistory` 与原 schema 只为对齐前缀（`:150-159`）。

---

## 6. 子代理提示词

`SUBAGENT_DELEGATION_CONTEXT` 是 user 角色 context，不是 system section
（`subagent/subagent/src/child-agent.ts:171-177,211-215`）：

> You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically.
>
> When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.

还规定消息归属：`"Agent <name> sent a message:"` 来自其他 agent，其他 user 消息来自真人；可发消息给别的 agent，
但要在回复里回答人类用户（`:175-177`）。主代理没有这段；子代理保留部署人格（可被 `composition.persona`
覆盖，`:216-222`），权限启动时固定、不可扩大。

工具权限是三层注册层事实而非提示词请求：`tools.restrict(composition.toolFilter)`（`child-agent.ts:223`）、
审批钉死 `'never'` 且沙箱只继承父会话显式 override（`:226-260`）、深度上限作为动态 context
"current N, maximum M, remaining levels 0. Do not call … at this depth"（`tool-subagent/src/index.ts:382-394`）。

委派工具措辞按 backend 是否继承上下文切换（`tool-subagent/src/index.ts:117-141`），共同点是
"You receive its result, not its intermediate steps."（`:125,136`）。并发纪律（`:379`）：

> Start independent delegations with … together in one assistant message and continue useful work while they run … When only waiting for their results remains, end your turn instead of sleeping or polling.

并提醒 bash/格式化器会覆盖并发编辑，"The agent integrating the work must review the final diff and run relevant tests."（同句）。

---

## 7. 技能如何进上下文

技能**不进 system prompt**，走两条 user 消息路径：①目录 `<system-reminder>` 包 `<available_skills>`，
写明 "This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded."
（`skill/tool-skill/src/index.ts:267-296`），变化时"替换全部旧目录"（`:298-318`）；
②正文统一 `<skill_content name="…">` 内含 `<skill_resources>` 与 `<skill_instructions>`
（`skill/skill/src/index.ts:173-185`），工具结果与用户直接调用同形状（`:164-169`）；
③在 `agent/pre-step` 追加，位于其他注入之后（`tool-skill/src/index.ts:178-216`）。
ZCode 则把 Skill 列表作为 system/dynamic 段（`03-zcode-prompt-system.md:24,190-192`）。

---

## 8. 复盘 / 收尾类提示词

DSH 没有通用"自我复盘"段，近似物三处：**目标收尾**（`goal/tool-goal/src/wrapup.ts:16-35`）用
`<goal_complete>`/`<goal_blocked>` 要求 "state the outcome, summarize what was done and how it was verified"，
并以 GROUNDING "Report only what earlier rounds and tool results in this session actually establish"（`:4-6`）约束；
**不确定工具结果**（`core/session/src/repair.ts:34-39`）："retry only if the operation is read-only or idempotent;
if it may have side effects, first verify external state or ask the user. Do not retry blindly."；
**授权复核**（`experimental/auto-review/src/index.ts:55-77`）是独立 reviewer system prompt，风险分
low/medium/high，"Return exactly one JSON object and no other text"，来源角色权威
user-instruction > direct-parent > constraint > checkpoint > fact（实验包）。

---

## 9. 提示词之外：DSH 为 DeepSeek 做的流程适配

提示词写得再对，若底层协议/流程不匹配就会落空。DSH 的行为有很大一部分在**请求构造、思考回填、工具配对、
缓存与重试**里，这些才是"提示词怎么落地不踩空"的关键。

### 9.1 协议底座是 Anthropic Messages 子集，不是 OpenAI Chat Completions

官方 DeepSeek 适配器自己写明 "using Messages content and native thinking replay"
（`packages/llm/llm-deepseek/src/adapter.ts:21`）；wire 类型文件第一行即
"DeepSeek's supported subset of the Anthropic Messages request protocol"
（`packages/llm/llm-deepseek/src/wire-types.ts:1`）。请求字段（同文件 `:24-41`）：
`model`、`stream: true`、`max_tokens`、`messages`、`system?`、`thinking: {type: enabled|disabled}`、
`output_config?: {effort: low|high|max}`、`stop_sequences?`、`tools?: [{name, description, input_schema, defer_loading?}]`。
**没有 `tool_choice`、没有 `stream_options`**；这两者属于另一条 pi-ai / openai-completions 路径：
`supportsUsageInStreaming`（`stream_options: {include_usage: true}`）与
`requiresReasoningContentOnAssistantMessages`（回放时补空 `reasoning_content`）
见 `packages/llm/llm-pi-ai/src/catalog.ts:400,415`。WitCode 若接 DeepSeek 官方 API，要选对协议族。

### 9.2 思考（reasoning）全链路

- **请求侧**：effort 取 `off/low/high/max`，`off` → `thinking: disabled`，否则 `enabled` 并写 `output_config.effort`
  （`llm-deepseek/src/serialize.ts:147-156`）；`thinking: disabled` 部署策略下只能选 `off`
  （`llm-deepseek/src/config.ts:22-24,242-245`）。
- **流解析**：`content_block_start` 的 `thinking` → `reasoning` block 并保留 `signature`
  （`translate.ts:52-55`）；`thinking_delta` → `reasoning-delta`（`:74-78`）；`signature_delta` 只累积签名、
  不发文本（`:79-82`）。
- **落盘**：`replayState()` 写 `{response:{kind:'deepseek-messages',version:1,model},blocks}`，
  持久正文不重复文本，只存索引对齐的签名（`llm-deepseek/src/replay.ts:1,24-31`）。
- **回填**：`assistant()` 把 durable reasoning 重写成 `thinking` block 带 signature
  （`serialize.ts:32-35`）；kind/版本/模型/块数/类型任一不匹配就降级丢弃（`replay.ts:39-64`）。
  **这就是"思考能续上去"的硬条件**：没有 signature 回填，下一次请求会因 Messages 协议校验失败。
- **UI**：`reasoning-delta` → chat node 的 reasoning 行（`client/ui-chat/src/client/conversation-nodes/assistant.ts:117-122`），
  Think 标题与首行预览由 presentation policy 控制（`client/ui-chat/src/client/presentation-policy.ts:19-21`），
  usage 行单列推理 token（`client/ui-chat/src/client/locale.ts:204,421`）。

### 9.3 工具调用格式与配对

`tool_use {id,name,input}` / `tool_result {tool_use_id,content,is_error?}`（`wire-types.ts:14-15`），
与 OpenAI 的 `function` + `tool_call_id` 不同，且 `input` 是**完整 JSON 对象**而非字符串。
流式参数走 `input_json_delta.partial_json` 累积，块结束时覆盖 `arguments`（`translate.ts:83-87,148`）；
`max_tokens` 截断时保留残缺 JSON，交给共享 assembler 剪掉（`:165-166`）。
序列化阶段强制配对：重复 tool id、结果无匹配调用、调用后没有立即结果、历史末尾未解决工具
都抛 `INVALID_REQUEST`（`serialize.ts:131-146`）；tool 角色映射为 user（`:125`）。
**并行调用不是提示词约定，而是 pending 集合的协议校验**——这正是子代理段里
"start independent delegations together"能成立的前提。
延迟工具用 `defer_loading` 声明、`tool_addition`/`tool_removal` 激活（`wire-types.ts:11-12,38-39`；
`serialize.ts:96-97`），与第 3 节"工具被限制则纪律段收空"配套。

### 9.4 缓存：没有 cache_control 字段也能命中

请求体里没有显式 `cache_control`；命中靠 wire 前缀字节一致 + 服务端 prefix cache。
反馈通道是 usage 字段 `cache_read_input_tokens`/`cache_creation_input_tokens` →
`cacheReadTokens`/`cacheWriteTokens`（`translate.ts:35-44,157`）。为保前缀做了四件事：
①system section 只追加 delta 不重排（`core/system-prompt/README.md:177-183`）；
②压缩指令追加到最后一条 user 而不是发新请求（`summarizer.ts:28-34`）；
③header 只在首次/变化时写，普通轮继承（`core/agent-loop/README.md:91-100`）；
④thinking signature 回填保证 Messages 前缀合法（`serialize.ts:32-35`）。
system 用顶层 `system` 字符串还是 in-history 消息，由 route 的 `systemPromptUpdate` 能力决定
（`serialize.ts:64-65,111-115`；`core/system-prompt/README.md:183`）——不同表示会改缓存形态。

### 9.5 失败分类与重试

HTTP/带内错误归一化为稳定错误码（`llm-deepseek/src/transport.ts:37-53`）：
401/403→AUTH；402/quota→QUOTA；429/rate_limit_error→RATE_LIMIT（带 `Retry-After`）；
上下文溢出→CONTEXT_WINDOW_EXCEEDED；400/413/invalid_request→INVALID_REQUEST；5xx/overloaded→SERVER。
流内：`refusal`→CONTENT_REFUSED 但先把已计费 usage 发出（`translate.ts:91-95,151-163`）；
空内容→EMPTY_RESPONSE（`:164`）；未 `message_stop`→STREAM_CLOSED（`:179`）；
非法 tool JSON→MALFORMED_RESPONSE（`:168-172`）。
重试策略由 provider 自持，默认 normal/5 次，可重试码为
EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT（`llm/llm/src/retry-policy.ts:14-22`）；
指数退避 500ms→10s、jitter 0.1（同文件 `:15-17`）；每次重试先写 `llm/retry` 事件再等待
（`llm-retry/src/index.ts:135-172`）。**上下文溢出不在默认重试码里**——交给压缩/会话层，避免无效重试；
图片上传 429 另走有界退避（`llm-deepseek/src/file-store.ts:296-300`）。

### 9.6 提示词靠什么强制落地

| 提示词 | 强制机制 | 位置 |
|---|---|---|
| plan 正文 | `exit_plan_mode` 的 `when` 准入 + Markdown 校验 + 审批事件 | `plan/plan-mode/src/index.ts:327-355,400` |
| goal 政策 | blocked 轮数服务端抛错；续轮由 driver 注入 user 消息 | `goal/tool-goal/src/index.ts:287-293`；`goal-round-driver/src/prompt.ts:12-25` |
| 压缩摘要 | 摘要后下一次尝试重建 system head | `core/system-prompt/src/index.ts:833-860` |
| 子代理边界 | `tools.restrict` + approval pin | `subagent/subagent/src/child-agent.ts:223,259` |
| skill 目录/正文 | `agent/pre-step` 注入 | `skill/tool-skill/src/index.ts:178-216` |
| 工具纪律 | 工具不可见时 section 自动收空 | `fs/tool-fs/src/read.ts:72` |

**踩空点一句话**：只搬提示词不搬这些流程，会在空回复/截断无重试、thinking signature 丢失导致回填失败、
tool_result 不配对被协议拒绝、system 每步重发破坏前缀缓存、"提示词说不要做但工具准入没关"、
goal 阈值只写在文本里没人执行这六处落空。

---

## 10. 与 ZCode 的差异

1. **无固定人格正文**：ZCode 有长 identity 安全双用途条款与 `# Harness`（`03 文档 :53-100`）；DSH 只有一句 opener。
2. **system 增量接纳而非每步重建**：DSH `systemUpdates()` 只写变化段（`core/system-prompt/src/index.ts:833-860`）；
   ZCode 每步压成 2–3 条 ephemeral 消息（`03 文档 :9-22`）。
3. **动态事实是自描述 user 快照**：DSH 明说取代旧快照与摘要中的内容（`core/agent-loop/src/runtime-context.ts:80-87`）。
4. **模式大多不进提示词**：ZCode plan 有五阶段软流程（`:204-235`）；DSH plan 正文在仓库外，team/workflow 靠工具闸门。
5. **压缩指令位置不同**：DSH 追加为最后一条 user（`summarizer.ts:28-34`）；ZCode 用 `<analysis>`+`<summary>`（`:236-265`）。
6. **子代理权限靠注册层收敛**（`child-agent.ts:223,259`）；ZCode 用显式 allowlist 与硬文本 READ-ONLY（`:326-365`）。
7. **协议层更重**：DSH 为 Messages 协议做了 thinking 签名回填与工具立即配对（`replay.ts:39-64`；`serialize.ts:131-146`），
   ZCode 走 OpenAI 兼容 + pi-ai 开关（`llm-pi-ai/src/catalog.ts:400,415`）。

---

## 11. 可移植性

**可直接搬（纯文本/结构）**：九节压缩模板（`summarizer.ts:35-74`）、五个工具纪律短段（第 3 节）、
子代理委派声明（`child-agent.ts:171-177`）、三段 goal 提示词（`goal-round-driver/src/prompt.ts:12-25`；
`tool-goal/src/wrapup.ts:16-35`）、workflow 闸门与 API 契约（`workflow/tool-workflow/src/index.ts:160-168,331`）、
skill 格式（第 7 节）。

**必须重写（架构依赖）**：section admission 与 `systemUpdates()`（`core/system-prompt/src/index.ts:691-860`）；
`{{cwd}}` 变量由 working-directory 提供（`core/system-prompt/README.md:89-97`）；
`complete`/retirement 依赖 Cordis disposer（`:718-746,806-809`）；goal 的 disarm/阈值依赖 projection
（`goal/tool-goal/src/index.ts:117-122,287-293`）；plan 正文本就不在仓库（`plan/plan-mode/src/index.ts:68-72`）；
team revision 与 subagent 审批钉死依赖编排运行时；压缩前缀复用依赖 `ctx.llm.stream` 与 header cache
（`summarizer.ts:142-161`）；**第 9 节全部流程适配**——协议族、签名回填、工具配对、错误码与重试策略。

---

## 12. `dsh` Brain 插件草案

"暂定"表示证据不足或需 WitCode 侧决策。

| 槽 | 填什么 | 证据 / 状态 |
|---|---|---|
| identity | 固定 opener `You are an AI agent powered by DeepSeek Harness.`；产品名按需改 | `core/system-prompt/src/index.ts:517`，直接搬；**暂定**是否补人格正文 |
| rules | 工具纪律短段（用途+反向约束）；`[exit code: N]` 自检；不确定工具只读/幂等才重试 | 第 3 节；`shell/tool-bash/src/index.ts:294`；`core/session/src/repair.ts:34-39`；安全双用途条款**暂定** |
| modes | plan 软正文+工具闸门（正文自写）；goal 政策+三段提示词（阈值需状态机）；team/workflow 条件注入 | **暂定** plan 正文与 goal 默认阈值 3；`03 文档 :397-440` 的分层原则 |
| prompts | 九节压缩（调用入口需重写）；skill 目录+`<skill_content>`；user 快照自描述首句；`<goal_complete>`/`<goal_blocked>` | 第 5、7、8 节；格式可搬 |
| loop | 请求 = 配置头+派生消息+工具头；system 走历史；重试复用历史；保持 schema 顺序稳定；**必须补**第 9 节的协议/签名/配对/重试流程 | `core/agent-loop/README.md:122`；`core/system-prompt/README.md:191-197`；无等价 system 历史机制时**暂定**改为每步重渲染 |
