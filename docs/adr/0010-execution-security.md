# ADR 0010：执行框架与安全（照搬 ZCode 的逻辑，补它没有的沙盒）

> 状态：已采纳
> 日期：2026-11-26
> 背景：Brain 解决了“怎么想”，但执行框架与安全仍是简化版。用户要求把 ZCode 的执行框架搬过来，并内置沙盒与安全考虑。

## 1. 先划清边界

ZCode 的 `NOTICE.md` 明确写了两件事：

- 共享 Agent 执行适配器**不提供默认的操作系统沙箱**；
- 权限规则、工作区信任、路径检查**不是**系统级隔离。

所以“照搬 ZCode”能拿到的是**软安全**：

| 层 | ZCode 有 | ZCode 没有 |
|---|---|---|
| 权限判定 | ✅ 多级顺序、模式、会话/项目规则 | — |
| 工具契约 | ✅ readOnly/destructive/concurrentSafe、resolveInput、prepareApproval | — |
| 路径策略 | ✅ 归一化、workspace 边界、读写校验 | realpath 级符号链接防护不完整 |
| 命令执行 | ✅ 超时、输出截断、进程树 | 环境变量白名单不完整 |
| 工作区信任 | ✅ Hook/MCP 的 trust 记录 | 只覆盖 Hook/MCP，不覆盖工具 |
| OS 沙盒 | ❌ | 内核隔离（Landlock/bubblewrap/Job Object） |

**决策**：软安全照搬 ZCode 并把缺口补上；硬沙盒作为独立层预留接口，P4 实现。

## 2. 四个权限模式（用户级总开关）

| 模式 | 写工具 | 命令 | 插件工具 | 说明 |
|---|---|---|---|---|
| **只读** | deny | deny | deny | 只能读、搜、看；plan 默认用它 |
| **普通** | 按风险 ask | 按风险 ask | ask | 只放行框架原生工具；危险动作先审 |
| **自主** | AI 自行判断 | AI 自行判断 | AI 自行判断 | 仅硬黑名单拦截；全程审计 |
| **全部** | allow | allow | allow | 不拦截；仍记录审计，硬黑名单也放行 |

规则：

- 模式是**用户级选择**，覆盖 Brain 的建议；Brain 只能声明 `preferredMode`。
- 硬黑名单（`rm -rf /`、`format`、`diskpart`、`mkfs`、`dd of=/dev/`、`curl | sh`、`powershell -enc`）在只读/普通/自主下拦截；`全部`放行但写审计。
- **自主模式不是“没有安全”**：AI 自己判断要不要问，Harness 只做审计、硬黑名单、路径边界。它比 `普通` 少一层硬拦截，但比 `全部` 多一层审计与记录。
- 每次工具调用记录：模式、风险等级、决策（allow/ask/deny）、理由、谁做的决定（规则/用户/AI）。

## 3. 执行框架跟大脑走

**执行框架不是 Harness 唯一的一套**，而是每个 Brain 自带（或适配过）的。Brain 增加 `execution`：

```ts
interface BrainExecution {
  /** 这个脑子适配过的执行框架；Harness 提供策略库，Brain 选组合。 */
  profile?: 'native' | 'zcode' | 'dsh' | 'opencode' | 'codex' | ...;
  permission?: {
    preferredMode?: 'read-only' | 'normal' | 'autonomous' | 'full';
    rules?: PermissionRule[];
  };
  tool?: {
    contract?: 'simple' | 'zcode' | 'dsh';
    enabled?: string[];
    disabled?: string[];
    descriptions?: Record<string, string>;
  };
  scheduler?: {
    parallel?: boolean;
    maxConcurrent?: number;
  };
  verify?: {
    afterWrite?: 'none' | 'typecheck' | 'test';
  };
  compaction?: {
    strategy?: 'off' | 'summary' | 'acp';
  };
  approval?: 'fail-closed' | 'ask' | 'auto';
}
```

切换 Brain = **换整套执行配置**：工具契约、调度、验证、压缩、审批都跟着换。

为什么不做“大杂烩一套”：

- ZCode 的权限顺序（plan → destructive → 项目规则 → 会话 → 默认）与 DSH 的 fail-closed 语义会互相打架；
- 12 个脑子的工具契约、调度习惯、压缩策略各不相同，强行统一会变成四不像；
- 策略库 + 组合的方式可测试、可解释，也能让第三方 Brain 自带执行配置。

Harness 提供的是**策略库**（每种策略一个实现），不是一套固定流程：

| 策略 | 可选实现 |
|---|---|
| 权限模式 | read-only / normal / autonomous / full |
| 工具契约 | simple / zcode（resolveInput+prepareApproval）/ dsh（三段 waterfall） |
| 调度 | serial / parallel（拓扑+上限） |
| 验证 | none / typecheck / test |
| 压缩 | off / summary / acp |
| 审批 | fail-closed / ask / auto |

## 4. 分层设计

```
┌─────────────────────────────────────────┐
│ 确认层 Approval（UI 弹窗，fail-closed）  │
├─────────────────────────────────────────┤
│ 权限层 Permission（allow/ask/deny + 模式）│
├─────────────────────────────────────────┤
│ 路径层 PathPolicy（workspace 边界/敏感）  │
├─────────────────────────────────────────┤
│ 命令层 CommandPolicy（危险模式/env/超时） │
├─────────────────────────────────────────┤
│ 执行层 Executor（spawn/截断/进程树）      │
├─────────────────────────────────────────┤
│ 硬沙盒 Sandbox（预留：Job Object 等）     │
└─────────────────────────────────────────┘
```

### 4.1 权限层

照搬 ZCode 的判定顺序，简化为 WitCode 版本：

1. **模式闸门**：`plan` 模式 → 写工具直接 deny（硬拦截，不靠提示词）。
2. **工具元数据**：`destructive` 工具在非 `yolo` 下必须 ask。
3. **项目规则 deny**：命中即拒绝。
4. **项目规则 allow**：命中即放行（仅对只读或幂等工具）。
5. **会话规则**：本次会话记住的 allow/deny。
6. **alwaysAsk 清单**：命中即 ask。
7. **默认策略**：`guarded` → ask；`yolo` → allow（但危险命令仍走命令层）；`build` → ask。

规则匹配维度：工具名、路径前缀、命令前缀、参数正则。规则存储：项目 `.witcode/permissions.json` + 用户级 `~/.witcode/permissions.json`。

### 4.2 工具契约扩展

在现有 `ToolDefinition` 上增加：

```ts
readOnly?: boolean;
destructive?: boolean;
concurrentSafe?: boolean;
riskLevel?: 'low' | 'medium' | 'high';
resolveInput?(input: unknown, ctx: ToolContext): Promise<unknown>;
prepareApproval?(input: unknown, ctx: ToolContext): Promise<ApprovalPreview>;
```

- `resolveInput` 在权限判定**之前**执行：把模型入参归一化成执行事实，杜绝“批准 A 执行 B”。
- `prepareApproval` 返回给 UI 的预览：实际命令、目标路径、影响范围。
- 元数据用于调度（并行/串行）与权限（destructive 必须 ask）。

### 4.3 路径层

- 所有路径 `path.resolve(workspace, input)` 后必须仍在 workspace 内。
- **realpath 检查**：解析符号链接后再判断边界（补 ZCode 的缺口）。
- 敏感文件：`.git/config`、`.env*`、`*.pem`、`id_rsa*`、`.ssh/**`、`*.key` 默认只读或 ask。
- 写操作检查 mtime：读过之后文件被外部修改 → 拒绝并要求重读（照搬 readFileState 思路）。
- 单文件大小上限（默认 2MB），超出拒绝并提示。

### 4.4 命令层

- **危险模式**：`rm -rf /`、`format`、`shutdown`、`diskpart`、`mkfs`、`dd of=/dev/`、`curl|sh`、`powershell -enc` 等，命中即 deny 或 high-risk ask。
- **环境变量白名单**：只传 `PATH/HOME/TMPDIR/LANG/SystemRoot/APPDATA` 等；不继承 API key、token。
- **超时**：默认 60s，可配；超时杀进程树。
- **输出截断**：stdout/stderr 各 100KB，超出截断并标记。
- **cwd 锁定**：必须在 workspace 内。
- **shell 选择**：Windows 用 `cmd.exe` 或 `pwsh`，POSIX 用 `/bin/sh`；不拼接不可信字符串（能 argv 就 argv）。

### 4.5 确认层

- 默认 `ask`：UI 弹出确认卡片，显示：工具名、实际命令/路径、影响范围、风险等级。
- 记住选择：本次会话 / 本项目 / 总是。
- **fail-closed**：UI 不可用或超时 → deny。
- 确认结果进入会话事件流，可审计。

### 4.6 工作区信任

- 首次打开一个工作区：提示“这个项目可以执行命令吗？”；未信任时只读。
- 信任记录：workspace 路径 + 声明摘要（.witcode/permissions.json、hooks、MCP 配置的哈希）。
- 声明变化 → 信任失效，重新确认。
- 只覆盖“项目级配置”，不替代工具级权限。

### 4.7 硬沙盒（预留）

- 接口：`SandboxProvider`：把一次执行包进隔离环境（工作目录、网络、文件系统视图）。
- Windows：Job Object 限制进程树 + 低权限令牌；后续可接 AppContainer。
- Linux：Landlock/bubblewrap（参考 DSH 的 `native/system`）。
- macOS：sandbox-exec（不推荐，已废弃）或 seatbelt。
- **P4 实现**；P3 只留接口，不假装有。

## 5. 实现顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| S1 | 四模式权限引擎（read-only / normal / autonomous / full）+ 审计记录 | 模式切换生效，每次决策有记录 |
| S2 | 路径层（realpath + 敏感文件）+ 命令层（危险模式/env/超时） | 逃逸与危险命令被拦 |
| S3 | 工具元数据 + resolveInput + prepareApproval | 批准 A 不能执行 B |
| S4 | 确认 UI + 会话记忆 + fail-closed | 弹窗能看到实际命令 |
| S5 | Brain execution 接入（profile / 契约 / 调度 / 压缩） | 切脑子时执行配置跟着换 |
| S6 | 工作区信任 | 未信任项目只读 |
| S7 | 调度器（拓扑+并行+上限） | 只读并行、破坏性串行 |
| S8 | 硬沙盒接口（P4 实现） | 接口可插拔 |

## 6. ZCode 的缺口与 WitCode 的补法

研究确认，ZCode 有几处**不能照搬**：

| 缺口 | ZCode 的实际行为 | WitCode 的做法 |
|---|---|---|
| workspace 硬边界 | `path-policy.ts:36-39` **故意不拦越界路径** | 解析 + realpath 后必须在 workspace 内，越界 ask/deny |
| 符号链接防护 | 只在 workflow 草稿写入时启用 | 通用写入前逐级 lstat 父目录，拒绝符号链接逃逸 |
| 危险命令解析 | 解析失败/超长时 **fail-open 退回 yolo** | **fail-closed**：解析失败按高风险处理并询问 |
| 环境变量 | 白名单不完整 | 默认空环境 + 显式白名单；代理/CA 单独注入 |
| OS 沙盒 | 明确没有 | 预留 SandboxProvider，P4 实现 |
| 确认与执行一致性 | `resolveInput` 前置，确认与执行同字节 | 照搬，并加“Hook 改入参后重跑权限” |
| 工作区信任 | 只覆盖 Hook/MCP，不覆盖工具/插件 | 覆盖项目级配置；插件单独启用与审计 |

一句话：**ZCode 的权限框架值得搬，但它的“方便优先”取舍不能搬。**

## 7. 不采用

- **不照搬 ZCode 的 105 条架构例外**：与安全无关。
- **不把工作区信任当成沙盒**：它只保护项目级配置，不隔离进程。
- **不在 P3 承诺 OS 级隔离**：没有实现就不写在 UI 上。
