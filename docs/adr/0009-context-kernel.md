# ADR 0009：上下文压缩内核（acp-kernel / billion-context）

> 状态：已采纳（P3 原生集成，可选开关）
> 日期：2026-11-26
> 来源：https://github.com/ranxianglei/billion-context 、https://github.com/ranxianglei/acp-kernel

## 1. 它是什么

`billion-context` 是一个上下文压缩产品，内核是 `acp-kernel`：

- **模型写摘要，内核管调度**：内核从不调用模型；它决定何时压缩、压哪段、如何合并、如何检索。
- **3 层 LSM 压缩**：块分 young/old，旧块批量合并，不做年龄淘汰（避免丢记忆）。
- **增量、可逆**：`decompress` 能取回压缩块，`search` 能搜摘要。
- **prefix-cache 友好**：消息字节稳定、system 只追加变化、压缩后重建头部。
- **CCR（可选）**：大工具结果原样存起来，用占位符替代，模型按需检索，无损。
- **crush（可选）**：JSON/代码/日志的确定性压缩，压缩前先跑一遍，减少模型往返。

许可证：MIT + 一条附加署名（产品首页/文档/关于页注明使用了 acp-kernel 与 billion-context 并附链接）。纯内嵌、无用户界面时，随附文档声明即可。

## 2. 为什么不走 bili 代理

`billion-context` 支持通过 `bili` 代理或 URL 前缀接入任意客户端。WitCode 不采用这种方式，理由：

1. **我们要“原生走”**：上下文状态应该和 WitCode 的 session 一起存、一起恢复，而不是散落在代理进程里。
2. **Brain 需要控制压缩策略**：不同脑子（ZCode/DSH）对压缩的偏好不同，需要会话级开关，而不是全局代理。
3. **少一个进程**：代理会引入端口、证书、生命周期管理；直接依赖内核更干净。
4. **可观测**：压缩块、token 账本、检索记录要进 WitCode 的用量与 UI。

## 3. 集成架构

```
agent-loop
  ├─ beforeRequest(messages, sessionId)
  │    └─ context-manager
  │         ├─ acp-kernel.processTurn(...)  → 压缩后的 messages + nudge
  │         └─ session 里取/存 state + contentStore
  ├─ provider.stream(preparedMessages)
  ├─ 模型调用 compress 工具
  │    └─ context-manager.applyCompression(...)
  └─ 下一轮
```

新增包 `packages/context`：

```ts
export interface ContextManager {
  /** 每轮请求前调用：返回压缩后的消息与可选的 nudge 文本。 */
  beforeRequest(
    messages: ChatMessage[],
    sessionId: string,
    options?: { tokenCount?: number },
  ): Promise<{ messages: ChatMessage[]; nudge?: string }>;

  /** 模型调用 compress 时。 */
  applyCompression(sessionId: string, call: CompressCall): Promise<CompressResult>;

  /** 模型调用 decompress / search / status 时。 */
  decompress(sessionId: string, blockId: string): Promise<CompressionBlock | undefined>;
  search(sessionId: string, query: string): Promise<CompressionBlock[]>;
  status(sessionId: string): Promise<StatusReport>;

  /** 会话删除/重置。 */
  reset(sessionId: string): Promise<void>;
}
```

适配层职责：

- `ChatMessage` ↔ `CoreMessage` 转换（`text/tool-call/tool-result/reasoning`）。
- token 计数：默认用内核的 tokenizer；可注入 provider 的 usage 估算。
- nudge 渲染：内核给结构化决策，WitCode 渲染成一条 system/user 消息。
- 工具注册：`compress / decompress / search_context / acp_status` 四个工具，由 `packages/context` 提供 schema，注册进现有 `ToolService`。
- 状态持久化：每个 session 一份 `CompressionState` + `MessageContentStore`。

## 4. 存储

在 SQLite 里新增一张表（不改现有表）：

```sql
CREATE TABLE IF NOT EXISTS session_context (
  session_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  content_store_json TEXT,
  updated_at INTEGER NOT NULL
);
```

- 每次 `beforeRequest` / `applyCompression` 后写回。
- 会话删除时级联删除。
- 大小上限：content store 可能很大，需要 `WITCODE_CONTEXT_STORE_MAX_MB`（默认 64）与清理策略。

## 5. 开关

三层：

| 层级 | 配置 | 行为 |
|---|---|---|
| 全局 | `WITCODE_CONTEXT_COMPRESSION=off \| summary \| acp` | 默认 `summary`（现有 compact） |
| 会话 | session 元数据 `contextMode` | 可在新建/会话设置里覆盖 |
| Brain | `flow.compaction.strategy` | `summary` 或 `acp`；Brain 只建议，会话可覆盖 |

- `off`：不压缩，只靠模型窗口；超限直接报错。
- `summary`：沿用现有 compact（简单摘要）。
- `acp`：启用 acp-kernel，四个工具 + nudge + CCR（CCR 再单独开关）。

**默认不替用户做主**：新会话默认 `summary`；用户在设置里开启 `acp` 后，新会话才用。

## 6. UI

- 输入区：上下文占用环（已有点，扩展为分段：可见/已压缩/保留）。
- 消息流：压缩块显示为一张可展开的“已压缩 N 条消息”卡片，点击可看摘要，提供“解压”入口。
- 设置页新增 `上下文` tab：
  - 模式（off/summary/acp）
  - 压缩阈值、保留最近条数
  - CCR 开关、存储上限
  - 当前会话的压缩状态与命中率
- 命令（后续）：`/compress`、`/context`、`/decompress <block>`。

## 7. 与 Brain 的关系

- Brain 的 `flow.compaction.strategy` 只表达“这个脑子偏好哪种压缩”。
- 实际生效以会话/全局配置为准；UI 显示“Brain 建议 acp，当前会话使用 summary”。
- zcode Brain 默认 `summary`（贴近它的 compact）；dsh Brain 默认 `acp`（贴近它的增量/可重放）。

## 8. 许可证与署名

- 依赖 `acp-kernel`（MIT + 署名条款）。
- WitCode 的 `README.md` 与设置页“关于”必须写明：
  - 使用 acp-kernel / billion-context，附仓库链接。
- `THIRD-PARTY-NOTICES.md` 增加对应条目。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| acp-kernel 版本 0.0.x，API 可能变 | 锁版本；适配层隔离；升级跑全量测试 |
| 模型不支持工具调用 | `acp` 模式下要求 provider 支持 tools；否则降级 summary |
| token 计数偏差 | 允许注入 provider usage；偏差阈值告警 |
| 压缩摘要质量依赖模型 | 保留“解压/搜索”兜底；压缩块可人工查看 |
| content store 膨胀 | 上限 + 清理策略 + 按会话删除 |
| prefix cache 被破坏 | 消息字节稳定；nudge 只在需要时注入；测试命中率 |
| 首次配置复杂 | 默认 summary；acp 作为“高级开关”，设置页有说明 |

## 10. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P3.0 | `packages/context` 适配层 + `processTurn` 接入 agent-loop，仅 `summary` 模式 | 现有功能不回归 |
| P3.1 | `acp` 模式：四个工具 + nudge + 状态持久化 | 长对话下上下文不超限；压缩块可展开/解压 |
| P3.2 | UI：上下文 tab、占用环、压缩卡片 | 设置能开关；状态可见 |
| P3.3 | CCR 与 crush 开关 | 大工具结果可检索；日志/JSON 压缩生效 |
| P3.4 | 与 Brain 联动 + 命中率/用量统计 | Brain 建议与生效策略可见 |
