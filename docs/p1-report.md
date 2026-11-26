# P1 交付报告

> 日期：2026-11-26
> 目标：从「能聊天」到「能看、能改、能跑、能记住」
> 结论：**P1 完成**。59 个单测 + 3 个 e2e 全绿，前后端可运行。

---

## 1. 团队与交付

| 角色 | 负责 | 交付 | 验收 |
|---|---|---|---|
| 总管 | 契约、工作循环、项目记忆、服务端集成 | `agent-loop.ts`、`project-memory.ts`、`server/index.ts` | 3 个 e2e 通过 |
| Coding-1 | 会话存储 | `packages/session`：SQLite、事务、旧库迁移、`tool_calls` 往返 | 12 测试 |
| Coding-2 | 工具系统 | `packages/tools`：注册表 + 5 个工具 + 路径安全 | 19 测试 |
| Coding-3 | 模型与前端 | `packages/model`：OpenAI 兼容 SSE；`apps/web`：工作台 + history 回放 | 8 + 1 测试，build 通过 |
| Test-1 | 单元测试 | kernel 16 用例，发现并固化 2 个内核缺陷 | 16/16 |
| Test-2 | 端到端 | 3 个 e2e：流式、取消、工具链路 | 3/3 |
| Visual-1 | 视觉验收 | 63 条清单 + 12 条评审 + Playwright 脚本 | 已纳入待修 |

---

## 2. 验收数字

| 项目 | 结果 |
|---|---|
| 全量 `typecheck` | 8 个包全部通过 |
| 单元测试 | 59 通过 / 0 失败 |
| e2e | 3 通过 / 0 失败 |
| Web 构建 | 通过 |
| 服务端启动 | 正常（5 个工具已注册） |

---

## 3. 集成中发现并修复的问题

这些问题不是「写错了」，而是「单独看都对，拼起来才暴露」：

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | assistant 的 `toolCalls` 没落库 | 恢复会话后 OpenAI 报 `tool message without preceding tool_calls` | 打回 Coding-1：加 `tool_calls` 列 + 旧库迁移 + 3 个测试 |
| 2 | 取消有竞态 | `cancel` 到达时 `aborter` 还没创建，中断失效 | 在第一个 `await` 之前建立取消作用域 |
| 3 | e2e 复用真实数据库 | 剧本模型看到历史里的工具结果，跳过工具调用 | e2e 使用独立 `WITCODE_DATA_DIR` |
| 4 | 内核两个缺陷 | 排队插件加载后无法卸载；`apply` 抛错时服务泄漏 | 修复 `plugin()` 的 disposer 与 `load()` 的回滚 |
| 5 | kernel 导出 `.js` | Node 原生加载找不到文件 | 改为 `.ts`，根 tsconfig 开启 `allowImportingTsExtensions` |
| 6 | 后台服务进程叠了多层 | 端口占用、孤儿进程 | 清理进程树，改为单进程直接启动 |

---

## 4. 已知限制（不阻塞 P1）

| 限制 | 影响 | 计划 |
|---|---|---|
| 路径安全是词法的 | 指向 workspace 外的符号链接可绕过 | P4 加 `realpath` 校验 |
| `tool-result` 没有 call id | 同名工具并发时前端可能错配 | P2 协议补 `id` |
| 无自动重连 | 断网后需手动刷新 | P4 |
| 无权限确认 | 危险命令直接执行 | P4 |
| Web 无 Markdown 渲染 | 代码块按纯文本显示 | P4 |
| `node:sqlite` 实验警告 | 仅日志噪音 | 跟随 Node 版本 |
| 订阅账号/额度/路由 | 未做 | P2 |

---

## 5. 现在能演示什么

1. 打开 http://localhost:5173，左侧会话列表、右侧对话。
2. 说「看看这个项目是干嘛的」：模型调 `read_file`/`list_dir`，工具卡片出现，结果可展开。
3. 说「把 README 第一行改掉」：`read_file` → `write_file`，落库。
4. 刷新页面：历史消息、工具卡片全部回放。
5. 断网/取消：按钮恢复，不再卡「生成中」。

---

## 6. 下一步（P2）

1. 模型管家：Provider / Account / Model / Group / Allowance 五张表。
2. 路由：smart / order / rotate，失败切换。
3. 用量：每次请求的 in/out/cost/ttft。
4. 设置页：Providers / Models / Groups / Usage 四页。

P2 不碰内核，只加一个 `model-gateway` 包和设置页。
