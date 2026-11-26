# P2 交付报告：模型管家

> 日期：2026-11-26
> 目标：多提供商、按顺序/轮换路由、失败切换、用量可见、设置页可管理
> 结论：**P2 完成**。88 个单测 + 4 个 e2e 全绿。

---

## 1. 团队与交付

| 角色 | 负责 | 交付 | 验收 |
|---|---|---|---|
| 总管 | 协议、包拆分、网关组合、服务端集成 | `protocol` 扩展、`gateway.ts`、server 装配 | 4 条 e2e |
| Coding-1 | Provider 注册表 | `registry.ts`：原子写、0600、损坏备份、key 脱敏、input 合并 | 7 测试 |
| Coding-2 | 路由与用量 | `router.ts` / `usage.ts`：order/rotate、失败切换、selection、JSONL 用量 | 18 测试 |
| Coding-3 | 设置页 | 顶栏选择器、Providers/Usage 两 tab、768 适配 | typecheck/build/test |
| Test-1 | 网关组合测试 | CRUD、脱敏、selection 注入与持久化、删除联动、兜底、失败切换用量 | 8 测试 |
| Test-2 | 端到端 | 两个真实 HTTP mock provider：A 恒 500、B 正常 SSE | 1 e2e（4 条链路） |
| Visual-1 | 设置页验收 | 15 条评审 + 61 条清单 + Playwright 脚本 | 4 个 P0 已修复闭环 |

---

## 2. 验收数字

| 项目 | 结果 |
|---|---|
| 全量 typecheck | 8 个包通过 |
| 单元测试 | 88 通过 / 0 失败 |
| e2e | 4 通过 / 0 失败 |
| Web 构建 | 165 KB（gzip 52.7 KB） |
| P1 回归 | 3 条 e2e 全部通过 |

单测分布：kernel 16、session 12、tools 19、model 40、web 1。

---

## 3. 集成中发现并修复的问题

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | `types.ts` 没有重导出 `UsageRecord` | router 编译失败 | 补重导出 |
| 2 | `createProvider` 只能按 provider 创建，不能指定模型 | Selection 只能选每个 provider 的第一个模型 | 签名改为 `(provider, model)`，并通知路由负责人 |
| 3 | 网关硬编码 OpenAI 适配器，无法注入假 provider | 组合层无法单测 | `GatewayOptions.createProvider` 注入点 |
| 4 | 用量同毫秒排序不稳定 | 失败切换的两条记录在界面上乱序 | 按 `(at, 写入顺序)` 倒序 |
| 5 | 删除当前 selection 指向的 provider | 下一次请求指向不存在的 provider | 删除后自动清空 selection |

---

## 4. 视觉返工（P0 闭环）

Visual-1 审出 4 个 P0，全部打回 Coding-3 修复并复验：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 设置页没有错误 / 断线通道，保存失败静默 | 错误条提到 App 级，设置页也显示；断线有提示 |
| 2 | 点保存立即关表单，失败无提示，删除可连点 | `saving` / `deletingId` 状态；成功才关表单，失败保留并提示；请求号 + 内容配对 + 超时防旧回包 |
| 3 | `modelIds` 可空提交 | name / baseUrl / modelIds 三者 trim 后非空，至少一个模型 |
| 4 | 只有 HTML5 `required`，无可见错误 | 字段级错误文案 + `aria-invalid` + `role="alert"`；URL 必须是 http(s) |

顺带修了 4 个 P1：页内删除确认、Esc 关闭与焦点归还、设置 tab 保持、长文本省略 + `title`。

## 5. 路由语义（最终）

- **order**：按 provider 保存顺序，每个用 `modelIds[0]`。
- **rotate**：从上次成功的下一个开始，成功后推进。
- **selection 指定**：只走该 provider/model，失败**不切换**，直接报错。
- **失败切换**：只在「还没产出任何 text/tool-call」时切换；`abort` 不算失败。
- **兜底**：没有任何可用 provider → 环境变量 provider → 回声。

每次尝试（含失败）都写一条 usage。

---

## 6. 已知限制（不阻塞 P2）

| 限制 | 影响 | 计划 |
|---|---|---|
| 无费用估算 | 只统计 token，不显示花费 | P2.1 加价格表 |
| 无预算拦截 | 不能设「本月最多花多少」 | P2.1 |
| 无订阅账号 | 只支持 API key | 不做（ADR 0006） |
| 无模型自动发现 | modelIds 手填 | P2.1 可加 `/models` 探测 |
| 删除确认用 `window.confirm` | 样式不统一 | P4 |
| 无自动重连 | 断网后刷新 | P4 |

---

## 7. 现在能演示什么

1. 设置 → Providers → 添加 DeepSeek 和 GLM 两个提供商。
2. 顶栏选 `DeepSeek / deepseek-chat`，聊天正常。
3. 把 DeepSeek 的 key 改错，再发消息：
   - 不设置 selection 时，自动切到 GLM，用户无感；
   - 明确选择 DeepSeek 时，直接报错，不偷偷切换。
4. 设置 → Usage：看到总请求、总 token、按 provider 分组、最近记录。
5. 删除当前选中的 provider：selection 自动清空，不会指向空气。

---

## 8. 下一步（P3）

1. 插件安装/卸载/启停（本地目录 + 链接）。
2. 界面插件：iframe 沙箱，侧栏面板。
3. 主题：token 化，热切换。
4. 插件市场：静态 `index.json` + 生成器。

P3 不碰内核，只加 `packages/plugins-host` 与前端面板宿主。
