# ADR 0007：Brain 插件——把别的 Agent 的“脑子”插进 WitCode 的 Harness

> 状态：已采纳（修正版，取代“外部 Agent 进程适配器”的旧方案）
> 日期：2026-11-26

## 背景与修正

最初的理解是：把 ZCode / DSH 作为外部进程，通过协议接入 WitCode。

用户澄清：**不是接入它们本身，而是把它们的大脑扒下来，嵌入 WitCode 的核心**。这个“嵌入”就是插件插入，而且是可选的——用户为本次会话选择用谁的脑子。

因此：

- WitCode **不启动** ZCode 进程，也不要求 DSH 安装；
- WitCode 自己执行工作循环、调用模型、执行工具；
- ZCode / DSH 贡献的是**行为方式**：提示词、工具策略、模式、上下文组织、压缩与复盘方式；
- 这些行为方式被打包成 **Brain 插件**，会话级可选。

一句话：**Harness 是身体，Brain 是脑子。身体只有一套，脑子可以换。**

## 决策

### 1. 新增 Brain 契约（放在 `packages/protocol`）

```ts
export interface BrainDefinition {
  id: string;
  name: string;
  description: string;
  /** 这个脑子适合什么任务，用于界面提示 */
  bestFor: string[];

  /** 人格与工作法（system prompt 的稳定段） */
  identity: string;
  /** 硬规则：先读再改、不编造、验证、交付… */
  rules: string[];

  /** 工具策略 */
  tools: {
    enabled?: string[];   // 不填=全部
    disabled?: string[];
    descriptions?: Record<string, string>; // 覆盖工具描述
  };

  /** 模式：plan / yolo / guarded / 自定义 */
  modes?: BrainMode[];

  /** 上下文组织 */
  context?: BrainContext;

  /** 子提示词 */
  prompts?: BrainPrompts;

  /** 循环策略 */
  loop?: BrainLoop;
}

export interface BrainMode {
  id: string;
  name: string;
  prompt: string;
  readOnly?: boolean;
  requireApproval?: boolean;
}

export interface BrainContext {
  projectMemory?: boolean;
  git?: boolean;
  environment?: boolean;
  /** 额外固定段落，按顺序拼进 system prompt */
  sections?: Array<{ title: string; content: string; stable?: boolean }>;
}

export interface BrainPrompts {
  compact?: string;
  plan?: string;
  review?: string;
  subagent?: string;
}

export interface BrainLoop {
  maxSteps?: number;
  verifyAfterWrite?: boolean;
  askBeforeWrite?: boolean;
}
```

### 2. Harness 的职责不变，但改为“读 Brain 执行”

现有 `runAgentLoop` 改为接收 `brain`：

- 组装 system prompt：`identity + rules + context.sections + 项目记忆 + 环境`；
- 过滤工具：按 `tools.enabled/disabled`；
- 覆盖描述：按 `tools.descriptions`；
- 模式：按 `modes` 注入提示词与约束；
- 压缩：用 `prompts.compact`；
- 步数/验证：按 `loop`。

**Harness 不关心脑子的来源**：内置的、扒来的、第三方写的，都是同一个契约。

### 3. Brain 是插件的一种

插件类型扩展：`brain | tool | model | ui | theme`。

一个 Brain 插件的最小形态：

```
brains/zcode/
├── brain.json      # 元信息：id/name/bestFor
├── identity.md     # 人格与工作法
├── rules.md        # 硬规则
├── modes/          # plan.md / guarded.md
├── prompts/        # compact.md / review.md / subagent.md
└── tools.json      # 启用/禁用/描述覆盖
```

内置 Brain：

| id | 来源 | 擅长 |
|---|---|---|
| `native` | WitCode 自己 | 通用、轻量、默认 |
| `zcode` | 扒 ZCode 的提示词与工具纪律 | 工程实现、小步验证、工具使用规范 |
| `dsh` | 扒 DSH 的工作法 | 架构规划、任务拆解、多 Agent 协作 |
| `claude` | 扒 Claude Code 的提示词（后续） | 长上下文、代码审查 |
| `codex` | 扒 Codex（后续） | 终端操作、脚本 |

### 4. 会话级选择

- 新建会话时选 Brain；会话内可切换（切换后从下一轮生效）。
- 顶栏显示：`Brain 选择器 + 模型选择器`。
- 会话列表标记每条会话用的 Brain。
- 设置页 `Brains` tab：查看内置、启用/禁用、查看它适合什么、导入第三方 Brain。

### 5. 扒大脑的方法

对每个参照 Agent，产出一份“Brain 包”：

1. **人格与工作法**：system prompt 的稳定段（身份、原则、交付标准）。
2. **硬规则**：先读再改、不编造、验证、风险提示。
3. **工具纪律**：哪些工具、描述怎么写、什么时候用/不用。
4. **模式**：plan / yolo / guarded 的提示词与约束。
5. **上下文**：项目记忆、git、环境、动态公告的顺序与内容。
6. **压缩/复盘/子代理**：子提示词。
7. **循环策略**：步数、验证、提问时机。

**只扒“行为”，不扒“实现”**：不复制代码，不依赖它的进程，不要求它的运行时。

### 6. 边界与降级

- Brain 能覆盖 80% 的“行为差异”；ZCode 的 Workflow 引擎、CUA、插件市场等“能力差异”仍需 WitCode 自己实现，或后续以工具/插件补充。
- 如果某个 Brain 依赖 WitCode 没有的工具，加载时降级：禁用缺失工具，并在 UI 标注“该 Brain 的部分能力不可用”。
- Brain 不能绕过 WitCode 的权限与会话模型；它只能影响“怎么想、怎么用工具”，不能改变“工具怎么执行”。

## 后果

正面：

- 不需要逆向外部 Agent 的私有协议，不维护外部进程。
- 所有 Brain 共享 WitCode 的工具、模型管家、会话、界面、用量统计。
- 用户可按任务选脑子，切换成本低。
- 第三方可以写 Brain 插件，生态门槛低（主要是提示词与配置）。

负面：

- 无法 100% 复刻外部 Agent 的特有能力（workflow/CUA/专有工具）。
- Brain 的质量取决于“扒”的深度；提示词是软约束，稳定性不如代码。
- 需要持续跟进参照 Agent 的提示词更新。

## 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| P3.0 | Brain 契约 + `native` Brain + 会话/顶栏选择器 | 现有功能不回归，能切换 native 与默认 |
| P3.1 | `zcode` Brain（基于 03 号研究报告） | 同一任务下，行为明显更“ZCode”：先读再改、小步验证、工具纪律 |
| P3.2 | `dsh` Brain（基于 04 号研究报告） | 同一任务下，行为更“DSH”：先规划、拆任务、复盘 |
| P3.3 | Brains 设置页 + 能力降级提示 | 能看到每个 Brain 的擅长与缺失能力 |
| P3.4 | 第三方 Brain 导入 + 插件市场 | 用户能装一个外部 Brain 包并选用 |

## 待验证

1. ZCode 的提示词分节能否完整提炼（03 号研究进行中）。
2. DSH 的“脑子”到底由哪些提示词构成（04 号研究待启动）。
3. 同一任务下，Brain 切换带来的行为差异是否足够明显（需要 A/B 评测）。
4. Brain 与工具集的耦合：某些 Brain 依赖特定工具描述，工具缺失时如何优雅降级。
