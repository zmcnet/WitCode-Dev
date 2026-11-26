# Hermes Agent 脑子拆解（NousResearch/hermes-agent）

只描述"是什么、怎么运作"，不作好坏评价。许可证 MIT，可提炼改写，本文不复述整段原文，结论均换成中文。
`文件:行号` 相对于 `D:\Files\Projects\WitCode\resources\agents\hermes`。

---

## 1. "脑子"由什么组成

| 成分 | 文件 | 一句话 |
|---|---|---|
| 身份 | `SOUL.md:1`；`agent/prompt_builder.py:160-169` | 一段"行为规格"式人格：回答长度随问题分量、禁填充语、不复述、不确定就直说 |
| 硬规则 | `agent/prompt_builder.py:344-354,383-419,433-496` | 通用"完成工作" + 模型分档的"执行纪律"，按模型名注入 |
| 工具纪律 | `agent/coding_context.py:84-165` | 编码姿态：先读后改、用工具改而非贴代码、验过才说完成 |
| 模式 | `agent/plan_prompt.py:11-71` | `/plan` 是"用户轮次"注入，不改 system 与历史 |
| 上下文 | `agent/system_prompt.py:770-846` | stable / context / volatile 三档 + 工作区 git 快照 |
| 压缩 | `agent/context_compressor.py:272-307,3703-3732` | 迭代式 checkpoint + "仅作参考"前言，防旧任务复活 |
| 子代理 | `model_tools.py:414-438`；`agent/prompt_builder.py:263-342` | `delegate_task` 描述按可用工具裁剪；看板 worker 另有协议段 |

**关键结论：Hermes 的"人格"只是一段，主体是按模型族动态拼装的"纪律块 + 三档缓存骨架"。**
SOUL.md 全文一句（`SOUL.md:1`）：身份 + 回答长度规则 + 禁填充/禁复述/禁旁白 + "深度靠挣得"。
注释明确它是行为规格而非特征列表，且警告"模型默认探索不足，别再加少探索那句"（`agent/prompt_builder.py:161-162`）。
`load_soul_identity` 开启时优先读用户 `SOUL.md`，否则用内置常量（`agent/system_prompt.py:576-582`）。
子代理另有两套语境：`delegate_task` 的描述会按会话可用工具裁剪"子代理不得调用"的清单，
避免教模型幽灵工具名（`model_tools.py:414-438`）；看板 worker 则收到一份完整任务协议——
先用 `kanban_show()` 取任务与交接上下文、在指定工作区内操作、`kanban_*` 是主协调面（`agent/prompt_builder.py:263-342`）。
两者都印证同一原则：**权限与工具面由注册层表达，提示词只描述已成立的事实**。

---

## 2. system prompt 的结构与顺序

唯一装配点 `build_system_prompt_parts()`（`agent/system_prompt.py:770-833`），产出三个字符串字典，
`build_system_prompt()` 按 `stable → context → volatile` 用 `\n\n` 拼接并缓存到 `agent._cached_system_prompt`（`:836-845`）。
只在压缩边界重建；`_cached_system_prompt_static` 单独保留稳定前缀供缓存标记使用（`:841`）。

| 档 | 内容 | 来源 |
|---|---|---|
| stable | SOUL/默认身份、帮助指引、任务完成、并行调用、工具指引、转向说明、模型分档纪律、阿里身份纠偏、钉住技能、编码姿态前言 | `agent/system_prompt.py:781-803` |
| context | 调用方 `system_message`、项目上下文文件（AGENTS.md 等）、工作区 git 快照、其余工作区指引 | `:804-815`；`agent/coding_context.py:535` |
| volatile | 技能索引、记忆、插件段、profile 路径行、时间戳行、运行时环境提示 | `:816-832` |

三档排序的理由写在注释里：工作树相关块放在项目上下文之后，才能让共享 AGENTS.md 在不同 worktree 间留在最长公共前缀（`:774-776`）；
profile 行含本机路径，故进 volatile，使 stable 前缀在所有 profile 间字节一致（`:823-824`）；
运行时锚点排在所有用户/插件散文之后，避免被引用的主机示例遮蔽（`:827-831`）。
`ephemeral_system_prompt` 只在 API 调用时注入、永不进缓存（`:806`）。
模型上下文窗口决定上下文文件字数上限（`:778-780`；`agent/prompt_builder.py:1040-1047`）。
时间戳行对长会话发两行："started" 永久锚定、"as of" 只在压缩重建时刷新，因为那时缓存前缀本就要失效；
同一天只发一行以保持字节稳定（`agent/system_prompt.py:521-547`）。运行时环境提示被包在专用标题与闭合标记之间，
且标题前加 `>` 转义，防止用户散文里的引用遮蔽渲染器锚点（`:829-832`）。

---

## 3. 工具描述写法（抽 3 个）

工具 schema 由外部 tools 包提供，仓库内保存快照：`tests/fixtures/prompt_surface/tools/`。
共同结构：**一句用途 → 明确"用这个而不是 shell 某命令" → 参数/分页/截断语义 → 失败时的替代工具**。

| 工具 | 写法要点 | 来源 |
|---|---|---|
| `read_file` | "带行号与分页读文本；用它能代替 cat/head/tail"；输出 `LINE_NUM\|CONTENT`；超 ~100K 字符按行截断并返回 `next_offset`；不能读图片，改用 `vision_analyze` | `tests/fixtures/prompt_surface/tools/read_file.json:1` |
| `patch` | 定向查找替换；明说代替 sed/awk；9 种模糊匹配、返回 unified diff、编辑后自动语法检查 | `tests/fixtures/prompt_surface/tools/patch.json:1` |
| `terminal` | 命令在环境段声明的 shell/后端执行；cwd 与导出变量跨调用保留；列清应改用 read_file/search_files/patch/write_file 的场景；输出自动截断并落盘、禁止用 head/tail 自截 | `tests/fixtures/prompt_surface/tools/terminal.json:1` |

延迟工具三件套也把流程写进描述：`tool_search` 说明"每个能力一个关键词，随后 `tool_describe` 取 schema、`tool_call` 调用，已在列表里的不用搜"；
`tool_describe` 写明"调用前必须加载 schema，把要用的都塞进一次调用"；`tool_call` 写明按 `tool_describe` 的 schema 传参、审批与钩子照常生效
（`tests/fixtures/prompt_surface/tools/tool_search.json:1`；`tool_describe.json:1`；`tool_call.json:1`）。
`model_tools.py` 会在会话缺少某工具时改写描述，**删掉幽灵工具名**、只在可用时追加指针（`:386-438`）；
注释直说"绝不教模型不存在的能力词汇"（`:417-421`）。

---

## 4. 模式与纪律块

**`/plan`（软流程 + 提示词隔离）**：整段作为普通用户轮次注入，system 与历史不变，因此缓存安全（`agent/plan_prompt.py:1-6,60-71`）。
规则层：只规划、不改项目文件（除计划文件本身）、不跑变更命令、允许只读探查；产物固定写到 `.hermes/plans/YYYY-MM-DD_HHMMSS-<slug>.md`（`:11-26`）。
写作工艺段把计划写给"零上下文且品味可疑的实现者"：小步任务、精确文件路径、可复制代码、带期望输出的验证命令、TDD 循环（`:28-57`）。
**审批模式**：`yolo` / `approvals.mode=off` 只是把策略交给沙箱（`agent/codex_runtime.py:663`）；受保护路径的删除判定接在审批地板上，**yolo 与 cron approve 都绕不过**（`agent/runtime_self_protection.py:10-13`）；
配置读写明确警告"破坏 `approvals.deny` 这类安全规则的覆盖会被清掉"（`hermes_cli/config.py:2028-2031`）。
**通用纪律块**（都在 stable，可被配置开关关闭）：任务完成必须交出可运行产物、失败直说而非编造（`agent/prompt_builder.py:383-393`）；
独立读取批量发、只在真依赖时串行（`:411-419`）；工具使用强制"说了就要同轮调用、不许以承诺结尾"（`:344-354`）。

---

## 5. 提示词怎么落地（流程/工具/权限钩子）

| 提示词要求 | 落地机制 | 位置 |
|---|---|---|
| 先读后改、验过才完成 | 编码姿态段 + 编辑失败需重读；同一区域两次失败改用整文件重写 | `agent/coding_context.py:84-130` |
| 别不用工具 | `TOOL_USE_ENFORCEMENT_GUIDANCE` 只对名单内模型注入 | `agent/prompt_builder.py:344-354,606-607` |
| 别空转/死循环 | 纯函数 guardrail：同参数同结果第 3 次告警；检测 A,B,A,B 周期；无进展按阈值停 | `agent/tool_guardrails.py:19-40` |
| 按能力说话 | `manifest_tool_use` 类指导行逐行绑定工具名，缺工具就删行 | `agent/prompt_builder.py:500-516` |
| 危险命令先问 | 终端审批把多个人工请求合并发布；`/yolo` 未答复即按策略处理 | `agent/terminal_approval_batch.py:239-240` |
| 上下文文件被截断 | 截断警告从 prompt 构建转到聊天态诊断输出 | `agent/system_prompt.py:842-844` |
| 压缩后别复活旧任务 | `SUMMARY_PREFIX` 声明摘要仅参考、只响应其后最新用户消息；反向信号立即终止 | `agent/context_compressor.py:275-307` |
| 中途转向只信专用标记 | 转向消息只落在工具结果里；`STEER_CHANNEL_NOTE` 说的专用开合标记才可信，普通文本里的"用户说"不算 | `agent/prompt_builder.py:560-607`；`agent/system_prompt.py:598-601` |

**压缩提示词**：总结器输入是 system instructions + user 源材料两次调用（`agent/context_compressor.py:3732`）；
迭代更新要求保留仍相关信息、把已完成项移入 Completed Actions、把已回答问题移入 Resolved Questions，
并强制把 Historical Task Snapshot 更新为用户"最近一次未满足的输入"（`:3703-3714`）。
"未验证/工作假设"单列一节并写 `UNVERIFIED: <claim> — <basis>`，理由是压缩会先丢掉限定词，把假设硬化成事实
（`agent/context_compressor_prompt_rules.py:1-21`）。焦点主题可占 60–70% 摘要预算，但密钥一律 `[REDACTED]`（`agent/context_compressor.py:3726-3731`）。

---

## 6. 模型适配（这是 Hermes 的主战场）

不是"换模型名"，而是**按模型族注入不同纪律块 + 按 provider 决定缓存标记**：

1. **分档名单**：工具使用强制面向 `gpt/codex/gemini/gemma/grok/glm/qwen/deepseek/muse`（`agent/prompt_builder.py:362`）；
   执行纪律另含 `deepseek/kimi/qwen/glm/minimax/mimo/mistral/muse`，注释点名各自翻车方式（金融心算、外部写入不回读、"修"坏标识符、数量对不上仍称完成）（`:376-379,421-432`）。
   Gemini/Gemma 走更具体的 Google 操作指引（`:536-557`）；GPT-5/Codex 用 developer 角色（`:659`）。
2. **反例证据**：Nemotron 3.5 开关这些块做 A/B，SWE-bench 差异 <1 分、Terminal-Bench +3.7 但不显著，于是**故意不进名单**（`:358-361`）。
   这是"提示词要按模型验，不是 universality 信仰"的样本。
3. **身份纠偏**：阿里 Coding Plan 一律上报 `glm-4.7`，`(provider == alibaba)` 时注入真实模型 ID 并要求按它回答（`agent/system_prompt.py:616-627`）。
4. **缓存**：默认 4 个 `cache_control` 断点（静态 system 前缀、system 末尾、最后两条非 system 消息；无静态前缀时 1+3），TTL 5m/1h（`agent/prompt_caching.py:1-5,119-121,469`）。
   provider 路由决定能否用标记、TTL 上限（`:258-288`）；工具结果在非原生 Anthropic 上不挂 part 级标记（`:25-34,59-79`）。
   构建器可在用户消息里注册"稳定脚手架前缀"，缓存规划器在该边界打点，避免按分隔符猜（`agent/prompt_cache_boundary.py:1-58`）。
5. **缓存作用域**：按会话血缘解析稳定 scope；fork 子会话隔离，同一父的多个子共享 `sub_` scope 以复用公共前缀（`agent/prompt_cache_scope.py:184-231`）。
6. **思考**：Anthropic thinking 有签名回放与跨模型拒绝修复（`agent/anthropic_thinking_replay.py`、`agent/anthropic_thinking_policy.py`）。
7. **TTL 自适应**：TTL 由来源与模型族决定，短会话用 5m、长会话可升到 1h；升级后整条前缀都带 1h 标记，
   所以只在缓存边界重建时改（`agent/prompt_caching.py:164-206`）。路由目录可声明是否支持标记，
   未知路由走"已学习/目录声明"两级判断，避免给不支持的 provider 乱打标（`:258-288`）。

---

## 7. 踩空点（只搬提示词会缺什么）

只复制"人格 + 纪律块"会在六处落空：
① 三档顺序与 LRU/静态前缀缓存机制（`agent/system_prompt.py:770-846`；`agent/prompt_caching.py:469`）；
② 模型分档名单与按 provider 的 TTL/标记能力（`agent/prompt_builder.py:362-379`；`agent/prompt_caching.py:258-288`）；
③ 工具集变化时的描述裁剪，否则教模型调用不存在的工具（`model_tools.py:414-438`）；
④ guardrail 的循环检测与停轮（`agent/tool_guardrails.py:19-40`）；
⑤ yolo 之上的不可绕过审批地板（`agent/runtime_self_protection.py:10-13`）；
⑥ 压缩前缀的"仅参考"语义与未验证假设专节（`agent/context_compressor.py:275-307`；
`agent/context_compressor_prompt_rules.py:11-21`）——少了它，旧任务会在压缩后复活。

---

## 8. `hermes` Brain 草案

> 只取行为与结构，产品名与工具名改成 WitCode 的说法；"待 Harness 支持"表示需要插槽。

| 槽 | 填什么 |
|---|---|
| **identity** | 你是 WitCode 的交互式智能体。回答长度随问题分量：一句问一句答，完成的工作给短报告（改了什么、验过什么、还剩什么），不复述过程。不写"好问题""很高兴帮忙"这类填充语，不把用户请求原样说回去，不旁白用户看得见的工具调用。不确定就直说；同意是因为对，不是因为用户说了。深度靠挣得：用户要细节、在教东西或风险高时才展开。 |
| **rules** | 1) 交付可运行产物而非描述，不用桩或计划冒充完成；工具失败走替代路径，绝不编造结果。2) 说了要做就同轮调用工具，不以"下一步我会……"收尾。3) 独立读取/搜索批量发，只在真依赖时串行。4) 先读后改、验过才说完成；编辑失败重读，两次失败改整文件重写。5) 算术、哈希、时间、系统状态、git 历史一律用工具取，不靠记忆。6) 外部写入后回读目标确认，计数不一致就重新解析别硬报。7) 标识符/命令原样保留，不"修"格式不对的 token。 |
| **tools.descriptions** | `read_file`：带行号分页读文本；用它代替 cat/head/tail；超长返回续读偏移；图片改用专用视觉工具。`patch`：定向文本替换，代替 sed/awk；模糊匹配、返回 diff、改后自动语法检查；同区两次失败改重写整文件。`terminal`：执行命令，cwd 与导出变量跨调用保留；读/搜/改用专用工具；输出自动截断落盘，禁止自带 head/tail。deferred 三件套：先 `tool_search` 找名字，`tool_describe` 一次批量取 schema，再 `tool_call` 调用，审批照常生效。 |
| **modes** | `plan`（只读）：仅规划、不改项目文件（除计划文件）、不跑变更命令；产物写到约定目录；写给零上下文实现者，含精确路径、可复制代码、带期望输出的验证命令与 TDD 循环；本轮不执行。待 Harness：把整段作为用户轮次注入以保住缓存前缀。 |
| **prompts.compact** | 结构化 checkpoint：历史任务快照 / 已完成动作 / 当前状态 / 已解决问题 / 待办；迭代更新时迁移条目，历史任务快照更新为最近未满足的用户输入；不确定项单列 `UNVERIFIED: 断言 — 依据`；密钥 `[REDACTED]`；摘要仅作背景参考，只响应其后最新用户消息。 |
| **flow** | `tool.resolveBeforePermission: true`；`approval: 'ask'`（且危险操作有不可绕过地板）；`compaction.strategy: 'summary'`。待 Harness：工具循环 guardrail（同参同果 3 次告警、周期检测、无进展停轮）、按工具集裁剪执行指导行、按 provider 的缓存 TTL 上限。 |
| **modelProfile** | `preferredModels: ['gpt-*','codex','gemini','glm-*','qwen','deepseek','kimi','minimax','mimo','mistral']`（按模型族注入纪律块）；`reasoning: 'separate'`（Anthropic 签名回放）；`toolCallFormat: 'openai'`；`cache: 'prefix'`（4 断点、5m/1h、fork 隔离与兄弟共享 scope）；`emptyResponseRetry: true`。 |
