# WitCode 学习档案

> 建立时间：2026-11-26
> 学习对象：ZCode 4.0.0、DeepSeek Harness v0.2.3-alpha.2、Magpie 0.1.4801
> 目的：为「以 ZCode 为基线重构 WitCode」提供事实、判断与路线图

---

## 阅读顺序

| 顺序 | 文件 | 内容 | 适合谁 |
|---|---|---|---|
| 1 | [00-inventory.md](./00-inventory.md) | 素材盘点、ZCode 完整性核验、许可证审计 | 所有人，先看这个 |
| 2 | [01a-zcode-core.md](./01a-zcode-core.md) | ZCode 内核：进程、Agent Loop、Tool、Session、Context、Provider、协议 | 做内核改造的人 |
| 3 | [01b-zcode-ext.md](./01b-zcode-ext.md) | ZCode 扩展：三层插件、UI 协议、主题、桌面进程、工程门禁、市场 | 做插件/UI 的人 |
| 4 | [02a-dsh-core.md](./02a-dsh-core.md) | DSH 微内核：Cordis、seam、事件分层、compaction、编排、ACP | 做架构的人 |
| 5 | [02b-dsh-ui.md](./02b-dsh-ui.md) | DSH 插件/主题/UI/i18n/开放性 | 做 UI 与生态的人 |
| 6 | [03-magpie.md](./03-magpie.md) | Magpie：领域模型、四协议网关、路由、配额、TS 接口草案 | 做模型控制面的人 |
| 7 | [04-fusion-matrix.md](./04-fusion-matrix.md) | 横向对比、Adopt/Adapt/Reject、五个硬冲突裁决、换牌成本 | 决策者 |
| 8 | [05-learning-report.md](./05-learning-report.md) | 学习报告：七条认知、五条共同规律、十条设计原则 | 所有人 |
| 9 | [06-witcode-plan.md](./06-witcode-plan.md) | 架构蓝图、四阶段路线图、WBS、门禁、本周行动 | 所有人 |

---

## 一页结论

```
WitCode = ZCode 的骨架 + DSH 的纪律 + Magpie 的控制面
```

| 来源 | 拿什么 | 不拿什么 |
|---|---|---|
| ZCode | 全部工程实现、CLI/TUI/Desktop/Web、插件与市场、Skills、门禁、i18n | 105 条架构例外、Upstream 快照、品牌资产 |
| DSH | 事件分层、seam 三角色、可逆 effect、配置分层、能力协商、主题三层 token、市场生成器 | Cordis 运行时、Linux 原生层、DeepSeek 私有字段 |
| Magpie | Provider/Account/Group/Allowance、四协议 IR、路由与故障转移、Usage 模型 | Go 实现、80+ Agent 适配、订阅反代、1.6GB PII 模型 |

**四个版本：** v0.1 叫 WitCode 且能跑（6 周）→ v0.2 模型控制面（5 周）→ v0.3 开放生态（5 周）→ v0.4 内核纪律（8 周）→ v1.0（4 周）。

---

## 三个必须记住的数字

| 数字 | 含义 |
|---|---|
| **8,056** | `@zcode/*` 引用处数，分布在 4,579 个文件；换牌是独立工作流，不是重构副产品 |
| **675** | 不同的 `ZCODE_*` 环境变量；必须做双读兼容 |
| **1,753** | `.zcode` 路径出现次数；数据目录迁移要一次性完成 |

---

## 素材位置

| 内容 | 路径 |
|---|---|
| 原始 release 包 | `resources/*.zip` |
| 解压源码（分析用） | `resources/src/{ZCode-4.0.0, deepseek-harness-..., magpie-...}` |
| 官方 main 归档（完整性核验用） | `resources/_incoming/zcode-main/`（可删除） |
| 依赖闭合校验脚本 | `tools/check-workspace-closure.mjs` |

---

## 复现方法

```bash
# 校验 ZCode 工作区依赖闭合
node tools/check-workspace-closure.mjs resources/src/ZCode-4.0.0
# 期望：workspace packages: 58 / workspace:* deps: 110 / unresolved: 0
```

---

## 局限

1. 三份源码均为 release 快照，**无 git 历史**。
2. 未执行任何项目的构建与运行验证；「可构建」结论基于依赖图闭合与锁文件完整性。
3. 性能数据（启动、内存、并发）未采集，需在立项后建立基线。
4. ZCode 的部分行为依赖官方服务（Coding Plan、插件 CDN、账号体系），本地无法验证。
5. DSH 处于 developer preview，接口可能随时破坏；本档案只取其稳定纪律。
