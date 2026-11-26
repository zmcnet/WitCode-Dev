# 05 — WitCode 学习报告

> 学习对象：ZCode 4.0.0（Apache-2.0）、DeepSeek Harness v0.2.3-alpha.2（MIT）、Magpie 0.1.4801（MIT）
> 方法：三份 release 源码全量解压（合计 53,382 个文件、约 520 万行主语言代码），五路并行深挖 + 主 Agent 交叉验证
> 目标：回答「WitCode 应该长什么样、该继承什么、该拒绝什么」
> 配套产物：`00-inventory.md` ~ `04-fusion-matrix.md`

---

## 1. 执行摘要

三个项目看起来是同类，实际上分属三个层次：

- **ZCode 是产品**：把 Coding Agent 做成可交付的桌面/Web/终端工作台，强在工程体系与扩展面。
- **DSH 是架构实验**：把 Agent Harness 做成微内核，强在可替换性与事件溯源。
- **Magpie 是控制面**：把「模型/账号/额度/路由」从各个 Agent 里抽出来，强在运营模型。

WitCode 的正确形态不是三者的功能并集，而是：

> **ZCode 的骨架 + DSH 的纪律 + Magpie 的控制面。**

本报告提炼出 **7 条最重要的认知**、**5 条三项目共同规律**、**10 条 WitCode 设计原则**。所有结论都能在 `01a`–`04` 中找到代码级证据。

---

## 2. 三个项目各自教会我们什么

### 2.1 ZCode：产品化是一门工程学科

ZCode 最值得学的不是某个功能，而是「如何让一个 200 万行的 Agent 项目不腐烂」。

**（1）权威内核 + 薄投影**
ZCode 把 CLI 定为唯一权威，桌面和 Web 只是投影：每 workspace 一个 `zcode-cli` 进程，Renderer 不持有权威会话，所有端通过 stdio NDJSON + V4 topic 消费同一份事实（`01a §4`）。这让「多端一致」变成架构必然，而不是同步逻辑的堆叠。

**（2）显式状态机**
Turn 不是散落在 `if/else` 里的流程，而是 `TurnPhase` 状态机：`processing_input → awaiting_model_response → streaming → scheduling_tools → executing_tools → aggregating_results → completing/error`，非法跃迁直接抛错（`01a §5.1`）。这让长流程可观测、可诊断、可测试。

**（3）工具契约把安全前置**
`ToolEntry` 的 `resolveInput` 在 hook 与权限判定**之前**把模型入参归一化为执行事实，从根上杜绝「批准 A、执行 B」（`01a §6.1`）。这比事后审计聪明得多。

**（4）三层扩展面**
组件层（skills/commands/hooks/MCP）、UI 层（MCP Apps + Electron 沙箱）、常驻扩展层（Extension Host）各自解决不同问题（`01b §2`）。但它也诚实地承认：Extension Host **不是安全边界**，所有扩展同进程、授权可冒充。这种「明确说出自己的边界」比假装安全更专业。

**（5）工程门禁是可执行的架构**
`architecture-policy.yaml`（2618 行）把「受管模块、四件套、依赖方向、深导入、文件体量」变成 pre-push 硬检查（`01b §10`）。105 条例外中 99 条是「只改上游一处、不接管整包」的务实豁免——这说明门禁不是摆设，而是真的在约束增量。

**（6）债务也值得学**
`turn.ts` 1210 行、`turn-model-step.ts` 982 行、`create-app.ts` 1692 行，注释在讲 bug 根因（`01a §10`）。这提醒 WitCode：**继承逻辑时不要连注释债务一起继承**，改造前先拆模块。

### 2.2 DSH：架构纪律比功能更值钱

DSH 的代码难以直接搬进 TypeScript 基线，但它的五条纪律可以直接注入。

**（1）Model-visible means logged**
每一个模型请求都必须能从会话日志重建。请求头、系统提示都进日志；compaction 是一次 `surfaceOp: replace`，因此 fork、resume、telemetry、上报全部免费（`02a §2`）。这是整份调研里**单条价值最高的设计**。

**（2）seam 必须是三角色闭环**
Service Definition + Service Provider + Consumer，缺一不成 seam（`02a §2`）。这防止了「只有接口没人用」的空抽象，也解释了 DSH 为什么有 30+ 个 seam 却不乱。

**（3）注册即 effect，卸载即回卷**
`ctx.on()`、`ctx.plugin()`、`ctx.tools.register()` 都自带 disposer（`02a §4`）。热重载、多租户隔离、插件卸载都靠这一条物理基础。

**（4）事件按「持久性」分域**
durable 的 `session/event`、live 的 `agent/*`、capability 的 `fs/*`/`tools/*` 三类严格分开（`02a §5`）。这比按「生命周期/内容/工具/流」分类更本质，因为它决定了什么能丢、什么不能丢。

**（5）能力协商优于版本判断**
ZCode 用 `extensionSummary` + 能力位 + 单点 strict schema 做跨版本兼容（`01b §11`）；DSH 用 `getHostCapabilities()` 做页面能力协商（`01b §5`）。两家独立得出同一结论：**不要按版本号猜能力**。

### 2.3 Magpie：控制面是独立产品

Magpie 证明了一件事：**模型管理不是设置页，而是一个独立的控制平面。**

**（1）五张表定义领域**
Agent / Provider / Account / Model / Group，加上 Route 轨迹与 Usage 记录（`03 §2`）。Agent 只知道「选了哪个 `provider/model`」，密钥与 URL 从不写进 Agent 配置。

**（2）只改一个键**
每个 Agent 一个适配器，声明配置文件路径、要改的 key、stash 恢复方式；格式保持编辑器只改请求的键，注释/顺序/缩进不变（`03 §5`）。这是「不接管用户配置文件」的产品信任基础。

**（3）路由是状态机，不是 if/else**
排序六步（可应答 → 策略 → 限流者靠后 → fallback → 休息者靠后 → 会话亲和）+ 故障转移状态机（429/5xx → 下一候选 → 休息计时）+ 透明性约束（未发出字节前可换）（`03 §6`）。这套语义比大多数「多 key 轮询」实现完整一个数量级。

**（4）配额分两套**
订阅额度窗口（5h/day/week/month/wallet）与网关 key 预算（token/费用，fail-closed）是两套体系（`03 §7`）。混在一起会同时得罪用户和运营。

**（5）协议转换按需**
`from == to` 时原生转发（保留厂商特有字段与缓存），只在协议不同才走 IR 翻译（`03 §4`）。这是性能与兼容的正确取舍。

---

## 3. 关键机制横向对比

| 机制 | ZCode | DSH | Magpie | 谁更值得学 |
|---|---|---|---|---|
| 真相源 | CLI + SQLite | 追加式 SessionEvent | providers.json + usage.jsonl | ZCode（可交付）/ DSH（可重放） |
| 扩展解耦 | 三层扩展面 | Cordis 服务注入 | 插件注册表 + JS 中间件 | DSH（最彻底） |
| 安全边界 | 承认 extension host 非沙箱 | approval fail-closed | key 预算 fail-closed | 三家都诚实，学「明确声明」 |
| 模型抽象 | ModelExecutor + option-map | LlmAdapter + prepareCall | 四协议 IR + 路由 | ZCode + Magpie 组合 |
| UI 扩展 | MCP Apps 沙箱页面 | 同 React 树 typed slot | 自有 WebView | ZCode（第三方）/ DSH（第一方） |
| 主题 | CSS 变量 + 4 套 token | 三层 token + 运行时注册 | 设置页 | DSH |
| 插件市场 | 四来源 + 能力协商 | 静态 index.json + 生成器 | 无 | ZCode（分发）/ DSH（生成器） |
| 工程门禁 | architecture-policy 硬检查 | 文档规范 + Cordis 纪律 | Go 单责 + AGENTS.md | ZCode |
| 编排 | subagent + workflow | team/goal/plan/schedule/jobs | 无 | ZCode（够用）/ DSH（更全） |
| 协议 | 自研 stdio + trace | 标准 ACP v1 | HTTP 网关 | ZCode（自有）/ DSH（生态） |

---

## 4. 七条最重要的认知

### 认知 1：「看起来完整」来自扩展面，不来自功能数量

ZCode 之所以像产品，不是因为它有 50 个工具，而是因为三件事同时成立：插件有清单与生命周期、UI 有 surface 协议、市场有来源与能力协商。**功能是内容，扩展面是容器；没有容器，内容越多越乱。**

### 认知 2：事件溯源的真实价值是「让所有派生操作同源」

DSH 的 compaction 不是「删消息」，而是日志上的一次可重放替换；因此 fork、resume、telemetry、上报全都不需要额外状态。**一个正确的真相源模型，能省掉后面十个子系统。**

### 认知 3：seam 三角色是防止空抽象的唯一办法

只有接口 + 默认实现 + 消费者同时存在，才叫 seam。ZCode 也有大量服务，但缺少这种显式纪律，导致「定义了没人用」的抽象更容易存活。**WitCode 给每个新服务强制填三角色表。**

### 认知 4：信任边界必须写进文档，而不是藏在实现里

ZCode 的 `NOTICE.md` 明说「共享 Agent 执行适配器不提供默认操作系统沙箱」；Extension Host 明说「不是安全边界」；DSH 的 `SAFETY.md` 明说「不要作为不可信工作负载的唯一安全控制」。**敢说自己不安全的项目，反而更容易被正确使用。**

### 认知 5：主题不是换颜色，是三层覆盖体系

DSH 把 token 分静态色阶 / 语义 alias / 组件 specific 三层，组件禁止直用静态色，第三方通过 source 叠加层参与（`02b §4`）。这样品牌定制、暗色模式、运行时动态配色三者不冲突。**ZCode 的 725 处 `--color-*` 已经证明了 token 化的价值，但缺少「第三方只叠加 alias」的纪律。**

### 认知 6：模型管理的本质是控制平面

Magpie 的 80+ Agent 适配、四协议网关、账号池、额度窗口、路由轨迹，任何一项都不是「设置页加个输入框」能覆盖的。**如果 WitCode 只做「填 API key」，就永远只是 ZCode 的换皮；做了控制面，才有独立价值。**

### 认知 7：换牌成本与功能开发同量级

8,056 处 `@zcode/*` 引用、4,579 个文件、675 个环境变量、1,753 处 `.zcode` 路径。机械替换 1–2 天，回归 1–2 周。**这不是「重构副产品」，而是一个必须排期的独立工作流。**

---

## 5. 三个项目的五条共同规律

1. **都有「权威事实源 + 投影」**：ZCode 是 CLI 权威/端投影；DSH 是日志权威/UI 投影；Magpie 是配置文件权威/网关投影。没有一家让多个端各自持权威状态。
2. **都把扩展当一等公民**：差异只在「扩展运行在哪里」——ZCode 三层、DSH 进程内、Magpie 网关插件。
3. **都有强工程纪律**：ZCode 用 YAML 门禁，DSH 用 Cordis 生命周期 + seam 纪律，Magpie 用 Go 单包单责 + `AGENTS.md`。规模越大，纪律越像代码。
4. **都明确声明不安全边界**：三份 NOTICE/SAFETY/README 都在说「不要把这东西当沙箱」。
5. **都支持多前端**：CLI/TUI、Desktop、Web 至少两种；说明「Agent 内核与表现层解耦」已是行业共识。

---

## 6. 对 WitCode 的十条设计原则

1. **单一事实源**：会话、配置、用量各只有一个权威存储；其他都是投影。
2. **先定契约再写实现**：插件清单、主题 token、市场 index、i18n key 四类 schema 先冻结。
3. **seam 三角色**：定义 / 实现 / 消费者缺一不立项。
4. **可逆注册**：任何注册都返回 disposer；卸载自动回卷。
5. **能力协商优于版本判断**：用能力位 + 单点 strict schema，不按版本号猜。
6. **主题只吃语义 token**：组件禁止硬编码颜色；第三方只叠加 alias 层。
7. **插件默认不可信**：信任边界写进文档与 UI；不可信插件禁用常驻扩展。
8. **配置分层且可 dump**：bundle → profile → home → CLI overlay，提供 `--dump-config`。
9. **换牌/迁移是产品需求**：兼容层、双读、一次性迁移都是一等公民。
10. **上游同步是一等公民**：git clone + upstream 分支 + 定期 diff；不要把 fork 变成孤岛。

---

## 7. 事实与证据索引

| 主题 | 产物 | 关键证据 |
|---|---|---|
| 素材完整性与合规 | `00-inventory.md` | 官方 main 逐字节一致；Apache-2.0 / MIT；SBOM 建议 |
| ZCode 内核 | `01a-zcode-core.md` | turn 状态机、ToolScheduler、SQLite session、ContextBuilder、ModelExecutor |
| ZCode 扩展与工程 | `01b-zcode-ext.md` | 三层扩展、MCP Apps、architecture-policy、市场四来源 |
| DSH 内核 | `02a-dsh-core.md` | Cordis、seam、事件分层、surface replace、compaction |
| DSH UI/开放性 | `02b-dsh-ui.md` | 主题三层 token、typed slot、市场生成器、i18n 双体系 |
| Magpie | `03-magpie.md` | 五张表、四协议 IR、路由状态机、额度模型、TS 接口草案 |
| 融合决策 | `04-fusion-matrix.md` | Adopt/Adapt/Reject、五个硬冲突裁决、换牌成本 |

---

## 8. 局限与待验证

1. 三份源码均为 release 快照，**无 git 历史**，无法判断某些设计是演进结果还是历史包袱。
2. ZCode 的部分行为依赖官方服务（Coding Plan、插件 CDN、账号体系），本地无法验证其真实契约。
3. DSH 处于 developer preview，`0.2.3-alpha.2` 的接口可能随时破坏；本报告只取其稳定纪律。
4. Magpie 的订阅登录路径涉及各厂商私有接口，未做实际登录验证；`03` 中已标注「待验证」。
5. 未执行任何项目的构建与运行验证；`00` 中的「可构建」结论基于依赖图闭合与锁文件完整性，不等于构建成功。
6. 性能数据（启动时间、内存、并发）未采集，需在 WitCode 立项后建立基线。

---

## 9. 一句话收束

> ZCode 告诉我们「产品要多完整」，DSH 告诉我们「架构要多可换」，Magpie 告诉我们「模型要多人管」。
> WitCode 的机会不在把三者拼起来，而在**用 ZCode 的完成度，承载 DSH 的可换性，解决 Magpie 所代表的多人多模型现实**。
