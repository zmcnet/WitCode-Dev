# ADR 0011：协作——伙伴、子智能体、工作流

> 状态：已采纳
> 日期：2026-11-26
> 背景：用户定义三个协作功能。主智能体是用户对话的本体；Coding 模式下可以找“脑子”当伙伴一起开发，也可以把任务派给子智能体；工作流负责编排。

## 1. 三层模型

| 角色 | 是什么 | 和主智能体的关系 | 上下文 | 能否动手 |
|---|---|---|---|---|
| **主智能体** | 用户正在对话的 Agent | 本体 | 完整会话 | 能（按权限模式） |
| **伙伴 Partner** | 另一个脑子的视角 | 平级协作，像同事 | 任务摘要 + 被问的问题 | **不能**，只给意见 |
| **子智能体 Subagent** | 任务执行者 | 下级派发，像外包 | 独立会话，只给任务 | 能（继承权限） |
| **工作流 Workflow** | 编排层 | 导演 | 每步独立 | 按步骤类型 |

设计要点：

- **伙伴是“另一个脑子”，不是手下。** 它给建议、审查、方案，不动手。
- **子智能体是“手脚”，不是脑子。** 它独立干完一件事，把结果交回来。
- **工作流是“剧本”。** 定义什么时候问伙伴、什么时候派子智能体、什么时候主智能体自己上。

## 2. 工具契约

主智能体通过三个工具调用协作能力：

```ts
// 伙伴：只读咨询
interface PartnerConsultInput {
  brainId: string;       // 用哪个脑子当伙伴
  question: string;      // 问什么
  includeSummary?: boolean; // 是否带上当前任务摘要（默认 true）
}
interface PartnerConsultOutput {
  brainId: string;
  answer: string;
}

// 子智能体：任务派发
interface SubagentTaskInput {
  task: string;
  brainId?: string;      // 用哪个脑子执行（默认继承主会话）
  tools?: string[];      // 限制工具集（可选）
}
interface SubagentTaskOutput {
  id: string;
  status: 'done' | 'failed' | 'cancelled';
  output: string;
  filesChanged?: string[];
}

// 工作流：编排
interface WorkflowRunInput {
  workflowId: string;
  input?: string;
}
```

三个工具都注册进 `ToolService`，由主智能体的 loop 调用。

## 3. 上下文策略

### 伙伴

- system：伙伴 Brain 的 identity + rules。
- messages：**主会话的完整历史 + 问题**（用户要求共享全部内容）。
- **仍然只读**：伙伴能看到全部上下文，但只能建议，不能写、不能跑命令。
- 输出：一段文本，回填给主智能体作为 tool result。

### 子智能体（照 ZCode 设计）

- **独立 session**：每个子智能体一个新会话，标题带 `子任务[L{depth}]` 前缀标记层级。
- **独立 system prompt**：不继承主对话历史，只给「你是被派发的子智能体，只做这一件事：<task>」+ brain 的 identity/rules。
- **工具 allowlist**：可指定工具子集；不传则用主会话的 ToolService 全量。
- **权限继承**：透传主会话 Security，不能提权。
- **结果回填**：最终 assistant 消息写入子 session，返回 output + filesChanged。
- **前台等待**：先只做前台（await 完成后返回），不做后台任务。
- **可套娃 3 层**：`ctx.depth` 0 是主，1–3 是子；超过 3 直接拒绝。

### 工作流

- 每一步有自己的步骤类型：`main`（主智能体执行）/ `partner`（咨询）/ `subagent`（派发）/ `tool`（直接调用工具）。
- 步骤间通过 `input` / `output` 传递。
- 条件：`when` 表达式（先做简单字符串匹配，不做完整表达式引擎）。

## 4. 权限与安全

- 伙伴：只读，不能写、不能跑命令；所有调用记审计。
- 子智能体：继承主会话权限模式，不能提权；不能再派子智能体。
- 工作流：每步继承主会话权限；`subagent` 步骤同样 depth 1。
- 递归保护：子智能体可再派，但最多 3 层（`ctx.depth` 限制）；`consult_partner` 任意层可用（只读）。
- 成本保护：单次会话的伙伴咨询最多 5 次、子智能体最多 3 个（可配），防止 token 爆炸。

## 5. 工作流格式

放 `.witcode/workflows/<id>.yaml`：

```yaml
id: feature
name: 功能开发
description: 先审查方案，再实现，最后补测试
steps:
  - id: review
    type: partner
    brain: profession
    prompt: 审查这个方案的风险：{{input}}
  - id: implement
    type: main
    prompt: 按方案实现，参考伙伴意见：{{steps.review.output}}
  - id: test
    type: subagent
    brain: coding
    task: 为本次改动补测试并运行
when: "input contains '功能'"
```

先支持：顺序执行、`{{input}}` / `{{steps.<id>.output}}` 变量、`when` 简单匹配。不做图编辑器、不做并行分支。

## 6. UI

- **伙伴回复**：折叠卡片，标题「伙伴 · Profession」，展开看完整回答。
- **子智能体**：任务卡片，状态（运行中/完成/失败）、耗时、输出摘要、变更文件；可展开。
- **工作流**：步骤列表 + 当前步骤高亮 + 每步状态；可展开每步输出。
- 顶栏/状态栏：显示当前会话正在运行的伙伴/子智能体数量。

## 7. 与 Brain 的关系

- 伙伴的“脑子”就是 Brain；默认允许所有官方脑（coding/standard/profession）作为伙伴。
- Brain 可通过 `execution.collaboration.partners?: string[]` 限制可用伙伴；不声明则允许全部。
- 子智能体默认继承主会话 Brain；可以指定另一个 Brain（如主 Coding、子 Profession 做测试）。

## 8. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P4.1 | PartnerService + `consult_partner` 工具 + 只读约束 | 主智能体能问伙伴并拿到意见，伙伴不能写文件 |
| P4.2 | SubagentService + `spawn_subagent` 工具 + 独立 session + depth 1 | 子智能体独立完成任务，结果回填，不能再派 |
| P4.3 | ~~工作流~~：用户要求先不上，推迟 | — |
| P4.4 | UI：伙伴卡片、子智能体卡片 | 两者在消息流里可见 |

## 9. 风险

| 风险 | 缓解 |
|---|---|
| Token 成本爆炸 | 次数上限 + 伙伴只读 + 子智能体独立上下文 |
| 伙伴污染主对话 | 伙伴只拿摘要，不拿完整历史 |
| 子智能体递归 | depth 3 上限，超过直接拒绝 |
| 子智能体权限绕过 | 继承主会话模式；不能提权 |
| 工作流格式膨胀 | 先只做顺序 + 简单条件，不做 DSL |
