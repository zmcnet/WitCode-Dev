# Codex 提示词体系拆解（openai/codex，main）

只描述"是什么、怎么落地"，不作优劣评价。所有 `文件:行号` 相对于仓库根 `D:\Files\Projects\WitCode\resources\agents\codex\`；模型目录为 `codex-rs/models-manager/models.json`（单行较长，按 `slug` 与字段定位）。本文只取行为层，不照抄英文原文。

---

## 1. “脑子”由什么组成

| 成分 | 位置 | 一句话 |
|---|---|---|
| 身份 | `codex-rs/models-manager/models.json` 各模型 `model_messages.instructions_template`；旧模板 `codex-rs/core/gpt_5_codex_prompt.md:1`、`gpt_5_1_prompt.md:1` | 身份是**按模型下发**的，不是全仓唯一一段 |
| 规则 | `models.json` 的 `instructions_template`（# Rules for getting work done / # When to ask the user for permission / # Autonomy and persistence）；`codex-rs/core/gpt_5_codex_prompt.md:7-31` | 编辑约束、脏工作树保护、确认时机、端到端负责 |
| 工具纪律 | 同上 `## General`（优先 rg）+ 工具 `description` 字段 + `codex-rs/core/src/tools/handlers/apply_patch_spec.rs:20` | "何时用/不用"多写在身份正文里，工具描述本身很短 |
| 模式 | `codex-rs/prompts/templates/permissions/approval_policy/*.md`、`sandbox_mode/*.md`；`codex-rs/prompts/src/update_plan_instructions.rs:4` | 审批/沙箱是模板化片段，plan 是工具不是模式 |
| 上下文 | `codex-rs/core/src/context/mod.rs:3-52`（几十种 ContextFragment）；`world_state/` | 运行时事实以带 `kind` 的片段注入，可被分类过滤 |
| 压缩 | `codex-rs/prompts/templates/compact/prompt.md:1-9`、`summary_prefix.md:1` | 极简交接摘要，无九节模板 |
| 子代理 | `codex-rs/prompts/src/multi_agent_instructions.rs:9-22,50-100`；`codex-rs/core/src/agent/child_config.rs:138-146` | 共享工作目录、并发槽位、模型覆盖受控 |

**关键结论**：Codex 的脑子是"模型目录里的长模板 + 一篮子上下文片段 + 权限模板"，不是一段写死的 system prompt。换模型就换整套人格与规则（`models.json` 共 14 个模型，模板长度从约 2 万到 2.6 万字符）。

---

## 2. system prompt 的结构与顺序

1. **装配点**：`codex-rs/core/src/client.rs:1296-1303` 把 `base_instructions.text` 包装成 `BaseInstructionsFragment` 插到输入前缀；`client.rs:1289-1295` 先放工具列表（普通 Responses 工具或 `responses_lite` 的 `AdditionalTools`）。
2. **模板来源**：`codex-rs/prompts/src/model_instructions.rs:8-16` 只从当前模型的 `model_messages.instructions_template` 取值，缺模板则告警并返回空；`codex-rs/prompts/src/model_messages.rs:88-93` 保留"来自目录还是内置"的来源标记。
3. **模板内部顺序**（以 `gpt-6.2-sol` 为例，`models.json` 该 slug 的 `instructions_template`）：`# Personality`（含写作风格、中间 commentary、最终答复）→ `# Rules for getting work done` → `# When to ask the user for permission` → `# Autonomy and persistence` → 前端设计 → 编码风格 → 与用户协作（含格式规则）→ 技能 → 插件/应用边界。旧版 `gpt_5_codex_prompt.md:1-68` 则是 General → Editing constraints → Plan tool → Special requests → Presenting work。
4. **片段化注入**：`codex-rs/core/src/context/mod.rs:3-52` 列出 memory、环境、时间、token 预算、git、子代理通知、guardian 政策等独立片段；`world_state/` 下的 apps/plugins/environments 段属于"世界状态"更新。
5. **权限段**：`codex-rs/prompts/src/permissions_instructions.rs:104-160` 按沙箱模式、审批策略、可写根、拒绝读路径顺序拼一段 developer 文本，路径总量上限 32KB（`:37`、`:106-118`）。
6. **缓存观**：没有显式 stable/dynamic 标记；靠 `prompt_cache_key` 绑定会话（`codex-rs/core/src/client.rs:802-827`：SessionDerived / Custom / Omit 三策略），并区分 Responses 的 session-id 头。因此**段落顺序与已发字节必须稳定**，这与 ZCode/DSH 的缓存锚点是同一类约束。

---

## 3. 工具描述的写法（3 个样本）

| 工具 | 描述写法 | 纪律落点 |
|---|---|---|
| `exec_command` | 一句用途"在 PTY 里跑命令，返回输出或会话 id"，随后参数级说明 session、workdir、yield 时间、输出预算（`codex-rs/core/src/tools/handlers/shell_spec.rs:8-18,69-86`）；Windows 另附三条安全红线（跨 shell 组合删除、递归操作前核对绝对路径、后台进程隐藏窗口，`:310-323`） | `create_approval_parameters`（`:212-250`）把 `sandbox_permissions`/`justification`/`prefix_rule` 写进 schema |
| `apply_patch` | 一句用途 + "这是 FREEFORM 工具，不要把补丁包成 JSON"（`apply_patch_spec.rs:20`），真正语法交给 Lark 文法（`:7-15`） | 何时用/不用写在身份正文：单文件编辑优先它，自动生成或批量替换不用（`gpt_5_codex_prompt.md:12`） |
| `request_permissions` | "请求额外文件系统或网络权限并等待客户端授予子集"，说明相对路径基准与授权持续时间（`shell_spec.rs:168-180`） | 模板再限定"优先沙箱内增量授权，完整提权是最后手段"（`templates/permissions/approval_policy/on_request_rule_request_permission.md:1-20`） |

归纳：Codex 走的是**短描述 + 长正文 + 强 schema** 三段式；`ToolAnnotations`（readOnly 等）在 MCP 侧承载机器可读纪律。与 ZCode/DSH 把"何时用/何时不用"塞进 `description` 不同，这里更依赖身份模板与权限模板。

---

## 4. 模式

| 模式轴 | 取值 | 改了什么 |
|---|---|---|
| 审批策略 | `never` / `on_request` / `unless-trusted` / `granular` | `never` 明确禁止提供 `sandbox_permissions`（`never.md:1`）；`on_request` 给出提权步骤、`prefix_rule` 好坏例子与禁用词（`on_request.md:1-40`）；`granular` 分"可提示/自动拒绝"两类（`permissions_instructions.rs:39-41`） |
| 沙箱 | `read-only` / `workspace-write` / `danger-full-access` | 三段模板各一句定义读/写边界与网络（`sandbox_mode/*.md:1`） |
| 计划 | `update_plan` 工具 + `without_update_plan_instructions()` | 不是独立模式；没有只读硬闸门；无计划工具时把相关段落从模板里剔除（`update_plan_instructions.rs:4-50`） |
| Code Mode | `tool_mode: code_mode_only`（`models.json` 部分模型） | 工具不再逐个暴露为函数调用，而是作为 `tools.*` 命名空间写进 developer 消息，模型通过代码调用 |
| 自动复核 | `approvals_reviewer: auto_review` | 被拒后只能走"实质更安全"的替代或向用户说明风险（`permissions_instructions.rs:42`） |

结论：**没有 plan/approval/auto 三选一式的模式枚举**；模式是"沙箱 × 审批 × 工具暴露方式"的组合，且几乎全部由模板与权限层实现，不靠模型自觉。

---

## 5. 提示词怎么落地

| 提示词要求 | 落地机制 | 位置 |
|---|---|---|
| 先读再改 | 无 ZCode 式 edit 前置读取闸门；靠 apply_patch 的精确匹配与脏工作树条款软约束 | `gpt_5_codex_prompt.md:7-20` |
| 不破坏用户改动 | 脏工作树四条款：不回滚他人改动、不 amend、发现异常立即停下询问 | `gpt_5_codex_prompt.md:13-19` |
| 不绕过审批 | 命令按 shell 控制符切成独立段逐段判定；重定向/替换/通配符不参与规则匹配 | `on_request.md:5-17` |
| 权限升级受控 | `prefix_rule` 禁用 `python3`/`python -` 等宽前缀，禁止给 `rm` 和 heredoc 发规则 | `on_request.md:30-40` |
| 不重复请求授权 | 正文声明"已授权就不要再问"，同时权限层决定能否执行 | `models.json` 模板 `# When to ask the user for permission` |
| 拒绝后不硬试 | 内容过滤被拒明确标为"不可重试、不可换格式绕过" | `model_messages.rs:62` |
| 工具副作用可观测 | PreToolUse/PostToolUse 钩子可拦截执行与结果 | `codex-rs/core/src/tools/registry.rs:143,1093-1119` |
| 长对话续接 | 压缩摘要作为前缀与 `summary_prefix` 一起回注 | `templates/compact/summary_prefix.md:1` |

---

## 6. 模型适配

- **为谁调优**：主要为 OpenAI Responses API 与 GPT-5/6 系模型；目录里每个 `slug` 自带 `instructions_template`、`default_reasoning_summary`、`supported_reasoning_levels`、`apply_patch_tool_type`、`tool_mode`、`supports_parallel_tool_calls`、`context_window`、`auto_compact_token_limit`（`models.json` 首模型片段）。
- **思考**：`reasoning_effort` 有预设表并可在会话中切换（`protocol/src/openai_models.rs:264-266,500`）；`supports_reasoning_summary_parameter` 决定是否下发 summary 参数（`:456-460`）。
- **工具格式**：`freeform` + Lark 文法的 apply_patch 是 GPT-5 专用自定义工具（`apply_patch_spec.rs:6-24`）；`use_responses_lite` 时工具走 `AdditionalTools` 前缀（`client.rs:1289-1295`）；子代理模型覆盖要求 `fork_turns: "none"`（`multi_agent_instructions.rs:9`）。
- **缓存**：`prompt_cache_key` 三策略 + Responses session-id 头（`client.rs:802-827,1394`）；同名内容用 id 绑定（`client.rs:1299-1301`）。
- **失败处理**：`responses_retry.rs` 与目录所学无关；正文明确"内容过滤不可重试"，避免同上下文空跑。

---

## 7. 踩空点：只搬提示词会缺什么

1. **模板跟着模型走**：把 `gpt_5_codex_prompt.md` 搬过来只拿到旧版短模板；真正生效的是 `models.json` 里按 slug 选择的 2 万字级模板，需要一套模型画像来选。
2. **权限是模板拼出来的**：沙箱/审批四段模板与 32KB 路径预算不搬，"先确认再执行"只会停在纸面。
3. **apply_patch 靠文法约束**：只有一句"可以编辑文件"的描述，没有 Lark 文法与 freeform 通道，模型会把补丁包成 JSON 或写坏格式。
4. **缓存键绑定会话**：`prompt_cache_key` 与 session-id 头决定前缀复用；不实现就会在每轮重发系统段时丢缓存。
5. **命令分段判定**：审批提示里讲"按管道切段"，实际判定在 exec-policy；只搬文案无法阻止批准 A 执行 B。
6. **Code Mode 命名空间**：部分模型把工具收进 `tools.*`，模型被告知"协作工具不在该命名空间"；不实现命名空间就会尝试在 shell 里调用协作工具。

---

## 8. Brain 草案（codex）

```ts
{
  id: 'codex',
  name: 'Codex 工程脑',
  description: '端到端负责、审批边界清晰、按模型加载身份模板的工程脑子。',
  bestFor: ['长任务续轮', '工具与命令密集任务', '多代理协作'],

  // 身份重写：保留"共享工作区、自己判断、端到端交付"的内核，去掉产品名
  identity: [
    '你与用户共享一个工作区，目标由用户设定，你是否完成由结果决定。',
    '保持自己的判断：有理由就不同意，有证据就改变看法；不奉承、不铺垫。',
    '用 commentary 通道给出简短进展，用最终通道给出自洽结论，不依赖用户读过程。',
    '对用户已授权的工作负责到底：检查、诊断、安全重试、修复可恢复失败。',
    '不要发明规则来拖延工作；技术上不必要的障碍应换方案而不是停下来问。',
  ].join('\n'),

  rules: [
    '端到端推进：未经用户暂停或改向，不以分析或半成品停下。',
    '不回滚他人改动：脏工作树里只处理自己的文件，不 amend，不做破坏性 git 操作。',
    '先完成已授权的工作再请求许可：让用户审批一个具体、可复核的结果。',
    '审批被拒或内容过滤拦截后，改走实质更安全的方案；不得换格式、拆字、编码绕过。',
    '报告只依据真实工具结果与本会话事实，最终答复里重复关键披露。',
    '工具选择优先专用工具；搜索用 rg 一类高速工具，单文件编辑用补丁工具。',
  ],

  tools: {
    descriptions: {
      shell: '用途：在持久 PTY 中执行命令并返回输出或会话 id，可用 workdir 与输出预算。何时不用：读写文件、列目录、搜内容用专用工具；删除前核对绝对路径，沙箱拒绝不得绕过。',
      apply_patch: '用途：按精确上下文编辑单个文本文件，补丁为自由格式而非 JSON。何时用：有明确 old/new 区段时。何时不用：整个文件重写、自动生成文件或跨库批量替换。',
      request_permissions: '用途：为单条命令申请额外的网络/文件系统权限并等待授予。何时用：沙箱内增量授权即可完成任务时。何时不用：能用已有规则或只读操作完成时；不要申请宽泛脚本前缀。',
    },
  },

  modes: [
    {
      id: 'guarded',
      name: '谨慎模式',
      prompt: '危险命令先说明并申请许可；优先沙箱内增量授权，完整提权是最后手段；被拒后改方案。',
    },
    {
      id: 'code-mode',
      name: '代码调用模式',
      prompt: '工具以 tools.* 命名空间提供，用代码调用；协作类工具不在该命名空间，只能作为直接工具调用。',
    },
  ],

  prompts: {
    compact: '生成交接摘要供后续模型续接：包含进度、关键决策、用户约束、待办与下一步；保留关键数据与引用，简洁结构化，不调用工具。',
  },

  flow: {
    tool: { resolveBeforePermission: true, parallel: true, maxConcurrent: 10 },
    compaction: { strategy: 'summary', failureLimit: 3 },
    approval: 'ask', // 需 Harness 提供沙箱分段判定与 prefix_rule 白名单才成立
  },

  modelProfile: {
    preferredModels: ['gpt-5*', 'gpt-6*'],
    reasoning: 'separate',
    toolCallFormat: 'openai',
    cache: 'prefix', // 以会话派生 key 绑定前缀
    emptyResponseRetry: false, // 内容过滤类拒绝明确不可重试
  },
}
```
