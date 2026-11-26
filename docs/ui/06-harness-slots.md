# Harness 插槽清单（Brain 落地前提）

> 输入：`03-zcode-prompt-system.md`、`04-dsh-prompt-system.md`、`acp-kernel` 设计
> 用途：明确 zcode / dsh Brain 要生效，Harness 必须先提供哪些能力
> 原则：**Brain 声明了但 Harness 没有的，一律降级并标注，不许假装生效。**

---

## 1. 三层插槽总览

| 层 | 插槽 | 现状 | 优先级 |
|---|---|---|---|
| L1 | system prompt 分段装配 | 无（当前一段字符串） | P0 |
| L1 | 公告只追加 delta | 无 | P1 |
| L1 | 工具描述覆盖 | 无 | P0 |
| L1 | 模式提示词（plan/guarded） | 无 | P1 |
| L1 | 记忆段落 | 有项目记忆，格式未标准化 | P1 |
| L2 | reasoning 解析与回填 | 无（只取 text/tool_calls） | P0 |
| L2 | 工具调用格式适配 | 只有 OpenAI 兼容 | P1 |
| L2 | cache 标记与前缀稳定 | 无 | P1 |
| L2 | 空回复/截断识别与重试 | 无 | P0 |
| L2 | 不可重试错误（敏感/内容过滤） | 无 | P1 |
| L3 | 工具前置归一化（resolveInput） | 无（直接执行） | P0 |
| L3 | 读后写校验 | 无 | P0 |
| L3 | tool_result 必回填 | 部分（工具失败也回填） | P0 |
| L3 | plan 只读（权限层） | 无 | P1 |
| L3 | 压缩策略（summary / acp） | 只有会话截断，无压缩 | P0 |
| L3 | 写后验证 | 无 | P1 |
| L3 | 并行调度 | 无（串行） | P2 |
| L3 | 审批 fail-closed | 无（直接执行） | P1 |

---

## 2. L1 提示词插槽

### 2.1 分段装配（P0）

- **要什么**：`identity`（稳定）+ `rules` + `context sections`（项目/记忆/git）+ `dynamic`（环境/模型/日期）。
- **现状**：`SYSTEM_PROMPT` 一段字符串 + 项目记忆拼在后面。
- **改造**：`buildSystemPrompt(brain, context)` 返回 `{ stable: string[]; dynamic: string[] }`。
- **依赖**：Brain 契约。

### 2.2 公告只追加（P1）

- **要什么**：已发送的公告不改写，新公告追加 delta，保护前缀缓存。
- **现状**：无公告机制。
- **改造**：`ContextAnnouncer`：记录已发送的 section 指纹，只追加变化。
- **依赖**：缓存统计（L2）。

### 2.3 工具描述覆盖（P0）

- **要什么**：Brain 可以覆盖某个工具的描述（“何时用/何时不用”）。
- **现状**：描述写死在工具定义里。
- **改造**：`ToolService.list()` 返回前应用 `brain.tools.descriptions`。
- **依赖**：无。

### 2.4 模式提示词（P1）

- **要什么**：plan / guarded / yolo 三套提示词与约束。
- **现状**：无模式。
- **改造**：`BrainMode` + 会话级 mode；plan 模式要求权限层只读（见 L3）。
- **依赖**：权限层。

### 2.5 记忆段落（P1）

- **要什么**：标准化的项目记忆格式（frontmatter + 索引 + 条目）。
- **现状**：`.witcode/memory.md`，自由文本。
- **改造**：定义格式；读取时只注入索引与最近条目；写入去重。
- **依赖**：无。

---

## 3. L2 模型适配插槽

### 3.1 reasoning 解析与回填（P0）

- **要什么**：
  - 解析 `reasoning_content` / `thinking` / `reasoning` 增量；
  - 存进消息（`reasoning` content block）；
  - 后续请求按协议回填（Anthropic/GLM 需要 signature）；
  - 无签名的 thinking block 要丢弃，避免整条请求被拒。
- **现状**：`openai.ts` 只处理 `content` 与 `tool_calls`。
- **改造**：`parseEventStream` 增加 reasoning 分支；`ChatMessage` 增加 `reasoning`；序列化时按 provider 回填。
- **依赖**：provider 协议识别。

### 3.2 工具调用格式适配（P1）

- **要什么**：
  - OpenAI：`function` + `tool_call_id`；
  - Anthropic：`tool_use` + `tool_result`，`input` 是对象；
  - GLM：内置工具 `server_tool_use` 要改写，防止模型照渲染文字假装调用。
- **现状**：只有 OpenAI 兼容。
- **改造**：provider 增加 `protocol: 'openai' | 'anthropic' | 'glm'`；序列化/反序列化分支。
- **依赖**：Brain 的 `modelProfile.toolCallFormat`。

### 3.3 cache 标记与前缀稳定（P1）

- **要什么**：
  - Anthropic：`cache_control` 标在 system 段与工具定义；
  - DeepSeek：前缀字节稳定即可命中；
  - 统计 `cache_read/creation` tokens。
- **现状**：无。
- **改造**：system 分段 + cache 标记；usage 解析增加 cache 字段。
- **依赖**：分段装配。

### 3.4 空回复/截断识别与重试（P0）

- **要什么**：
  - 空内容 + 无工具 + 非 stop → 重试一次；
  - 截断（max_tokens）→ 保留部分，标记；
  - `sensitive` / content_filter → **不重试**。
- **现状**：无。
- **改造**：`failure-classifier`：错误码 + 可重试标记；loop 里有限重试。
- **依赖**：无。

### 3.5 不可重试错误（P1）

- **要什么**：敏感内容、内容过滤、鉴权失败不重试，直接报给用户。
- **现状**：所有错误都直接抛。
- **改造**：同 3.4，分类表里标 `retryable: false`。
- **依赖**：无。

---

## 4. L3 流程插槽

### 4.1 工具前置归一化（P0）

- **要什么**：模型入参先归一化成执行事实，再判权限；杜绝“批准 A 执行 B”。
- **现状**：`tools.run(name, input)` 直接执行。
- **改造**：`ToolDefinition.resolveInput?` + `prepareApproval?`；执行前统一调用。
- **依赖**：无。

### 4.2 读后写校验（P0）

- **要什么**：`write_file` / `edit` 前必须读过目标文件；未读返回明确错误。
- **现状**：无。
- **改造**：`ReadStateTracker`：记录本次会话读过的路径与 mtime；写工具检查。
- **依赖**：无。

### 4.3 tool_result 必回填（P0）

- **要什么**：每个 `tool_use` 必须有配对的 `tool_result`，失败也要回填错误结果。
- **现状**：agent-loop 失败时回填 `ERROR: ...`，基本满足。
- **改造**：校验配对；缺结果时补 `TOOL_OUTCOME_UNKNOWN`。
- **依赖**：无。

### 4.4 plan 只读（P1）

- **要什么**：plan 模式下写工具被权限层拒绝，不是靠提示词。
- **现状**：无模式。
- **改造**：权限层加 `readOnly` 判定；plan 模式启用。
- **依赖**：模式。

### 4.5 压缩策略（P0）

- **要什么**：`off / summary / acp` 三档；状态随会话持久化。
- **现状**：无压缩，只有消息全量发送。
- **改造**：`packages/context` + `session_context` 表；`beforeRequest` 钩子。
- **依赖**：acp-kernel（P3.0 可先只做 summary）。

### 4.6 写后验证（P1）

- **要什么**：改完文件后自动跑 typecheck/test，失败把错误带回下一轮。
- **现状**：无。
- **改造**：`verify.afterWrite` 策略；工具后置钩子。
- **依赖**：Brain 的 `flow.verify`。

### 4.7 并行调度（P2）

- **要什么**：只读工具并行、破坏性串行、上限可配。
- **现状**：串行。
- **改造**：拓扑排序 + 分组 + 并发池。
- **依赖**：工具元数据（readOnly/destructive）。

### 4.8 审批 fail-closed（P1）

- **要什么**：需要审批但没人应答 → 拒绝，不默认放行。
- **现状**：无审批。
- **改造**：`approval` 服务 + 前端确认；默认拒绝。
- **依赖**：UI。

---

## 5. 两个 Brain 的依赖矩阵

| 插槽 | native | zcode | dsh |
|---|---|---|---|
| 分段装配 | ✅ | ✅ | ✅ |
| 工具描述覆盖 | ✅ | ✅ | ✅ |
| 模式提示词 | — | ✅ plan | ✅ plan/goal |
| reasoning | — | ✅ GLM thinking | ✅ DeepSeek reasoning |
| 工具格式 | OpenAI | GLM/Anthropic | Anthropic 子集 |
| cache | — | ✅ ephemeral | ✅ 前缀 |
| 空回复重试 | ✅ | ✅ | ✅ |
| 工具前置 | — | ✅ | ✅ |
| 读后写 | — | ✅ | — |
| 压缩 | summary | summary | acp |
| 写后验证 | — | ✅ | — |
| 审批 | — | ✅ | ✅ |

---

## 6. 实现顺序（建议）

1. **P0 一批**：分段装配、工具描述覆盖、工具前置、读后写、压缩（summary）、空回复重试。
2. **P0 二批**：reasoning 解析、tool_result 配对校验。
3. **P1**：模式、plan 只读、审批、缓存标记、写后验证、acp 压缩。
4. **P2**：工具格式适配（Anthropic/GLM）、并行调度。

---

## 7. 踩空点（来自 03/04 的原文总结）

只搬提示词、不搬流程，会在这些地方落空：

1. 多段 system 被兼容性合并 → cache 锚点错位。
2. reasoning 签名丢失 → 后续请求全失败。
3. 内置工具的渲染文字 → 模型假装调用工具。
4. 空回复/敏感终止误判 → 反复空跑。
5. tool_result 不配对 → 协议拒绝。
6. “先读再改”只写在提示词 → 模型直接写。
7. “计划只读”没有权限层 → 提示词说只读，工具照样写。
8. 压缩只做截断 → 长会话失忆。
