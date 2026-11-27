# DSH 内置能力 vs WitCode 覆盖表

> 来源：DeepSeek Harness v0.2.3-alpha.2 源码盘点（2026-11-26）
> 用途：回答「DSH 内置了哪些东西、WitCode 还差什么」

## 1. DSH 的 bundle 结构

| Bundle | 内容 | 默认 |
|---|---|---|
| `dsh-base` | llm、session、tools、fs/shell、sandbox、approval、web、skill、subagent、todo、goal、plan、compaction、jobs、agent-team、workflow | ✅ |
| `dsh-web-app` | Host/客户端 UI、schedule、mcp-manager、plugin-manager、remote-connection、deliverables | ✅（web 模板） |
| `headless` / `acp-app` / `sdk-app` / `sdk-minimal` | 无头 / ACP / JSON-RPC / 裁剪工具面 | 各自模板 |
| 17 个 optional | cua、timeline、session-search、ralph、terminal、voice、cot-translation、auto-review、liveshare、plugin-market、worktree、forge 等 | ❌ 默认关 |

## 2. DSH 内置插件（base + web-app）

| 能力 | 插件 / 工具 | WitCode 状态 |
|---|---|---|
| 文件读写搜 | `read`/`write`/`edit`/`apply_patch`/`read_image`；`glob`/`grep` | 部分：read/write/list/grep 已有；edit/apply_patch/glob 本轮补齐 |
| Shell | `bash`/`pwsh`（含后台） | 部分：`run_command` 已有；后台 job 本轮补齐 |
| 后台任务 | `job_output`/`job_list`/`job_kill` | 本轮补齐 |
| 权限 | sandbox-policy、user-approval、permission-presets | ✅ 四档权限 + 路径/命令守卫 + 确认弹窗 |
| 会话 | session、持久化、标题、compaction、`/compact`、`/export` | 部分：SQLite 持久化/归档已有；compact 有 summary/acp；本轮补 session_search/session_export 工具 |
| 上下文 | agent-instructions、time-context、session-reference、skill | 部分：项目记忆/个性化/skills 已有；session/file reference 未做 |
| Agent | agent-loop、default-model、plan-mode、goal、subagent、agent-team、workflow | 部分：loop/子智能体/goal 已有；workflow 本轮补最小脚本编排；team 未做 |
| Todo | `todo_write`（整表替换）+ 输入框上方面板 | ✅ 本轮补齐 |
| Web | `web_search`/`web_fetch`（provider 可插拔） | ✅ 本轮补齐（DDG 搜索 + 安全 fetch） |
| MCP | mcp-client、mcp-manager、resources | ✅ 本轮补齐（stdio + 设置页） |
| 插件管理 | plugin-manager + 市场 | ✅ 内置能力包 + Brain JSON + 代码插件（本地安装/启停/卸载/配置 schema/右栏面板）；市场未做 |
| 定时 | schedule + tool-schedule（once/after/at/cron 等） | ✅ 本轮补齐（every/daily 自动化） |
| 设置 | schema→表单引擎（describe/update/mutate + revision） | 部分：手写设置页；schema 引擎未做 |
| 技能 | skill + filesystem + tool-skill | ✅ 本轮补齐（本地 CRUD + use_skill） |
| 斜杠命令 | command 插件 | ✅ 本轮补齐 |
| Hooks | hooks-claude-code / hooks-codex（实验性，未进 bundle） | ✅ 本轮补齐（Pre/PostToolUse/Stop/SessionStart） |
| 浏览器 | browser-use 注册位 + Playwright/Chrome DevTools/Stagehand provider | 未内置；可通过 MCP 接入 Playwright MCP |
| 终端 | terminal 面板 / 持久 shell | ✅ 右栏 PTY（node-pty）+ 文件/Git dock |
| 长期记忆 | **没有**长期记忆/向量库；只有 AGENTS.md、skills、session_query | ✅ WitCode 更强：项目记忆 + 个性化注入 |
| 分享 / 远控 | liveshare、remote-connection、ssh | 不适用（无账号/分享服务端） |
| 账号 / 计费 / 遥测 | deepseek-account、llm-deepseek-*、product-telemetry | 不适用 |

## 3. 本轮补进 WitCode 的 DSH 内置能力

| 能力 | 落点 | 说明 |
|---|---|---|
| Todo | `apps/server/src/todos.ts` + `TodoDock` | `todo_write` 整表替换、按 session 落盘、输入框上方进度条 |
| Web | `apps/server/src/web-tools.ts` | `web_fetch`（SSRF 防护/重定向逐跳校验/HTML→文本）、`web_search`（DDG，可替换） |
| 自动化 | `apps/server/src/automations.ts` + `AutomationsPanel` | `every 15m` / `daily 09:30`，到期交子智能体执行，状态/下次运行时间 |
| Hooks | `apps/server/src/hooks.ts` + `HooksPanel` | PreToolUse/PostToolUse/Stop/SessionStart；exit 2 阻断工具；超时杀进程树 |
| 子智能体模型 | `AppSettings.subagentModel` + 设置页 | 子智能体可独立选模型，默认跟随主会话 |
| 文件编辑 | `apps/server/src/file-tools.ts` | `edit_file` / `apply_patch` / `glob` |
| 后台任务 | `apps/server/src/jobs.ts` | `run_background` / `job_output` / `job_list` / `job_kill` |
| 目标 | `apps/server/src/goals.ts` | `set_goal` / `get_goal` / `update_goal` |
| 会话检索/导出 | `packages/session` + `apps/server/src/session-tools.ts` | `session_search` 跨会话搜索、`session_export` Markdown/JSON |

## 4. 仍未对齐的（有意识取舍）

- **workflow**：已补最小脚本编排（agent/ask/phase/artifact + 右栏阶段/产物）；DAG/hole/问题/缓存重放未做。
- **agent-team / liveshare / remote / share / account / telemetry**：产品专属，不适用。
- **浏览器**：DSH 也只是注册位；WitCode 通过 MCP 接 Playwright MCP 即可。
- **交互式终端、文件侧栏**：已补（PTY + 文件/Git/工作流 dock）。
- **turn outline / 会话引用**：后续做（session_search/export 已补）。
- **settings schema 引擎**：当前手写面板，能力接入成本略高，但功能已覆盖。
