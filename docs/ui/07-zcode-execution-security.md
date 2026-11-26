# ZCode 4.0.0 执行框架与安全机制拆解

只描述"是什么、为什么、可搬什么"，不作好坏评价。所有 `文件:行号` 默认相对于
`D:\Files\Projects\WitCode\resources\src\ZCode-4.0.0\apps\zcode-cli\packages\core\src\`；
`adapters/`、`contracts/`、`docs/`、`NOTICE.md` 单独注明。

**最重要的前提**：`NOTICE.md` 第一节明确写"当前共享 Agent 执行适配器不提供默认的操作系统沙箱"，并强调工作目录、工作区身份、Git worktree、浏览器页面隔离、Node REPL 上下文都**不是**系统级隔离保证。因此下文所有机制都是**软安全**（权限判定 / 路径策略 / 命令策略 / 确认 / 工作区信任），不是内核硬沙盒。WitCode 照搬时不要向用户宣称"已沙盒化"。

---

## 0. 全景：一次工具调用的执行链

Executor 主链在 `tool/executor/call-runner.ts:84-489`，顺序不可随意调换：

1. registry 查找与 `resolveForExecution`（把冻结的 advertisement entry 原子换成 live entry，发生在校验 / hook / 权限之前，`tool/types.ts:427-433`；调用点 `call-runner.ts:244-246`）。
2. 原始 JSON 解析错误检查（`validateInitialModelToolInput`，`tool/executor/validation.ts:133-163`；调用点 `call-runner.ts:300-316`）。
3. `entry.validateInput` 工具语义校验，刻意在 hook 之前收口（`call-runner.ts:318-343`）。
4. `entry.resolveInput` 归一化（`call-runner.ts:345-373`），详见第 4 节。
5. `runPreToolUseHooks`：deny 直接返回（`:375-422`），updatedInput 再校验并替换执行入参（`:423-442`）。
6. `resolveToolPermission` 完整权限流（`tool/executor/permission-flow.ts:134-415`），详见第 1 节。
7. `ToolCallStarted` 事件先于 handler 发出，带按执行入参解析出的副作用旗标（`call-runner.ts:493-513`）。
8. `resolveTimeoutMs` + `ToolDeadline` + `executeWithTimeout`（`call-runner.ts:515-522,633-641`），详见第 7 节。
9. handler → `validateOutput`（`tool/executor/validation.ts:21-52`）→ `serializeOutput` 限长（`tool/executor/result-serialization.ts:38-236`）。
10. PostToolUse / PostToolUseFailure hook 按结果是否错误分流（`call-runner.ts:663-723`），Hook 文本作为批次附件而不是塞进 tool result（`:693-723`）。
11. `turnControl` 终止语义：`stopTurnOnSuccess` 终态工具、`plan_exit_denied`、`automation_create_limit` 三种（`tool/executor/turn-control.ts:20-42,44-82,152-166`）。
12. 批次层 `executeToolSchedule` 按调度分组执行，若某组产生 turn stop，则后续所有工具以 ToolCancelled 结算（`tool/executor/batch-runner.ts:60-136`）。

---

## 1. 权限判定的完整顺序（plan → allow/deny）

核心是 `permission/service.ts:112-313` 的 `checkPermission()`。判定"每一步的条件与优先级"如下（编号即优先级，靠前者短路）：

1. **解析能力画像**：`resolveCapability()` 把工具声明与内置工具名兜底合成 `ResolvedPermissionCapability`（`permission/service.ts:704-732`）。兜底表：`readOnly` 含 Read/Glob/Grep/WebSearch/WebFetch/TodoRead/TodoWrite/AskUserQuestion/Agent/Task/Skill（`:680-694`），`destructive` 只有 Bash（`:700-702`），非只读工具默认 `needsApproval=true`、`sideEffectScope=workspace`（`:717-727`）。
2. **Plan 模式转换硬判定**：`resolvePlanModeTransitionPermission()`（`permission/plan-mode-policy.ts:20-43`）——`EnterPlanMode` 无条件 allow；`ExitPlanMode` 仅在 plan 生效时进入后续判定，否则**硬 deny**。这一支先于一切模式与规则（`service.ts:119-125`）。
3. **需用户交互的工具**：`requiresUserInteraction` 时先查 `disallowedTools` 硬禁用（deny），否则 ask（`service.ts:127-143`）。
4. **Guarded 危险命令单次确认先于 YOLO**：`!planEnabled && mode==="guarded" && userApprovalRule` 时返回 `user-once` 的 ask，不提供"始终允许"（`service.ts:145-149`，`guardedSingleUseAsk` 见 `:494-509`）。注：源码注释明确"独立 Plan 优先于 Guarded 的 YOLO 基础策略，审批不能解除 Plan 的执行限制"。
5. **alwaysAsk 工具闸门**：`capability.alwaysAsk` 走 `checkAlwaysAsk()`（`service.ts:151-154,415-474`）。这是"ask 压过所有放行分支、但压不过硬阻断"的独立子流程，见 1.2。
6. **YOLO / Guarded 直通**：`mode==="yolo" || "guarded"` 且 `!planEnabled` → allow `mode.yolo`（`service.ts:156-158`）。注意此时尚未经过 `disallowedTools`，源码注释承认"yolo 目前先于 disallowedTools 放行"（`:411-413`）。
7. **auto 模式**：保留但未实现，硬 deny（`:160-167`）。
8. **全局硬禁用**：`disallowedTools` 命中 → deny `rule.disallowedTools`（`:169-176`）。
9. **项目规则 deny**：`matchesProjectRules(...,"deny")` → deny（`:178-185`）。
10. **项目规则 ask**：`matchesProjectRules(...,"ask")` → ask（`:187-194`）。
11. **ReplyToChannel 预批**：原会话回复的接收方由 Host 再校验，network 副作用不重弹窗（`:196-212`）。
12. **Plan 闸门**：`planEnabled` 时 `checkPlanMode()`（`:214-233,514-567`）——只读且不需审批 → allow；需审批的只读 / 非破坏性 MCP → 过闸交回原模式（MCP 额外 ask 且 `optionsPolicy=no-always-allow`，`:533-545`）；显式 `allowedInPlanMode + session + 非破坏性` → allow（`:547-559`）；其余一律 deny `mode.plan.nonReadOnly`（`:561-566`）。闸门未拒绝时补做第 4 步的 guarded 单次确认（`:220-222`），再补回被 `planEnabled` 跳过的 yolo/guarded 放行（`:225-232`）。
13. **项目规则 allow**：`matchesProjectRules(...,"allow")` → allow（`:235-242`）。
14. **三个写入/网络预批特例**（均排在 plan 分支与项目 deny/ask 之后，且须同时匹配工具名与能力，不扩大其他工具权限）：WebFetch 预批 URL（`:244-251`）、CronPauseSelf 暂停自身（`:253-270`）、Workflow 草稿写入（`:272-289`）。
15. **allowedTools 全局白名单**：allow（`:291-298`）。
16. **工具自收确认**：`permission.confirmationHandledByTool` → allow（`:300-307`）。
17. **edit 模式**：`permissionName==="edit" && sideEffectScope==="workspace"` → allow；否则落入 build 判定（`:308-310,639-653`）。
18. **build 模式兜底**：只读且不需审批 → allow；critical 风险 → ask；high 风险且未开 `autoApproveHighRisk` → ask；低风险 session 副作用 → allow；`needsApproval || destructive || sideEffectScope!=="none"` → ask `mode.build.sideEffect`；其余 allow `mode.build.lowRisk`（`:312,573-637`）。配置默认 `autoApproveHighRisk=false`（`:800-812`）。

### 1.2 alwaysAsk 闸门的内部顺序（不可被 hook allow 抹掉）

`checkAlwaysAsk()`（`permission/service.ts:415-474`）自己先走一遍硬阻断，再落到 ask：

1. `auto` → deny；2. `disallowedTools` → deny；3. 项目规则 deny → deny；4. **会话规则 allow** → allow（`:445-454`）；5. AmendWorkflow/FillWorkflowHole 的本会话 run 归属预批 → allow（`:455-467,481-492`）；6. 否则 ask `tool.alwaysAsk`。
- 设计意图：少了 1–3，被硬禁用的工具会退化成"弹窗、用户一点就能跑"（注释 `:404-414`）。
- `alwaysAsk` 标记通过结构化字段 `alwaysAsk` 传到下游（`result()` `:761-779`），`hook-flow.ts:197-233` 据此禁止 PreToolUse hook 的 allow 覆盖它。

### 1.3 会话级规则与项目规则的位置

- **会话规则** `sessionRules` 是 `PermissionService` 实例字段，一实例=一会话，重启 / 冷恢复 / `/new` 自然清空；`grantSessionPermission()` 只是 `applyPermissionUpdates`（`permission/service.ts:98-110`）。它**只服务 alwaysAsk 闸门**，普通工具的模式语义不认它（注释 `:99-103`）。
- **项目规则**从磁盘加载（`permission-flow.ts:147-161`），按 deny / ask / allow 三档分别匹配，且可经 `rulePolicy.evaluateRules` 做工具专属判定（如 Bash 命令分析，`service.ts:315-330`；`handlers/bash-command-permission-policy.ts:85-132`）。
- 规则内容匹配：`: *` 前缀按命令前缀 + 空格/Tab 边界，`*` 用 `wildcardToRegExp`，否则精确相等（`service.ts:389-402`；`permission/rule-matching.ts:1-7`）。WebFetch 额外按域名主体匹配（`rule-matching.ts:9-22`）。
- 规则主体取自输入的 `command/url/file_path/path/pattern/patch_text`（`service.ts:365-380`）；Write 规则与 Edit 工具名互通（`:346-349`）。
- 用户批准后 `applyGrantedPermissionUpdates` 持久化项目规则与会话规则（`permission-flow.ts:390-398`）。
- 两个特殊身份护栏：官方 CUA 规则只在 capability group 为 `OfficialCua` 时匹配（`service.ts:356-363`）；`permission-rules.ts:32-45` 按 `toolName + ruleContent` 去重。

### 1.4 Executor 层在 checkPermission 之外的四步

`resolveToolPermission()` 的流程（`permission-flow.ts:134-415`）：

1. **PreToolUse hook 覆盖**：仅首次输入且非 `user-once` 时生效；hook allow 只能把 ask 变 allow、hook ask 能把 allow 变 ask，但 deny 与 alwaysAsk 不可覆盖（`hook-flow.ts:197-233`；`permission-flow.ts:186-189`）。
2. **Memory 文件预批**：Write/Edit 指向 memoryRoot 内 `.md` 且路径不含敏感段时，把 ask 改 allow，但保留 deny（除 plan deny）、alwaysAsk、项目 ask、hook ask（`executor/memory-file-permission.ts:17-76`；调用点 `permission-flow.ts:190-197`）。
3. **prepareApproval 收窄**：见第 4 节（`permission-flow.ts:247-260`）。
4. **Broker 应答与 hook 改写重判**：非 guarded 且 PermissionRequest hook 返回 `modify` 时，重新归一化输入并重跑权限判定；若仍为 ask 则丢弃本次 broker 并用新 requestId 重来（`permission-flow.ts:291-324,373-376`）；最后 `applyInputAdjustments` 应用确认窗里改过的字段（`:399-413`）。
- Broker 无客户端时：guarded 抛配置错、其余返回 deny 并给模型"已请求未授予"的可读文字（`permission/broker.ts:24-55`）；`ManualPermissionBroker` 支持 requestId/toolCallId 双键、abort、超时（`broker.ts:63-188`）。

---

## 2. 权限模式的准确语义

模式联合类型共六个：`"plan" | "build" | "edit" | "yolo" | "guarded" | "auto"`（contracts `interfaces/session.port.ts:33`）。

| 模式 | 语义 | 硬拦截 / 提示词 |
|---|---|---|
| plan | 只读规划闸门，叠在原模式之上。只读免审批放行；需审批的只读（WebFetch、readOnlyHint MCP）过闸交原模式；非只读 MCP 询问且不给"始终允许"；其余写入一律 deny（`permission/service.ts:514-567`） | **硬拦截**为主 + 一处 ask |
| guarded | 等同 yolo，但对**识别出的危险 shell 命令**弹一次性确认（不给始终允许）；未识别/解析失败则退回 yolo（`service.ts:145-149,156-158`；`handlers/bash.ts:124-137`；`handlers/guarded/command.ts:42-130`） | 提示词（单次 ask），非硬拦截 |
| yolo | 普通工具全放行，`mode.yolo`（`service.ts:156-158`）；共享配置默认 build，但 CLI `--prompt` 非交互默认 yolo（NOTICE.md 第一节；`packages/cli/src/run.ts:53`） | 基本不拦 |
| build | 默认模式：只读放行；critical / high 风险询问；有副作用、destructive 或 needsApproval 询问（`service.ts:573-637`） | 提示词 |
| edit | 文件编辑工具直接放行，其余按 build（`service.ts:639-653`） | 提示词 |
| auto | 保留未实现，硬 deny（`service.ts:160-167`） | 硬拦截 |

- Guarded 危险命令识别是** deny-list**：匹配 `rm -r/-f/批量/通配`、`rsync --delete`、`dd/mount/umount/mkfs`、`find -delete`、`git reset --hard / force push`、`CMD rd/del`、`robocopy /purge` 等；命令长度 > 10000 字符或 legacy-shell 直接 `unsupported`，不给 userApprovalRule，于是**静默退回 yolo**（`handlers/guarded/command.ts:42-77,95-130`；`handlers/bash.ts:129-137`）。这是照搬时最该补的一处 fail-open。
- 只读 Bash 命令在 capability 里被标为 `readOnly=true, needsApproval=false, riskLevel=low, sideEffectScope=none`（`handlers/bash.ts:140-155`）。
- 子代理 `permissionMode` 按来源收紧：父会话为 guarded 时任何来源的 `bypassPermissions/dontAsk` 收紧为 guarded；项目级 profile 忽略；插件 agent 只在更严格时生效；严格度 plan < build < edit < guarded < yolo（`docs/security/deep-link-project-trust-boundary.md` 第 41–50 行）。

---

## 3. 工具元数据的控制作用

定义在 `tool/types.ts:82-118`（`ToolMetadata`）与 `ToolEntry` `:402-528`：

| 字段 | 控制什么 | 权威位置 |
|---|---|---|
| `readOnly` | Plan/Build 免审批直通的前提之一（`permission/service.ts:519,577`）；调度并行判定（`tool/scheduler.ts:97-102`） | 工具声明，缺省按内置名兜底（`service.ts:711`） |
| `destructive` | 压过 Plan 只读直通、压过 MCP 非破坏性过闸（`service.ts:519,531,549`）；调度强制串行（`scheduler.ts:98`） | 工具声明，缺省仅 Bash（`service.ts:712`） |
| `concurrentSafe` | 调度器显式 true 并行 / false 串行，独立于 readOnly（`scheduler.ts:99-100`） | 工具声明 |
| `sideEffectScope` | Plan 的 session 特例、Build 的 low-risk 特例、有副作用即 ask（`service.ts:547-559,604-628`） | 工具声明或 `permission.sideEffectScope` 优先（`service.ts:717-720`） |
| `riskLevel` | Build 的 critical/high 询问阈值（`service.ts:586-602`） | `permission.riskLevel` > 工具声明 > 内置名兜底（`service.ts:721-723`） |
| `needsApproval` | Build 的"有副作用需审批"判定；Plan 只读直通要求它为 false（`service.ts:519,618`） | `permission.needsApproval` > 工具声明 > 非只读默认 true（`service.ts:724-727`） |

`ToolEntry.resolvePermissionCapability`（`tool/types.ts:504-507`）允许按**执行入参**动态覆盖上述能力（Bash 的危险/只读判定即由此落地，`handlers/bash.ts:124-156`）；`resolvePermissionRulePolicy`（`types.ts:508-511`）允许按入参替换规则评估器。执行时两者都在 `checkStaticToolPermission` 里被解析（`permission-flow.ts:115-130`）。

---

## 4. resolveInput 与 prepareApproval：为什么一个在权限前、一个在权限后

### 4.1 resolveInput（权限之前）

契约注释在 `tool/types.ts:458-476`，调用点在 `call-runner.ts:345-373`。它在 `validateInput` 之后、`PreToolUse` hook 之前执行，把模型入参换成"将要发生的执行事实"。位置即全部意义，一次解决三件事：

1. **策略不被绕开**：扫描脚本的 PreToolUse hook 在 saved run 上也看到真正的脚本。
2. **跨版本可见**：入参通道对每个客户端版本都是无 schema 透传，而 display 通道不是。
3. **确认与执行同字节**：只解析一次，那份字节一路带到 handler，不存在"批准 A 跑 B"。

失败按业务失败在 hook 之前收口，不先弹注定失败的确认窗（`call-runner.ts:353-371`）。上下文被刻意窄化到只有工作目录等只读端口，避免归一化钩子变成第二个执行入口（`tool/types.ts:354-381`）。

### 4.2 prepareApproval（权限判定为 ask 之后）

契约注释在 `tool/types.ts:512-522`，实现在 `tool/executor/approval-gate.ts:26-75`。它是工具对 `ask` 的"最后一句话"，**只能单向收窄**：把 ask 放行成 `proceed`，或给 ask 补 `display` 预览，**永远不能把 allow 变成 ask**。同步、不做 I/O；需要读世界才能构造预览的工具应放进更早的 `resolveInput`。
- 异常时 **fail closed**：预览生成失败照旧 ask，只降级预览，绝不静默放行未获批准的工具（`approval-gate.ts:60-74`）。
- Guarded 的 `user-once` 确认跳过 prepareApproval，强制 ask（`permission-flow.ts:247-251`）。
- 判定自带的 `optionsPolicy`（Plan 下 MCP 询问）覆盖工具声明（`permission-flow.ts:252-256`）。
- 确认窗里的字段调整在授权之后由 `applyInputAdjustments` 应用（`tool/types.ts:477-488`；`permission-flow.ts:399-413`）。

---

## 5. 路径策略：归一化、边界、符号链接、敏感目录、大小限制

1. **归一化**：`resolveWorkspacePath` 对绝对路径 `normalize`，对相对路径 `resolve(workingDirectory, ...)`；空路径抛错；`workingDirectory/workspaceRoot` 必须是绝对路径（`tool/path-policy.ts:15-40,61-76`）。比较键 `createReadFileStatePathKey` 走 `normalizeToolPathForComparison`：Windows 盘符别名 `/c/...`、扩展路径前缀、盘符大小写、NFC 归一化（`tool/path-normalization.ts:13-53`；`tool/read-file-state.ts:12-17`）。
2. **workspace 边界：当前版本故意不硬拦**。`path-policy.ts:36-39` 明确写"不硬阻断 workspaceRoot 之外的路径"，理由是子代理可能需要检查兄弟仓库或外部文件，等文件系统权限适配器长出显式 ask/deny 规则再说。**这是照搬时必须自己补的第一缺口。**
3. **符号链接**：`assertNoSymlinkBetween` 从 base 逐级 `lstat` 到 target，任一级是链接即拒绝，命中 ENOENT/ENOTDIR 即停（`adapters/src/fs/symlink-guard.ts:9-31`）。但它**只对 workflow 草稿写入生效**：Write/Edit 仅在 `isWorkflowDraftPath` 时传 `symlinkFreeBase`（`tool/handlers/write.ts:139-154`；`edit.ts:541-556`），普通工作区路径不传（`fs/index.ts:299-322`；测试 `core/tests/workflow-draft-write-symlink-guard.test.ts:39-44`）。所以普通文件写入没有符号链接防护。
4. **敏感目录**：`.git/hooks/.husky/.githooks/node_modules/.vscode/.idea/head/config/objects/refs/.claude/.zcode/skills/commands/agents/.cargo/.devcontainer/.yarn/.mvn` 这份清单只用于 **memory Markdown 写入**的 `resolveSafeMemoryFilePath`（`tool/../memory/memory-file-path.ts:8-27,48-65`），不是通用工作区写入边界。归一化时会剥离零宽/方向控制字符、冒号后缀与尾部点空格（同文件 `:68-73`）。
5. **大小限制**：Edit 单文件上限 1 GiB（`tool/handlers/edit.ts:65,166-175`）；通用结果预算 `maxInlineBytes/maxModelBytes=100000` 字节、head 截断（`executor/result-serialization.ts:25-32`）；执行输出内联 10 MiB、持久化 50 MiB、Bash 运行时上限 5 GiB（`adapters/src/exec/execution-utils.ts:8-11`）。
6. **`.gitignore` 不是权限边界**：工具目录里与 `.ignore` 相关的命中都在只读命令分析与工作流草稿读取里（`tool/handlers/bash-readonly-policy-flags-text.ts`、`tool/handlers/workflow-drafts.ts`），不参与 deny/ask 判定。

---

## 6. 读写校验：readFileState 如何记录、"未读先写"如何检查

### 6.1 记录

- 每条文件一条记录，键为归一化路径；`setReadFileStateEntry` 先删后写，Map 顺序即最近写入顺序（`tool/read-file-state.ts:19-34`）。
- Read 写入完整字段：`content`、`offset`、`limit`、`isPartialView`（仅当 `truncatedByTokenCap`，range view 不算 partial）、`readAt`、`sourceTool="Read"`、`revisionId`、`mtimeMs`（取整）、`sizeBytes`、原始请求路径（`tool/handlers/read.ts:353-374`）。
- 正文哈希按 UTF-16LE 计算 sha256（不用 UTF-8，避免孤立代理字符被替换成 U+FFFD 导致哈希碰撞）；冷恢复只剩 `contentSha256` 时用哈希比较（`tool/read-file-state.ts:57-74`）。
- Edit/Write 成功后立即用完整视图覆盖记录（`edit.ts:613-634`；`write.ts:378-398`），并记录 metadata 供冷恢复排序（`call-runner.ts:596-605`）。

### 6.2 未读先写 / stale 检查

`getEditableReadStateFailure`（`edit.ts:451-469`；Write 同构见 `write.ts:305-319`）：

1. `readFileState` 不存在 → 直接放过（无状态则不校验）。
2. 没有记录或 `isPartialView=true` → `FILE_NOT_READ`："File has not been read yet. Read it first before writing to it."（`edit.ts:65-66,459-461`）。部分视图（被 token 上限截断）不算读过；offset/limit 的 range view 不算 partial（`read.ts:365-367`）。
3. `hasReadStateChanged` 为 false → 放过。变化判定：当前文件整数毫秒 mtime **严格晚于**记录、或 sizeBytes 不同 → stale；无 mtime 时比 sizeBytes；再退而比 `revisionId`（`edit.ts:476-500`）。只比整数毫秒、且要求"严格晚于"是为减少亚毫秒误报（`:482-488`）。
4. 若判定变化，但记录是严格全量读（`(offset??1)<=1 && limit===undefined`）且正文与当前内容相同 → 放过（`edit.ts:463-466,471-474`）。
5. 否则 `STALE_FILE`："File has been modified since read ... Read it again"（`edit.ts:67-68,468`）。
- 底层 `writeTextFile` 还支持 `expectedRevision` 乐观并发校验（`adapters/src/fs/index.ts:302-311`）。
- 读取缓存也复用同一新鲜度策略，命中条件：同视图 + 非 partial + mtime/size 或 revisionId 一致（`read.ts:306-341`）。

---

## 7. 命令执行安全

1. **spawn 方式**（`adapters/src/exec/execution-command.ts:72-170`；`node-execution-adapter-process.ts:145-170`）：shell 模式由 session owner 固定的 dialect 解析；POSIX 下 `detached: platform!=="win32"`（自成进程组），`windowsHide: true`，stdio 为 stdin ignore/pipe + stdout/stderr pipe；Windows 的 `.cmd/.bat` 走 `cmd.exe /d /s /c`，`.exe` 用 `shell:false` argv（同文件 `:136-141,232-247`）。
2. **环境变量白名单 / 清洗**（`execution-command.ts:29-70`）：默认继承 `process.env`；`base:"empty"` 可得空环境；`sanitizeZCodeRuntimeEnvInPlace` 剥离运行时的 `NODE_ENV` / 代理 / 证书变量，再由 `applyNetworkEgressEnv` 从 ZCode 内部封存键恢复代理、NO_PROXY、CA（`adapters/src/network/subprocess-env.ts:34-61,66-130`）；Windows 下键名大小写不敏感删除/设置。这是**防污染**而非最小权限白名单。
3. **超时**（`tool/executor/timeout.ts:17-82,100-197,210-233`）：`ToolDeadline` 可暂停——工具内部模型请求在准入闸门前排队时暂停计时，剩余时长守恒；默认上限由 `policy.maxMs` 截断，另加 `cleanupGraceMs`；超时或 abort 时 `abortController.abort(error)` 并交给 handler 的清理策略 `entry.cancellation.cleanup`。执行适配器默认超时 300 s（`adapters/src/exec/execution-utils.ts:4`）。
4. **输出截断**（`executor/result-serialization.ts:25-236`）：先算 UTF-8 字节与可选字符阈值，受保护的官方 CUA 帧与引用投影先走专用通道；超预算且 `strategy:"artifact"` 才落盘并把预览交回模型；否则 `fitContentWithSuffix` 按 `preview.direction`（默认 head）截断并附一段 `[Tool output truncated by resultBudget: ...]` 说明。`isModelContentBounded` 的工具（如 Bash 失败结果按字符保留头尾）跳过二次截断（`:75-87`）。
5. **进程树清理**（`adapters/src/exec/process-tree.ts:5-85`；`node-execution-adapter-process.ts:173-227`）：Windows 用 `taskkill /pid X /T /F`，失败回退 `child.kill(SIGKILL)`；POSIX 通用路径对进程组 `process.kill(-pid, SIGTERM)`，750 ms 后 SIGKILL；Bash 因 job control / pipeline / xargs / PTY 会跨 PGID，改为两阶段：用 `ps -A -o pid= -o ppid=` 枚举 PPID 后代（500 ms 超时退化为空集），SIGTERM 根进程组 + 所有后代，1500 ms 后再 SIGKILL 组并重查后代；`FORCE_EXIT_AFTER_KILL_MS=5000`。
6. **危险命令识别**：见第 2 节 guarded deny-list（`handlers/guarded/command.ts:42-130`），含 `git` subcommand 匹配与包装器展开（`guarded/git.ts`、`guarded/wrappers.ts`）。
7. **不可撤销性提示**：停止会话 / 切页 / 取消请求不能撤销已完成的文件写入、发布、上传；Hook、后台任务、插件进程也不都走同一审批（NOTICE.md 第一节）。

---

## 8. 工具调度：拓扑排序、并行分组、并发上限、破坏性串行

实现在 `tool/scheduler.ts`：

1. **依赖建模**：`ToolDependency.dependsOn` 转成 `inDegree`，Kahn 拓扑排序；剩余节点非空即抛 `InvalidStateTransition`（`:105-152`）。
2. **并行资格**（`:85-103`）：`destructive → false`；`concurrentSafe===true → true`；`concurrentSafe===false → false`；`readOnly → true`；否则仅 `sideEffectScope==="none"` 才并行。即破坏性工具强制独占一组。
3. **分组**（`:154-202`）：层级 = 依赖层级最大值 + 1；同层内把可并行项按 `maxConcurrency` 切成多组，不可并行项自己单独成组并 flush 当前并行组。
4. **并发上限**：默认 10（`:43-57`）；`executeToolBatch` 若调用数 ≤ 上限则一次 `Promise.all`，否则按上限分批（`executor/batch-runner.ts:24-58`）。
5. **环检测**：除拓扑排序外，`validateNoCycles` 再检查同组依赖（`:204-226`）。
6. **turn stop 抢占**：`executeToolSchedule` 每组结束检查 `turnControl.stopTurnAfterResult`，命中则后续组内全部工具以 ToolCancelled 结算并发出错误事件（`batch-runner.ts:100-136`）。前序工具普通失败则继续按组执行（旧"阻断后续"策略已被注释掉，`:138-164`）。

---

## 9. 工作区信任：hook/MCP 的 trust 记录、声明摘要、失效条件

### 9.1 记录与摘要

- 信任键 = `workspaceIdentity + "\0" + hookDeclarationDigest`（sha256），持久记录以该键入 Map（`hooks/workspace-hook-trust-evaluation.ts:74-76`；`workspace-hook-trust-coordinator.ts:70-94`）。
- 授权时记录 workspaceIdentity、声明摘要、algorithm、decision、bundleDigestAtGrant、event、展示命令、源文件相对路径、discoveryOrder、matcher/matcherIndex/hookIndex、appVersion（`hooks/workspace-hook-trust-records.ts:4-34`）。
- 策略默认 `user_decides`；三态 `deny / allow_trusted_only / user_decides`（`hooks/workspace-hook-policy.ts:4-7`）。只有 `user_decides` 允许持久 trust 变更；provider 解析失败一律 `deny` fail-closed（`workspace-hook-trust-coordinator.ts:54-68,155-173`）。

### 9.2 失效条件（evaluateWorkspaceHookEntry）

`workspace-hook-trust-evaluation.ts:16-72` 的判定优先级：

1. policy `deny` → `blocked_policy`；
2. trust store `corrupt` 或入口脚本不存在/不可读 → `blocked_untrusted`；
3. `allow_trusted_only` 且无持久记录 → `blocked_policy`；
4. 有持久记录 → `trusted_persistent`；
5. 命中 `revokedKeys` → `revoked`；
6. **stale slot**：同 workspace、同 event/源路径/discoveryOrder/matcher/matcherIndex/hookIndex 但**摘要不同** → `stale_digest`（`:78-107`）；
7. 否则 `pending_trust`。
- `effectiveRunnable = admitted 类 && configuredEnabled && policy!=="deny"`（`:58-59`）。
- **运行前再校验脚本内容**：`verifyScriptEntry` 每次派发前按实际 cwd 重读脚本并比对 sha256，不符即 `workspace_hook_declaration_changed` / `workspace_hook_script_unavailable`，不热替换 snapshot（`workspace-hook-runtime-admission.ts:211-245`）。这修的是"信任时绑定内容、会话中替换脚本仍被执行"的 TOCTOU。
- **安全修订号**：`coordinatorEpoch + counter`，revoke / 策略变化 / 记录替换都会 bump；dispatch 时校验，不匹配则刷新 evaluation 与 admission 状态（`workspace-hook-trust-coordinator.ts:138-153`；`workspace-hook-runtime-admission.ts:166-178`）。
- dispatch 门禁逐级：snapshot 匹配 → 未失效 → 已激活 → 功能开启 → bootstrap 未失败 → revision 有效 → item 可运行（`workspace-hook-runtime-admission.ts:134-209`）。
- 深链边界：deep link 路径先拒 UNC / 网络路径再探测，打开目录需确认，但**确认只授权打开路径，不建立 Hook Trust**；项目 JSON 只接受扩展声明白名单（mcp/hooks/plugins/skill/command），network/permission/storage 等运行参数不生效；项目 JSON 的 Hook 声明视为未信任代码（`docs/security/deep-link-project-trust-boundary.md` 第 20–50 行）。

### 9.3 它保护什么、不保护什么

- **保护**：工作区级 Hook 的"审核过的内容才能执行"，以及审核后脚本被改写的 TOCTOU。
- **不保护**：插件 Hook、MCP 配置、其他项目脚本的统一审核——NOTICE.md 第一节明确"该机制不等于对插件 Hook、MCP 配置或其他项目脚本的统一审核"；已启用插件（含第三方市场）的 Hook 照常执行且插件本身无隔离（deep-link 文档第 43–47 行）。`permissionMode` 规则防不了恶意插件。

---

## 10. 软安全 vs 硬沙盒：ZCode 有什么、没有什么

### ZCode 有的（软安全）

- 模式化权限判定 + 工具能力元数据 + 项目/会话规则 + hook 参与（`permission/service.ts:112-313`）。
- Plan 写入硬闸门、Guarded 危险命令 deny-list、Build 风险阈值（`service.ts:514-637`）。
- 归一化输入、确认预览、确认窗字段调整（`tool/types.ts:458-522`）。
- readFileState 未读先写 / stale 校验（`edit.ts:451-500`）。
- 路径归一化与 memory 文件的目录包含 + 敏感段过滤（`path-policy.ts:15-40`；`memory/memory-file-path.ts`）。
- workflow 草稿写入的符号链接防护（`adapters/src/fs/symlink-guard.ts:9-31`）。
- 超时、可暂停 deadline、输出限长、进程树清理（`executor/timeout.ts`；`result-serialization.ts`；`process-tree.ts`）。
- 工具拓扑调度与破坏性串行（`tool/scheduler.ts`）。
- 工作区 Hook 声明摘要信任 + 运行前重校验（`hooks/workspace-hook-trust-*.ts`）。

### ZCode 没有的（必须明说）

- **无 OS 沙盒**：无 seccomp / namespace / cgroups / chroot / 容器隔离 / 沙箱用户，进程按运行账号权限执行（NOTICE.md 第一节；安全审计报告 P1 亦指出 Web server 未鉴权、凭据 fallback 可推导，属部署层问题，`docs/security/security-audit-2026-06-09.md` 第 26–33、80–100 行）。
- **无 workspace 路径硬边界**：`path-policy.ts:36-39` 明确不硬拦越界路径。
- **无通用符号链接防护**：只对 workflow 草稿（第 5 节第 3 点）。
- **无危险命令的 fail-closed**：guarded 解析失败/超长命令退回 yolo（第 2 节）。
- **无统一插件/MCP 审核**：插件 Hook 自有可信路径，MCP 连接/OAuth/发现不在工具审批覆盖内（NOTICE.md 第一节）。
- **工具审批不是全应用统一开关**：终端、插件进程、更新下载不保证经过同一审批（NOTICE.md 第一节）。
- **Computer Use 是占位实现**，不提供截图/操作能力（NOTICE.md 第一节）。

---

## 11. 可搬清单（P0/P1/P2）

### P0（照搬逻辑，WitCode 必须尽快有）

| 项 | 来源 | 标注 |
|---|---|---|
| 权限判定顺序与 alwaysAsk 硬阻断子流程 | `permission/service.ts:112-313,415-474` | 照搬逻辑（把 plan/guarded/yolo/build 语义照实实现） |
| 工具能力元数据画像与兜底 | `tool/types.ts:82-118`；`service.ts:704-732` | 照搬逻辑 |
| resolveInput 前置归一化 + prepareApproval 单向收窄 | `tool/types.ts:458-522`；`approval-gate.ts:26-75` | 照搬逻辑（含预览失败 fail-closed） |
| readFileState 未读先写 / stale 校验 | `read-file-state.ts`；`edit.ts:451-500`；`write.ts:305-319` | 照搬逻辑 |
| 结果截断与预算回执 | `result-serialization.ts:25-236` | 照搬逻辑 |
| 超时 + 可暂停 deadline | `timeout.ts:17-233` | 照搬逻辑 |
| 进程树清理 | `process-tree.ts`；`node-execution-adapter-process.ts:173-227` | 照搬逻辑（按本机平台适配） |

### P1（需重写，照搬思路不照搬代码）

| 项 | 来源 | 标注 |
|---|---|---|
| 项目/会话规则与 deny/ask/allow 优先级 | `service.ts:315-402`；`permission-rules.ts` | 需重写（规则存储换成 WitCode 自己的配置层） |
| 权限 broker / 确认窗 / 字段调整 | `broker.ts`；`permission-flow.ts:247-415` | 需重写（接到 WitCode 的 UI 通道） |
| 危险命令识别 | `handlers/guarded/command.ts` | 需重写 + 补 fail-closed（ZCode 原版解析失败放行） |
| 工具调度与破坏性串行 | `scheduler.ts`；`batch-runner.ts` | 需重写（并发上限按 WitCode runtime 定） |
| turn 状态机与非法跃迁 | `agent/turn-state.ts:27-38,233-266`；`turn-machine.ts:92-104` | 需重写（接入 WitCode 的 turn 循环） |
| 工作区 Hook 声明摘要信任 | `hooks/workspace-hook-trust-*.ts` | 需重写（换成 WitCode 的 Hook/MCP 审核面） |
| 环境变量清洗 / 代理 CA 恢复 | `execution-command.ts:29-70`；`subprocess-env.ts` | 需重写（对齐本机代理与凭据策略） |

### P2（不适用 / 仅参考）

| 项 | 原因 |
|---|---|
| 符号链接防护直接套用 | 原版仅覆盖 workflow 草稿，WitCode 若要通用文件防护需扩大范围（属 P1 重写） |
| CUA 帧原子保护、官方 CUA capability group | WitCode 无对应 Computer Use 能力（NOTICE.md 声明占位） |
| 工作区身份 / 深链 / 远程 worktree 绑定 | 与 WitCode 现有 workspace 模型不同，仅作设计参考 |
| 插件市场 / OAuth 自动刷新 / 分享链路 | 超出本次"执行框架 + 安全层"范围 |
| `.gitignore` 作为权限边界 | ZCode 本身不这样用，不适用 |

---

## 12. WitCode 软沙盒设计建议

明确边界：以下是**应用层的软安全**，不能替代 OS 隔离。对不可信项目，仍应建议用户使用受限账号 / 容器 / 虚拟机等系统级手段。

### 12.1 权限层

1. 建立与 ZCode 一致的六态模式（plan/build/edit/yolo/guarded/auto），`auto` 一律 deny，默认 build（对齐 `service.ts:160-167,573-637`）。
2. 判定顺序固定为：硬禁用 → 项目 deny → 项目 ask → plan 闸门 → 模式放行 → 项目 allow → 兜底按 riskLevel/sideEffectScope 判（`service.ts:112-313`）。
3. 会话级 "always allow" 只在 alwaysAsk 闸门里生效，且必须先过硬阻断（对齐 `service.ts:445-474`）。
4. 每条判定返回结构化 `ruleId / reason / riskLevel / sideEffectScope / alwaysAsk`，供 UI 与审计使用（`service.ts:74-92`）。
5. PreToolUse hook 可把 ask 降为 allow，但**不得覆盖 deny 与 alwaysAsk**（`hook-flow.ts:197-233`）。

### 12.2 路径层

1. 归一化所有路径（绝对化、大小写/NFC、Windows 盘符别名），比较键走统一函数（对齐 `path-normalization.ts:13-53`）。
2. 必须加 ZCode 缺的那一条：解析后校验目标位于 workspaceRoot 内，越界走 ask/deny 而不是静默放行（`path-policy.ts:36-39` 是反面教材）。
3. 逐级 lstat 父目录拒绝符号链接，且从"通用文件写入"开始就启用，而非只保护草稿（`symlink-guard.ts:9-31`）。
4. memory / 配置 / Hook 目录使用独立的敏感段清单与目录包含校验（`memory-file-path.ts:8-65`）。
5. 大文件设上限（编辑 1 GiB、内联结果 100 KB、执行输出分片落盘），并在报告里写明真实字节数（`edit.ts:65`；`result-serialization.ts:25-32`）。

### 12.3 命令层

1. 默认 `shell:false` + argv 执行；只有用户显式要求时才用 shell，并记录 dialect（`execution-command.ts:72-170`）。
2. 子进程环境默认空环境 + 显式白名单，代理/CA 从内部封存键注入，剥离运行时变量（`execution-command.ts:29-70`；`subprocess-env.ts:34-61`）。
3. 危险命令识别改为 **fail-closed**：解析失败 / 超长 / 未知语法时按危险处理并询问，而不是退回 yolo（`guarded/command.ts:42-77` 的缺口）。
4. 超时、可暂停 deadline、输出截断、进程树清理四件套照搬；POSIX 用独立进程组，Windows 用 taskkill /T /F（`timeout.ts`；`process-tree.ts`）。
5. 破坏性工具独占调度组，前序 turn stop 时取消后续全部工具（`scheduler.ts:85-103`；`batch-runner.ts:100-136`）。

### 12.4 确认层

1. 确认窗展示的是 **resolveInput 之后的同一份字节**，批准与执行不得分叉（`tool/types.ts:458-476`）。
2. prepareApproval 只做单向收窄与预览，异常 fail-closed 继续询问（`approval-gate.ts:60-74`）。
3. guarded 危险命令确认是一次性的，不提供"始终允许"（`service.ts:494-509`）。
4. 确认窗可调整字段需经 applyInputAdjustments 回写并再校验（`permission-flow.ts:399-413`）。
5. Hook 修改输入后必须重跑权限判定；仍为 ask 时丢弃旧应答、换新 requestId（`permission-flow.ts:291-324`）。

### 12.5 工作区信任

1. 工作区级 Hook / MCP 声明按 `workspaceIdentity + declarationDigest` 记录信任，摘要变化即失效（`trust-evaluation.ts:74-76,78-107`）。
2. 派发前重读脚本并比对 sha256，防审核后被替换（`runtime-admission.ts:211-245`）。
3. 策略三态 `deny / allow_trusted_only / user_decides`，默认 user_decides，provider 异常 fail-closed（`workspace-hook-policy.ts:4-7`；`trust-coordinator.ts:155-173`）。
4. 只在用户明确审核路径建立信任；"打开目录"不等于"执行目录代码"，普通权限回答不得授权（`deep-link-project-trust-boundary.md` 第 26–40 行）。
5. 明确告知用户该信任不覆盖插件 Hook、MCP 配置与其他项目脚本；插件需单独的启用与审计流程（NOTICE.md 第一节）。
