# 阶段 0：素材盘点与学习基线

> 学习对象：ZCode 4.0.0 / DeepSeek Harness (DSH) v0.2.3-alpha.2 / Magpie 0.1.4801
> 盘点日期：2026-11-26
> 源码根目录（下文简称 `$SRC`）：`D:\Files\Projects\WitCode\resources\src`
> 原始压缩包：`D:\Files\Projects\WitCode\resources\*.zip`（release 快照，**均无 `.git` 目录**，无法追溯提交历史）

---

## 1. 三个项目的量化事实

| 维度 | ZCode 4.0.0 | DSH 0.2.3-alpha.2 | Magpie 0.1.4801 |
|---|---|---|---|
| 许可证 | Apache-2.0 | MIT | MIT |
| 主语言 | TypeScript / TSX | TypeScript / TSX | Go 1.26.8 |
| 文件数 | 19,355 | 22,998 | 11,029 |
| 源码行数（主语言） | ~204.6 万 | ~170.6 万 | ~145.5 万 |
| 解压体积 | 248 MB | 206 MB | 192 MB |
| 包管理 | pnpm workspace | pnpm workspace + vendor | Go modules + `build/` |
| 运行形态 | CLI + TUI + Electron 桌面 + Web + 远程控制 | CLI + Electron 桌面 + Web + ACP | 菜单栏 App + GUI + TUI + Web UI + CLI + Docker |
| 上游定位 | Coding Agent 全栈产品（智谱 GLM 系） | 通用 Agent Harness（DeepSeek） | 本地模型网关 / 多 Agent 模型切换器（yetone） |
| 在 WitCode 中的角色 | **重构基线**（harness 与工程体系） | **插件、主题、开放性样板** | **模型/Provider 管理样板** |

> 行数统计包含测试、文档内嵌代码与部分生成物，仅用于判断量级，不作为精确指标。

---

## 2. 三个项目的结构真相

### 2.1 ZCode 4.0.0（基线）

完整 monorepo，**不是裁剪包**：

```
$SRC/ZCode-4.0.0/
├── apps/
│   ├── zcode-cli/          # Agent CLI 与运行时，内含 34 个独立包（core/tui/cli/adapters/各插件…）
│   └── dev-docs/           # 文档站
├── packages/               # 23 个包
│   ├── desktop/            # Electron main / host / renderer（完整）
│   ├── ui/                 # 共享 React 组件、hooks、Zustand store
│   ├── web/  server/  web-share/
│   ├── services/  rpc/  shared/  client/
│   ├── provider/  provider-node/  model-option-map/
│   ├── plugin-api/  design-runtime/  session-control/
│   └── zcode-cua/  android/  formal-proof/  stream-animate/  e2e-report/
├── docs/                   # 50+ 主题域文档（architecture/plugins/desktop/runtime-tools/…）
├── config/provider/        # 内置 provider 配置
├── architecture-policy.yaml# 128 KB 的架构约束（依赖方向、边界规则）
├── DESIGN.md               # 52 KB UI 设计规范
├── UI_PLUGIN.md            # 58 KB UI 插件开发规范
└── AGENTS.md / CONTEXT.md  # 工程约定与插件商店领域词汇
```

关键判断：
- **可直接二改的范围**：CLI harness、TUI、插件运行时、桌面端、Web 端、共享 UI 层全部在包内。
- **工程资产比代码更值钱**：`architecture-policy.yaml` + `DESIGN.md` + `UI_PLUGIN.md` + `AGENTS.md` 构成了一套「约束驱动」的开发体系。
- `apps/zcode-cli` 是独立 pnpm workspace（自己的 lockfile），可以单独构建成 SEA 单文件可执行程序。

### 2.2 DSH（插件 / 主题 / 开放性样板）

```
$SRC/deepseek-harness-dsh-v0.2.3-alpha.2/
├── apps/
│   ├── cli/  desktop/  desktop-host/  desktop-publisher/
│   ├── web/                # Web 前端
│   └── plugin-market-generator/
├── packages/               # 50+ 领域包，全部小写单词命名
│   ├── core/ boot/ host/ session/ llm/ connector/ acp/
│   ├── extensions/ guard/ sandbox/ credential/ identity/
│   ├── workflow/ goal/ plan/ subagent/ team/ schedule/ jobs/
│   ├── compaction/ spill/ context/ memory?/ skill/ todo/
│   ├── shell/ fs/ lsp/ mcp/ ssh/ terminal/ browser-use/ computer-use/
│   └── account/ attachment/ deliverable/ document/ preset/ settings/ storage/
├── native/system/          # 原生层
├── docs/                   # 架构、生命周期、能力 seam、Cordis 教程
└── vendor/                 # 三方依赖
```

关键判断：
- **微内核 + Cordis 依赖注入** 是 DSH 与 ZCode 最大的架构分野，值得逐层拆解。
- `docs/` 里的 `capability-seams.md`、`agent-lifecycle.md`、`cordis-primer.md` 是理解其开放性的钥匙。
- 插件市场有独立生成器（`apps/plugin-market-generator`），说明插件分发被当成一等公民。

### 2.3 Magpie（模型管理样板）

```
$SRC/magpie-0.1.4801/
├── internal/               # 100+ Go 包，按能力单包单责
│   ├── provider/ gateway/ routes/ upstream/ catalog/
│   ├── agent/ agentenv/ agentplug/          # 被管理的各类 Agent
│   ├── claudecode/ codexcat/ codexrelay/ claudetui/
│   ├── budget/ usage/ usageapi/ gwbudget/ rotation/
│   ├── masking/ pii/ redact/                # 密钥与隐私
│   ├── plugin/ pluginrt/                    # Go 插件机制
│   ├── settings/ settingsapi/ config dirs
│   └── tui/ gui/ webview2env/               # 多前端
├── plugins/                # 官方插件：routing/groups/rotation/budget/otel/redact/middleware…
├── site/                   # 官网与文档
├── docs/reference.md
├── LESSONS.md              # 作者踩坑记录（高价值）
└── go.mod
```

关键判断：
- 它不是 Agent，而是 **Agent 的「模型控制平面」**：改各 Agent 自己的配置文件 + 本地网关 + 账号/配额/路由。
- 对 WitCode 的价值不在代码规模，而在 **Provider 抽象、配置文件适配矩阵、故障转移与配额模型**。
- `LESSONS.md` 是最低成本的经验来源。

---

## 3. 学习阶段与产物索引

| 阶段 | 内容 | 产物 | 执行者 |
|---|---|---|---|
| 0 | 素材盘点与基线 | `00-inventory.md` | 主 Agent |
| 1a | ZCode 内核与运行时 | `01a-zcode-core.md` | 子代理 A1 |
| 1b | ZCode 扩展生态、UI 与工程体系 | `01b-zcode-ext.md` | 子代理 A2 |
| 2a | DSH 微内核与运行时 | `02a-dsh-core.md` | 子代理 A3 |
| 2b | DSH 插件、主题、UI 与开放性 | `02b-dsh-ui.md` | 子代理 A4 |
| 3 | Magpie 模型网关与 Provider 管理 | `03-magpie.md` | 子代理 A5 |
| 4 | 横向对比与融合映射 | `04-fusion-matrix.md` | 主 Agent |
| 5 | 汇总学习报告 | `05-learning-report.md` | 主 Agent |
| 6 | WitCode 架构与路线图 | `06-witcode-plan.md` | 主 Agent |

---

## 4. 合规与工程约束（先记下，后续方案必须遵守）

1. **ZCode 是 Apache-2.0**：允许修改、商用、闭源分发，但必须保留 `LICENSE`、`NOTICE.md`，并对修改过的文件加显著说明。`THIRD-PARTY-NOTICES.md` 需随分发保留。
2. **DSH 与 Magpie 是 MIT**：保留版权声明与许可文本即可，可闭源衍生。
3. **商标风险**：不能继续使用 `ZCode`、`DeepSeek`、`magpie` 的名称与图标做产品标识；WitCode 需独立命名、独立图标、独立包名（`@witcode/*`）。
4. **快照限制**：三份源码均无 git 历史，无法 cherry-pick 上游补丁；后续要建立自己的仓库与上游同步策略（vendor 目录 + 定期 diff）。
5. **不可信输入**：源码包来自网络下载，分析阶段只读不执行其脚本；构建前需先做依赖与脚本审计。

---

## 5. 对 WitCode 的初步结构性结论（待阶段 4 验证）

1. **基线选 ZCode 是对的**：它是三者中唯一同时具备「完整 harness + 桌面端 + Web 端 + 插件市场 + UI 插件协议」的产品级代码库。DSH 的 UI 与插件理念更开放，但整体换基线等于重写。
2. **DSH 的借鉴点应聚焦在「机制」而非「代码」**：微内核 seam、Cordis 式依赖注入、插件市场生成、主题 token 化、i18n 文件规范。
3. **Magpie 应该被「产品化吸收」而非「代码移植」**：Go 代码无法直接进 TypeScript 基线，但它的 Provider 数据模型、Agent 配置适配矩阵、路由/配额语义可以重写成 WitCode 的 `model-gateway` 包。
4. **最大风险不是技术，而是范围**：三个项目合计 500 万行，全量融合必然失控。必须定义「WitCode v0.1 的最小可运行闭环」，其余能力按插件/后续版本切分。

---

## 6. ZCode 素材完整性核验（2026-11-26 追加）

核验对象：`https://github.com/zai-org/ZCode/archive/refs/heads/main.zip`

| 核验项 | 结果 |
|---|---|
| 仓库身份 | `zai-org/ZCode`，描述 "Z.ai's coding agent harness. Powerful, intelligent, extensible."，Apache-2.0，8,920 stars / 2,791 forks |
| 默认分支 | `main`，最后推送 `2026-11-23T08:14:37Z`（与 v4.0.0 release 同一时点） |
| 归档大小 | 106.4 MB（zip）/ 248 MB（解压） |
| 文件清单 | main：19,355 个；本地 `ZCode-4.0.0`：19,355 个；**差异 0** |
| 逐文件 SHA-256 | **0 差异行（逐字节完全相同）** |
| workspace 包 | 58 个；`workspace:*` 依赖 110 条；**未解析 0 条**（依赖图闭合） |
| 构建素材 | `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`（10 个补丁）、`third-party/`、`public/`、`specs/` 均在 |
| 缺失项 | 无 `.git`（GitHub archive 固有）、无 `node_modules`（正常）、无 `.gitmodules`（无子模块） |

结论：
1. **本地这份 `ZCode-4.0.0.zip` 就是官方 main 分支的完整源码**，不是裁剪包，与 GitHub 归档逐字节一致，无需再下载其他包。
2. 「完整」需要分三层理解：
   - **源码完整**：✅ 58 个包依赖闭合，可用 Node 24 + pnpm 10.33 独立构建。
   - **产品完整**：⚠️ 桌面端、Web 端、服务端源码都在；但官方插件 CDN 内容、内置 provider 凭证、运营侧服务配置不属于仓库。
   - **历史完整**：❌ 无 `.git`，拿不到提交历史与 tag，无法 cherry-pick 上游修复。
3. 建议正式立项时改用 `git clone`（≈155 MB）而非 zip 解压，保留上游历史，便于建立「上游同步分支」。
4. 归档文件留存于 `resources/_incoming/zcode-main/`，仅用于本次核验，后续可删除。

---

## 7. 许可证与合规审计（2026-11-26）

| 项目 | 第一方许可 | 附加限制 | 第三方风险 |
|---|---|---|---|
| ZCode | Apache-2.0 | `NOTICE.md` 只有风险披露与第三方声明，**无竞品限制、无商用限制** | `THIRD-PARTY-NOTICES.md` 共 76,920 行；`GPL/LGPL/EPL/SSPL/BUSL` 关键词命中 94 处，多数为 dual-license 的可选分支（如 `jszip: MIT OR GPL-3.0-or-later`、`node-forge: BSD-3-Clause OR GPL-2.0`、`elkjs: EPL-2.0 OR GPL-3.0-or-later`），需在正式分发前做一次 SBOM 级审计 |
| DSH | MIT | `SAFETY.md` 仅为实验状态与免责声明 | `THIRD_PARTY_NOTICES.md` 仅 332 行；LGPL-3.0（`eslint-plugin-sonarjs`）与 MPL-2.0（`lightningcss`）**只用于开发工具，不进入分发产物** |
| Magpie | MIT | 无 | `third_party/` 仅 `jsonschema`、`yaml.v3`；未检出 copyleft |

结论与动作：

1. **WitCode 自身采用 Apache-2.0 最稳妥**：可吸收 Apache-2.0（ZCode）与 MIT（DSH/Magpie）代码，同时保留专利授权条款。
2. 分发时必须保留：ZCode 的 `LICENSE` + `NOTICE.md` + `THIRD-PARTY-NOTICES.md`；DSH 的 `LICENSE` + `THIRD_PARTY_NOTICES.md`；Magpie 的 `LICENSE`。
3. 修改过的 ZCode 文件需按 Apache-2.0 §4(b) 加「已修改」说明；建议在文件头统一加 `// Modified for WitCode` 或维护 `CHANGES.md`。
4. **商标隔离**：产品名、包名（`@witcode/*`）、图标、应用 ID、数据目录（`~/.witcode`）全部独立；文档中只能以「基于 ZCode / 参考 DSH / 参考 Magpie」的事实性描述出现，不使用其 Logo。
5. 建议在 CI 增加 `license-audit` 任务：生成 SPDX SBOM，阻断新增 AGPL/SSPL/BUSL 依赖。

