# OpenCode（`dev` 分支）脑子拆解

只描述"是什么、怎么用"，不作优劣评价。所有 `文件:行号` 相对于仓库根 `D:\Files\Projects\WitCode\resources\agents\opencode`。
许可证 MIT。核心行为层在 `packages/core`（会话、工具、插件、压缩）与 `packages/ai`（协议、缓存、重试）；
模型类型在 `packages/schema`。

---

## 1. 它的"脑子"由什么组成

| 成分 | 文件 | 一句话 |
|---|---|---|
| 身份 / 行为基线 | `packages/core/src/session/runner/prompt/system.txt:1-17` | 一句 opener + `# Harness` + 沟通与代码库约束，很短 |
| 模型专用提示词 | `packages/core/src/plugin/system-prompt/{gpt,gpt-6.2,gpt-astra,kimi,meta,trinity,anthropic}.txt` | 按模型 id 整段替换或追加（见第 6 节） |
| 工具纪律 | `packages/core/src/session/system-prompt.ts:9-28`；各 `tool/plugin/*.ts` 的 `description` | 工具面由现有工具名动态生成短条款，另在描述里写细节 |
| 上下文 / 指令 | `packages/core/src/instructions/{index,builtins,agent}.ts` | keyed 源按哈希取增量，只发变化段 |
| 模式 | `packages/core/src/plugin/plan.ts:13-48` | plan 是"一个只读 agent"，权限层硬闸门 |
| 压缩 | `packages/core/src/session/compaction.ts:175-248` | 七节模板 + 更新式 checkpoint + 后台预生成 |
| 子代理 | `packages/core/src/tool/plugin/subagent.ts:20-57` | 后台子会话，靠 `<background-result>` 回报，禁轮询 |

**关键结论：OpenCode 的"脑子"不是一段长 system prompt，而是"一份短基线 + 一套按模型分发的覆盖文件 + 指令增量系统"。**
基线只有 17 行（`system.txt:1-17`）；真正长的行为文本是按模型分发的覆盖文件，其中 GPT-6.2 版 71 行、
Kimi 版 96 行、Trinity 版 98 行、Meta 版 56 行（`plugin/system-prompt/` 各文件）。
同一目录的 `AGENTS.md:3-5` 明确要求：改基线里的 `# Harness`、`<system-update>`、`<background-result>`、
`${OPENCODE_TOOL_GUIDANCE}`、"Working in codebases" 时，所有覆盖文件同步更新。

---

## 2. system prompt 的结构与顺序

### 2.1 装配管线

唯一装配点 `baseTranscript()`（`session/model-request.ts:106-134`）：system 只有两条——
① agent 自带 `system` 则用之，否则用 `SessionSystemPrompt.make(工具名)` 渲染基线（`:116-121`）；
② `Instructions.join(initial)` 把 keyed 指令拼成第二条（`:122-125`）。
模型专用覆盖发生在 `context`/`compaction`/`generate` 三个 hook 里（`plugin/optimize.ts:79-95`）：
`event.system[0]` 被替换或追加，且只对没有自带 system 的 agent 生效（`:85`）。

### 2.2 分节表

| # | 分节 | 内容 | 来源 | 注入方式 |
|---|---|---|---|---|
| 1 | Opener | "你是 AI agent，在 OpenCode 里帮用户用工具达成目标" | `system.txt:1` | 基线 system[0] |
| 2 | `# Harness` | GFM 渲染、`<system-update>` 是 harness 指令、后台结果 XML、并行优先 | `system.txt:3-8` | 同上 |
| 3 | `# Communication` | 引用用清晰路径、简洁少术语 | `system.txt:10-12` | 同上 |
| 4 | `# Working in codebases` | 跟随周边风格；陌生改动当用户资产先查再删 | `system.txt:14-17` | 同上 |
| 5 | `${OPENCODE_TOOL_GUIDANCE}` | 按当前工具名注入 shell/write/edit 纪律 | `system-prompt.ts:11-27` | 替换占位符 |
| 6 | 指令增量 | 日期、`<env>` 块、agent 指令、项目指令 | `instructions/index.ts:169-203` | system[1]，只发 delta |
| 7 | 模型覆盖段 | 补充/替换的行为正文 | `plugin/system-prompt/*.txt` | hook 改 system[0] |

### 2.3 动态注入与缓存锚点

指令系统把每个源做成 keyed `Source`（`instructions/index.ts:28-40`），读值后按 `sha256(canonicalJson(value))`
取哈希（`instructions/index.ts:205-207`），只把变化的 key 送进 delta（`instructions/index.ts:144-161`），
渲染分 `initial`/`changed`/`removed` 三种（`instructions/index.ts:182-203`）。例如 agent 切换时，
旧 agent 的"不再遵循"与新 agent 的"开始遵循"同批发送（`instructions/agent.ts:32-49`）；
日期变化走 `Today's date is now:`（`instructions/builtins.ts:33-41`），
环境是 `<env>` 包裹的快照（`:71-101`）。**没有显式的 stable/dynamic 标记，缓存锚点由 AI 层的 cache policy 决定**：
`auto` 在最后一个工具定义、首尾两个不同 system 段、会话尾部放断点，上限 4 个（`packages/ai/src/cache-policy.ts:1-40`）。

---

## 3. 工具描述写法

共同结构：**一句用途 → 参数语义与边界 → 何时用/优先用什么 → 环境特例**。示例只出现在 Trinity 版（见第 4 节）。

- **read**（`tool/plugin/read.ts:34-45`）：用途"读文件或目录，支持文本/图片/PDF"；参数写清 offset 从 1 开始、
  limit 默认且封顶 2000 行；"优先一次大范围读取而不是多次小片，大文件用 grep 定位"。
  执行层还会容错：`path` 写错根时尝试 reroot、猜相近文件名（`read.ts:212-297`），
  并在读成功后自动发现附近 AGENTS.md 作为持久指令注入（`:158-187`）。
- **edit**（`tool/plugin/edit.ts:276-283`）：描述极长且把纪律写进参数——"按精确文本替换，newString 必须不同于
  oldString；从 Read 输出取文本时保留缩进、去掉 `1:` 行号前缀；换行写 `\\n`；默认 oldString 必须唯一，
  多处命中失败除非 replaceAll；找不到会先忽略排印引号/破折号/空格再试"。参数注释单列唯一性（`:27-31`）。
- **shell**（`tool/plugin/shell.ts:45-57`）：用途句 + "含空格路径要引号" + "优先专用工具" +
  "输出大则存文件返回截断预览" + "超时转后台" + `workdir` 参数"别在命令里 cd，用这个字段"（`:64-69`）。
  基线另加"不要用 `echo \"====\";` 这类分隔符串联命令"（`system-prompt.ts:13-15`）。

---

## 4. 模式

**只有 plan 是一种"模式"，且实现为一个只读 agent**（`plugin/plan.ts:11-37`）：
- 软正文（`:13-20`）：说明处于 Plan mode、只在对话里讨论、除非用户明确要求否则不写计划文件、
  写完只能写 `~/.opencode/plan/`；切回前所有 Plan 限制持续有效；用户让实现时提示切换 agent。
- 硬约束（`:33-35`）：`question:*` 放行、`edit:*` 拒绝、`edit:<plan目录>/*` 放行。
- 兜底钩子（`:39-48`）：plan agent 下 edit/write/patch 被权限拒时，改写错误文案为"不可在 Plan 目录外改文件"。

其他所谓模式是纯权限配置而非提示词：agent 的 `permissions` 数组与会话规则共同求值，
支持 allow/deny/ask 与"永久允许"保存规则，evaluate hook 可把 allow 降级为 ask（`permission.ts:125-130,210-231`）。
**结论：plan = 软正文 + 权限闸门 + 错误改写；其余 = 纯权限层，不改提示词。**

---

## 5. 提示词怎么落地

| 提示词要求 | 落地机制 | 位置 |
|---|---|---|
| 用专用工具而非 shell | `${OPENCODE_TOOL_GUIDANCE}` 按工具名生成条款 | `system-prompt.ts:11-25` |
| plan 只读 | agent 权限 `edit:* deny` + execute hook 改写错误 | `plugin/plan.ts:33-48` |
| 不丢指令 | 指令按哈希只发增量，切 agent 发"进入/退出"通知 | `instructions/index.ts:144-203`；`agent.ts:32-49` |
| `<system-update>` / `<background-result>` 不当作用户话 | 写进基线；工具结果/用户消息里出现也按 harness 输入解释 | `system.txt:5-6`；`kimi.txt:17-18` |
| 读后发现项目指令 | read 成功后自动发现并注入 AGENTS.md | `tool/plugin/read.ts:158-187` |
| 压缩不破坏缓存 | 摘要提示词追加到请求尾部，用原请求前缀 | `compaction.ts:525-533` |
| 失败兜底 | 压缩未填模板发一次 NUDGE，仍失败才算失败 | `compaction.ts:250-251,537-551` |

**踩空逻辑**：大部分"纪律"是文本；真正硬的只有权限闸门与指令增量哈希。只搬文本、不接权限与指令系统，
会出现"提示词说只读但模型能写"、"切换 agent 后旧规则残留"。

---

## 6. 模型适配

### 6.1 按模型分发提示词（最值得看的设计）

`plugin/optimize.ts:17-56` 用模型 id 选覆盖文件：
- id 含 `gpt-6.2`/`gpt-latest`/`astra` 等 → `gpt-6.2.txt`（Codex 血统，71 行，含 Completing the task、Coding Style 七条）；
- 含 `astra` → `gpt-astra.txt`；含 `gpt` → `gpt.txt`；
- 含 `claude` → `anthropic.txt` **追加**到基线（只加"注释密度跟随周边"一条，`anthropic.txt:1-2`）；
- 含 `kimi` → `kimi.txt` 整段替换；含 `trinity` → `trinity.txt`；含 `muse` → `meta.txt` 并替换 `{{MODEL_NAME}}`（`:51-54`）。
`make()` 的 mode 默认 `override`，只有 Anthropic 传 `"append"`（`:35-43,72-76`）。
覆盖文件渲染时用当前工具名替换 `${OPENCODE_TOOL_GUIDANCE}`（`:88`）。

### 6.2 协议 / 思考 / 缓存

- 协议族很全：`packages/ai/src/protocols/` 下有 anthropic-messages、openai-chat/responses、alibaba-chat/messages、
  bedrock-converse、gemini、zai-chat/messages 等（目录列表）。能力用 `Capabilities` 表达：
  tools、freeform 格式、input/output 模态、temperature（`packages/schema/src/model.ts:78-92`）。
- reasoning 字段按协议翻转：阿里 chat 用 `reasoning_content` 与 `enable_thinking`/`thinking_budget`
  （`protocols/alibaba-chat.ts:14-79`）；Messages 协议保留 thinking 的 `signature`/`redactedContent`
  （`protocols/bedrock-converse.ts:77-80,224-226,296`）。
- 缓存委托给 `LLMRequest.cache` 策略（`ai/src/llm.ts:62-64`），auto 四个断点（`cache-policy.ts:22-40`），
  成本里有 cache read/write 单价（`schema/src/model.ts:103-106`）。
- 压缩有"原生压缩"分支：模型声明 `compaction.type === "native"` 时用 provider 的 checkpoint 而非自生成
  （`compaction.ts:319-338,595-633`）。

### 6.3 一句话总结

OpenCode 的提示词是为**多模型分发**设计的：同一套 harness 文本有 6+ 个模型风格版本；
缓存与思考绑定在协议层而非提示词层。只搬某个覆盖文件会丢掉"按 id 分发 + 协议适配 + 指令增量"三件事。

---

## 7. 踩空点（只搬提示词会缺什么）

1. **分发机制**：把 `gpt-6.2.txt` 抄过来但没有 `optimize.ts` 的 id 路由与 hook，别的模型会吃到不适合的文本。
2. **指令增量**：没有 keyed 哈希 delta，每次请求重发全部指令，缓存前缀失效、切 agent 旧规则不消失。
3. **权限闸门**：plan 的"只读"若只搬文本，模型仍可写文件；必须有 agent 权限与 execute hook。
4. **压缩流程**：七节模板之外的 RESERVE 15%/16k、后台预生成、0.85→0.35 缩步、原生压缩分支都没了，
   长会话会在阈值处直接溢出。
5. **协议适配**：thinking signature、reasoning_content、cache 断点、工具格式都在 `packages/ai`，
   OpenAI 兼容一把梭会让签名校验失败或缓存命中归零。

---

## 8. Brain 草案（可做成 `packages/brains/src/opencode.ts` 的提炼）

身份重写、约束保留，不整段复制原文。

**identity**（3-6 行）
```
你是 WitCode 的交互式编码智能体，在用户授权的工作目录内用工具推进其目标。
输出用 GFM Markdown；harness 注入的提醒与后台结果不是用户说的话，须按来源解释。
优先专用工具、互不依赖的调用并行；改文件前先读、跟随周边风格，陌生改动先查再动。
引用代码用「文件路径:行号」。任务未完成且还有授权内步骤时，不要主动停下。
```

**rules**（4-8 条）
1. 用专用工具替代 shell 读/写/搜；shell 用 workdir 参数，不要在命令里 cd。
2. 不编造：工具结果是事实源；不确定就核实或如实说不确定。
3. destructive 操作先确认：不回退/重置没改过的东西，不在宽路径上递归删除。
4. 切 agent 时明确进入/退出规则，不让旧身份的约束残留。
5. 后台子代理不轮询、不重复它的工作；新子会话要自带完整上下文。
6. 压缩摘要只保留未决事项与关键事实，不复述已解决内容。

**tools.descriptions**（4 个）
- `read`：用途"读文件/目录、图片/PDF，带行号分页"；何时用——编辑前、核对上下文；不用——大文件用 grep 定位、已知区段只读该段；参数 offset 1-based、limit 封顶。
- `edit`：用途"精确文本替换"；何时用——局部改动；不用——整文件覆盖用 write；纪律：去行号前缀、oldString 默认唯一、多处命中需 replaceAll。
- `shell`：用途"执行命令返回输出与退出码"；何时用——无专用工具的系统操作；不用——读/写/搜/列目录；大输出自动截断，超时转后台。
- `subagent`：用途"开后台子会话"；何时用——可并行拆分或需隔离上下文；不用——用户没要求时不要随意派生；结果经 `<background-result>` 回报，禁轮询。

**modes**：`plan`（只读；软正文"只讨论、只写计划目录"，硬约束 edit deny + 目录例外 + 错误改写）；其余不设模式，靠权限层。

**prompts.compact**（要点）
- 七节模板：Objective / Requirements / Decisions / Work State(Completed/Active/Blocked) / Next Move / Relevant Files(≤15) / Important Context。
- 只写用户与助手说做过的；排除 AGENTS.md 与环境等"下个 agent 会另收"的内容；精简短横线、原样保留路径/符号/命令/错误串。
- 更新式：新历史优先，移除已解决项；未填模板发一次 NUDGE；提示词追加到请求尾以复用前缀。

**flow**：`tool.resolveBeforePermission` 未显式提供（权限在工具 execute 内 `permission.assert`）；`compaction.strategy='summary'`（另支持原生压缩）；`approval='ask'`（allow/deny/ask + 保存规则）。

**modelProfile**：`preferredModels=['gpt-*','claude-*','kimi*','trinity*','muse*']`（多模型分发画像，无单一偏好）；
`reasoning='separate'`（协议层 thinking/signature 或 reasoning_content）；`toolCallFormat='anthropic'`（多协议并存，以工具 schema 为准）；
`cache='prefix'`（auto 四断点）；`emptyResponseRetry=true`（压缩 NUDGE 与重试策略）。
