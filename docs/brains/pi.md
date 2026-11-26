# Pi（`main` 分支）脑子拆解

只描述"是什么、怎么用"，不作优劣评价。所有 `文件:行号` 相对于仓库根 `D:\Files\Projects\WitCode\resources\agents\pi`。
许可证 MIT。行为层集中在 `packages/coding-agent/src/core`（system-prompt、tools、compaction、agent-session）；
协议层在 `packages/ai`。仓库自称"minimal, extensible harness"，并明确**不自带 sub-agents 与 plan mode**
（`README.md:19`），所以它的"脑子"刻意做得薄且可替换。

---

## 1. 它的"脑子"由什么组成

| 成分 | 文件 | 一句话 |
|---|---|---|
| 身份 | `packages/coding-agent/src/core/system-prompt.ts:155-156` | preamble 只有一句"在 pi 里帮用户查看/运行/改代码" |
| 规则 / 工具纪律 | `system-prompt.ts:88-125`；`tools/*.ts` 的 `snippet`/`guidelines` | 规则是工具贡献的短句 + 两条通用句 |
| 上下文 | `system-prompt.ts:79-86,171-182`；`resource-loader.ts` | 项目指令、技能、cwd 各自成段 |
| 压缩 | `core/compaction/compaction.ts:507-579`；`compaction/utils.ts:162-164` | 六节 checkpoint，初版+更新两版模板 |
| 模式 | 无 | README 明说跳过 plan mode 与 sub-agents（`README.md:19`） |
| 子代理 | 无内置 | 需自己写 extension 或装包 |
| 权限 | 无内置权限系统 | 以 OS 用户权限运行、不逐次征询（`README.md:90`；`docs/security.md:3-7`） |

**关键结论：Pi 的"脑子"= 一套带标签的、可被逐段替换的 system 段 + 一份由工具贡献的规则表 + 结构化压缩。**
它没有长人格、没有模式、没有子代理、没有审批钩子，安全边界靠"项目信任 + 沙箱/容器"，不靠提示词。

---

## 2. system prompt 的结构与顺序

### 2.1 分节表（核心设计）

`buildSystemPromptSections()`（`system-prompt.ts:127-192`）产出有序 `SystemPromptSections`：
`preamble` 是不带标签的纯文本；其余每节都包在同名 XML 标签里，便于模型把后续更新对上号（`:51-56,187-191`）。

| # | 段名 | 内容 | 来源 |
|---|---|---|---|
| 1 | `preamble` | 一句话身份 + 能力概述 | `system-prompt.ts:155-156` |
| 2 | `tools` | 逐行 `- 工具名: 一行片段`，缺省 `[read,bash,edit,write]` | `:64,150-160` |
| 3 | `rules` | 工具 guidelines + promptGuidelines + 两条通用句 | `:88-125,161` |
| 4 | `docs` | 何时读 pi 自身文档的路径与规则 | `:162-168` |
| 5 | `addendum` | 用户配置追加文本 | `:171` |
| 6 | `project_context` | `<project_instructions path="...">` 包裹的上下文文件 | `:79-86,172` |
| 7 | `skills` | 技能目录（仅在有 read/bash 可读时给） | `:173-181` |
| 8 | `cwd` | 工作目录，反斜杠转正斜杠 | `:182` |
| 9 | 自定义段 | extension 注入的 XML 段，名字须合正则、不能叫 preamble | `:29-30,144-148,183-185` |

`forceSystemPrompt` 是"完全替换"逃生口：返回后不进结构化段，直接作为请求的首条 system（`system-prompt.ts:194-204`；
`agent-session.ts:1850-1858`）。

### 2.2 动态更新 = 段级补丁

`diffSystemPromptSections()`（`system-prompt.ts:216-228`）拿"从会话回放出的当前段"跟目标段比：
变化段给新文本，删除段给 `null`，无变化返回 `undefined`。
`_preparePromptAndToolLoadout()` 据此生成一条 `role:system, content:"", sections:patch` 的消息，
且工具清单与规则必须和本请求声明的工具一致（`agent-session.ts:1836-1848`）。
**这就是 Pi 的缓存锚点：稳定段原样留在前缀，只发变化段的补丁。** 没有 stable/dynamic 标志，
但每段自带标签使补丁可对齐。

---

## 3. 工具描述写法

Pi 把描述拆成两个载体：工具定义上的 `snippet`（进 system 的 `tools` 段）与 `guidelines`（进 `rules` 段），
参数schema 里再写细节（`tools/read.ts:14-23`）。`buildRules()` 还会按工具组合补一句：
若只有 bash/powershell 而无 grep/find/ls，就提示"用 shell 做列目录/搜索/找文件"（`system-prompt.ts:102-116`）。

- **read**（`tools/read.ts:14-23`）：snippet "读文件内容"；guideline "用 read 而不是 cat/sed"；
  参数写清 path 相对/绝对皆可、offset 从 1 开始、limit 为最大行数；实现按字节/行数截断并保留尾行判断（`:110-220`）。
- **edit**（`tools/edit.ts:18-44,146-147`）：snippet "精确文本替换、一次调用可做多处不重叠改动"；
  guideline "局部改动用 edit，同一文件的改动合并到一次调用"；参数注释写死"每处 oldText 必须在原文件唯一且不重叠、
  匹配针对原文件而非增量、相邻改动应合并为一条"——**纪律写在参数描述里**。
- **bash**（`tools/bash.ts:40-46`）：snippet "执行 bash 命令（ls、grep、find 等）"；
  guideline "可查看 PI_* 环境变量了解当前模型与会话"；timeout 以秒计、可选无默认（`:26-36,41`），
  输出合并 stdout/stderr、可截断并给出 full_output_path（`:56-62`）。
- **write**（`tools/write.ts:16-17`）：snippet "新建或整体覆盖文件"；guideline "只用于新文件或完整重写"——
  反向约束极短但明确。

---

## 4. 模式

**没有模式层。** 仓库定位就是"跳过 plan mode 与 sub-agents"（`README.md:19`），
需要时让模型自己写一个 extension，或从包市场装。
既有的是"工具 loadout"：`prepareLoadout` 可隐藏工具声明，被隐藏的工具只能通过另一工具间接到达，
此时工具清单与规则都不列出它（`system-prompt.ts:16-20,150`；`agent-session.ts:1826-1842`）。
`before_agent_start` handler 可整体替换 system、追加文本或注入规则（`agent-session.ts:1850-1858,2007`；
`extensions/types.ts:587,615`）。**结论：Pi 把"模式"外包给扩展，核心只有可替换的段与工具集合。**

---

## 5. 提示词怎么落地

| 提示词/约束 | 落地机制 | 位置 |
|---|---|---|
| 段级更新不破坏前缀 | 段 diff 补丁，只发变化段 | `system-prompt.ts:216-228`；`agent-session.ts:1843-1847` |
| 规则与工具声明一致 | loadout 隐藏工具后同步移除清单与 guidelines | `agent-session.ts:1840-1842` |
| 工具纪律 | snippet/guidelines 由工具插件贡献、去重后加入 rules | `system-prompt.ts:88-125` |
| 项目指令可信度 | 项目信任后才加载 `.pi/SYSTEM.md` 等资源；不限制已启动工具 | `docs/security.md:32-45` |
| 不逐次审批 | 无权限系统，靠 OS 权限/容器隔离 | `README.md:90`；`docs/security.md:3-7` |
| 压缩不写缓存 | 摘要请求 `cacheRetention:"none"` + 新 sessionId | `compaction.ts:626-632` |
| 摘要不落半截 | length/error 判失败；检测到 toolCall 判失败 | `compaction.ts:585-593,746-748` |
| 流式抖动兜底 | 摘要调用统一包 `retryAssistantCall` | `compaction.ts:611-638` |

**踩空逻辑**：Pi 几乎全部"保证"都在结构（段 diff、工具 loadout、项目信任）和流程（压缩重试、截断判定）里，
提示词本身很薄。只搬 preamble 和 rules 句子，会丢掉段级补丁与沙箱边界这两根支柱。

---

## 6. 模型适配

### 6.1 不为单一模型调优，做通用协议层

`packages/ai/src/api/` 下有 anthropic-messages、openai-completions/responses、azure-openai-responses、
google-generative-ai/vertex、bedrock-converse-stream、mistral-conversations、pi-messages 等协议实现（目录列表）。
`pi-messages` 是自家 wire：POST `{model,context,options}`、`sse` 返回 assistant 事件（`api/pi-messages.ts:1-9,32-38`）。
`Model` 通用字段有 `reasoning`、`thinkingLevelMap`、`toolChoice` 等（`types.ts:882-887,258,394`）。

### 6.2 思考 / 缓存 / 工具格式

- **思考**：统一 `ThinkingLevel`（off/minimal/low/medium/high/xhigh/max），由 `thinkingLevelMap` 映射到各家 effort
  （`anthropic-messages.ts:1073-1127`；`models.ts:1315-1318`）；不可用时只给 off。
  `thinkingSignature` 作为不透明回放数据保留（`types.ts:445`），Anthropic 的 thinking block 依赖它。
- **缓存**：`cacheRetention` 支持 none/short/long 与 sessionId 亲和（`types.ts:258`；
  `anthropic-messages.ts:83-98,728-729`）；有 cache-warming 与 affinity 测试（`cache-warming.ts:57-70`）。
  摘要请求刻意 `cacheRetention:"none"`（`compaction.ts:628-632`）。
- **工具格式**：`toolChoice` 支持 auto/none/required/指定函数（`api/pi-messages.ts:35`），
  tool call id 做归一化（测试 `openai-responses-foreign-toolcall-id.test.ts`），流式参数用 `ToolCallArgumentsStream` 累积（`pi-messages.ts:39`）。

### 6.3 一句话总结

Pi 的提示词是模型无关的薄外壳，真正的适配在 `packages/ai` 的多协议 + thinking 映射 + cache retention。
只搬文本而不接协议层，reasoning 续接与缓存都会落空。

---

## 7. 踩空点（只搬提示词会缺什么）

1. **段级补丁**：没有 `diffSystemPromptSections` 与 `SystemMessage.sections`，整套按标签替换的能力消失，
   配置变更只能整段重发、破坏前缀。
2. **无权限 ≠ 安全**：Pi 靠容器/沙箱；搬到 WitCode 若不接权限钩子，"没有审批"会直接变成越权写入。
3. **压缩结构**：六节模板之外的 file-ops 追加（`compaction.ts:1042-1044`）、断点不在 toolResult（`:351-406`）、
   split-turn 合并（`:980-1019`）、`cacheRetention:"none"`（`:628-632`）都没了。
4. **扩展生态**：自定义提示词、技能、命令都走 extension/package；WitCode 若没有等价加载机制，
   Pi 的"可定制"优势无法复现。
5. **模型适配**：thinking level 映射、signature 回放、cache retention 与 tool id 归一化在 `packages/ai`，
   不是提示词文本。

---

## 8. Brain 草案（可做成 `packages/brains/src/pi.ts` 的提炼）

**identity**（3-6 行）
```
你是 WitCode 的编码助手，帮用户查看文件、运行命令、修改代码。
先看清再动手：编辑用精确替换，新建/整体重写才用 write；搜索用 grep、找文件用 find、列目录用 ls。
回答简洁，引用文件时给出清晰路径。工作目录与项目指令以会话注入的段为准。
```

**rules**（4-8 条）
1. 用专用工具替代 shell 的 cat/sed/ls/find/grep；同一文件的多处改动合并为一次 edit。
2. 精确替换：每个 oldText 在原文中唯一、彼此不重叠；匹配基于原文件，不基于上次改后的增量。
3. 只依据本会话已建立的事实汇报；不续写压缩前对话、不把摘要请求本身说给用户。
4. 项目指令来自受信任加载的段；工具的 OS 权限边界之外不要尝试绕过（用沙箱/容器约束）。
5. 压缩摘要保留文件路径、函数名与错误串原样，按固定六节输出。
6. 被隐藏的工具不可直接调用，只能通过暴露它的另一个工具使用。

**tools.descriptions**（4 个）
- `read`：用途"读文件（带行号分页，支持图片）"；何时用——编辑前、核对上下文；不用——cat/sed 替代；参数 path 相对/绝对、offset 1-based、limit 封顶。
- `edit`：用途"精确文本替换，一次可多处不重叠"；何时用——局部改动并合并同文件改动；不用——新建/整文件重写；纪律：oldText 唯一、不重叠、基于原文。
- `bash`：用途"执行命令返回合并输出与退出码"；何时用——无专用工具的系统操作；不用——读/搜/列目录；timeout 秒计、输出可截断并存全量文件。
- `write`：用途"新建或整体覆盖文件"；何时用——只有新文件或明确整文件重写；不用——局部改动用 edit。

**modes**：无（核心不带 plan/subagent；如需则通过扩展的 `before_agent_start` 与工具 loadout 实现）。

**prompts.compact**（要点）
- 摘要系统提示：只输出结构化摘要，不续写对话、不回答其中问题。
- 六节：Goal / Constraints & Preferences / Progress(Done, In Progress, Blocked) / Key Decisions / Next Steps / Critical Context。
- 更新版：保留旧信息、加新进展、把 Done 项从 In Progress 移走、删已解决阻塞、移除过时项。
- 对话包在 `<conversation>`，旧摘要包在 `<previous-summary>`；末尾追加读/改文件清单；摘要请求禁缓存写入并包重试。

**flow**：`tool.resolveBeforePermission` 不适用（无权限系统，靠 OS/沙箱）；`compaction.strategy='summary'`（含 split-turn 两段合并）；`approval` 不适用（无内置审批）。

**modelProfile**：`preferredModels` 不设（模型无关）；`reasoning='separate'`（ThinkingLevel 映射 + thinkingSignature 回放）；
`toolCallFormat='openai'`（多协议，按 Model.api 选择）；`cache='prefix'`（cacheRetention + sessionId 亲和，摘要 none）；`emptyResponseRetry=true`（摘要统一走 retryAssistantCall）。
