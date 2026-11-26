# ADR 0008：Brain 有三层——提示词、流程、模型适配

> 状态：已采纳
> 日期：2026-11-26
> 背景：用户指出，“脑子”不只是提示词；参照的 Harness 都针对自家模型做过调优，真正的差异在流程处理与提示词落地方式。

## 1. 问题

如果 Brain 只打包提示词，会出现三种“踩空”：

1. **提示词写了，流程不接**：比如写“先读再改”，但没有工具前置校验，模型照样直接写。
2. **模型不认这套写法**：GLM 的思考、DeepSeek 的 reasoning、Anthropic 的 cache 标记，各有各的协议；用 OpenAI 兼容一把梭，提示词效果会打折。
3. **失败没人兜**：空回复、截断、工具参数坏了，提示词救不了，需要流程层的分类与重试。

所以 Brain 必须分三层：

```
Brain
├── L1 提示词层：身份、规则、模式、上下文、子提示词
├── L2 模型适配层：请求构造、思考解析、工具格式、缓存、空响应重试
└── L3 流程层：工具前置、验证、压缩、审批、重试策略
```

L1 可以独立生效；L2/L3 需要 Harness 提供对应插槽。**Brain 声明的能力，Harness 必须有实现，否则降级并标注。**

## 2. 三层各自装什么

### L1 提示词层

- identity：你是谁、怎么说话。
- rules：硬规则（先读再改、不编造、必须验证、风险提示）。
- modes：plan / yolo / guarded 的提示词与约束。
- context：项目记忆、git、环境、动态公告的顺序。
- prompts：compact / plan / review / subagent。

### L2 模型适配层

| 项 | 说明 | 例子 |
|---|---|---|
| preferredModels | 这套脑子为哪些模型调过 | GLM-4.x / DeepSeek-V3 |
| reasoning | 思考放哪、怎么回填 | Anthropic thinking block / DeepSeek reasoning_content |
| toolCallFormat | 工具调用协议差异 | OpenAI functions / Anthropic tool_use / GLM |
| cache | 缓存标记与提示词排序 | Anthropic cache_control / DeepSeek prefix cache |
| emptyResponseRetry | 空回复/截断的识别与重试 | ZCode 的 empty-completion-retry |

### L3 流程层

| 项 | 说明 | ZCode 做法 | DSH 做法 |
|---|---|---|---|
| 工具前置归一化 | 批准 A 不能执行 B | `resolveInput` 在权限之前 | 工具三段 waterfall |
| 并行调度 | 只读工具并行、破坏性串行 | 拓扑排序 + 分组 + 上限 10 | executionMode 分类 + 有界池 |
| 写后验证 | 改完必须检查 | 工具结果回填 + 测试 | 工具 waterfall + guard |
| 压缩策略 | 摘要 vs 日志替换 | 阈值 + 熔断（失败≤3） | surface replace + 可重放 |
| 审批 | 失败闭合还是放行 | 多级顺序（plan/ask/guarded/yolo） | approval fail-closed |
| 重试 | 分类后有限重试 | failure-classifier + retryBudget | request-error waterfall |

## 3. 提示词怎么“不踩空”

核心原则：**能用流程保证的，不要只靠提示词。**

| 提示词里的要求 | 靠什么落地 |
|---|---|
| 先读再改 | 工具前置校验：写之前必须有过 read；或 plan 模式只读 |
| 不编造 | 工具结果作为唯一事实源，强制回填；没有结果就报“未确认” |
| 小步验证 | 每轮工具后跑 typecheck/test；失败则下一轮带错误上下文 |
| 不破坏风格 | 写前读同目录文件；或提供项目规范段 + 风格检查 |
| 危险操作先问 | 权限层硬拦截，不依赖模型自觉 |
| 长任务不忘事 | todo 状态 + compact 摘要 + 回合轨 |

**Brain 的 rules 与 Harness 的 hooks 要成对出现。** 只有 rules 没有 hooks，就是海报；只有 hooks 没有 rules，模型不知道为什么被拦。

## 4. 对 ZCode / DSH 的具体对照（基于已有研究）

### ZCode（为 GLM 调优）

- 请求：AI SDK + `openai/anthropic/openai-compatible` 分类；`model-option-map` 用 CEL 把 `reasoningLevel/maxOutputTokens` 映射成 provider 原始 body patch。
- 流程：Turn 相位状态机；工具 `resolveInput` 前置；动态公告“先持久化再提交”；compact 有失败熔断；权限多级顺序。
- 提示词：分节 + stable/dynamic 缓存锚点；工具描述写“何时用/何时不用”。
- 待补：GLM 的 thinking 开关、工具格式、缓存命中的具体做法（研究员 C 补）。

### DSH（为 DeepSeek 调优）

- 请求：`dsh_*` wire extensions、attribution headers、usage before finish、session log at-least-once。
- 流程：session 追加日志 + surface replace；`prepareCall` 代次绑定；工具三段 waterfall；approval fail-closed；spill。
- 提示词：plan/goal 是软指导，权限是硬约束，两者分离。
- 待补：DeepSeek reasoning/cache/重试的具体做法（研究员 D 补）。

## 5. Brain 契约扩展

在 ADR 0007 的 `BrainDefinition` 上增加两层：

```ts
export interface BrainFlow {
  tool?: {
    resolveBeforePermission?: boolean;
    parallel?: boolean;
    maxConcurrent?: number;
    waterfall?: boolean;
  };
  verify?: {
    afterWrite?: 'none' | 'typecheck' | 'test';
    retryLimit?: number;
  };
  compaction?: {
    strategy?: 'summary' | 'surface-replace';
    failureLimit?: number;
  };
  approval?: 'fail-closed' | 'ask' | 'yolo';
}

export interface BrainModelProfile {
  preferredModels?: string[];
  reasoning?: 'separate' | 'inline' | 'none';
  toolCallFormat?: 'openai' | 'anthropic' | 'glm' | 'deepseek';
  cache?: 'prefix' | 'none';
  emptyResponseRetry?: boolean;
}
```

Brain 增加两个字段：`flow?: BrainFlow`、`modelProfile?: BrainModelProfile`。

## 6. 能力分级与降级

| 等级 | 内容 | Harness 要求 |
|---|---|---|
| L1 | 只有提示词 | 无（现有 loop 即可） |
| L2 | 提示词 + 模型适配 | 模型适配器支持 reasoning/cache/tool 格式 |
| L3 | 提示词 + 模型适配 + 流程策略 | loop 支持插槽式工具前置、验证、压缩策略 |

- 加载 Brain 时检查 Harness 能力：缺失的 flow 项标为“未生效”，UI 显示。
- 不因为缺少 L3 就拒绝加载；L1 仍然可用，但要在设置页写明“这套脑子的部分能力当前不可用”。

## 7. 落地顺序

1. **L1 先行**：Brain 契约 + native brain + zcode/dsh 的提示词包。
2. **L2 跟上**：模型适配层（reasoning 解析、空响应重试、cache 标记）。
3. **L3 逐步**：工具前置校验、写后验证、压缩策略；每项单独 ADR/测试。

## 8. 不采用

- **不把整个 ZCode/DSH 的 loop 复制过来**：它们的流程与自家模型、自家事件模型绑定，搬过来会带着一堆不需要的耦合。
- **不假装 L3 已经具备**：Harness 没实现的策略，Brain 声明了也不生效，必须显式标注。
