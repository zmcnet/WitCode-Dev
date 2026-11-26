# WitCode

一个 Web 优先的 Coding Harness：内核只负责插拔，能力都是插件。

> 当前状态：**可用**。Brain 插件宿主、模型管家、四档权限、上下文压缩、伙伴/子智能体、Web 工作台都已跑通。

---

## 跑起来

```bash
# 需要 Node >= 22 和 pnpm 10
pnpm install

# 终端 1：服务端（把 workspace 指到你要操作的项目）
WITCODE_WORKSPACE=/path/to/your/project pnpm dev:server

# 终端 2：Web 工作台（开发模式，HMR）
pnpm dev:web
```

开发模式浏览器打开 http://localhost:5173（`/ws` 自动代理到服务端的 21004）。

### 单端口部署（内网穿透用这个）

构建后由服务端在 **同一端口同时提供页面与 WebSocket**，穿透只需映射 21004：

```bash
pnpm --filter @witcode/web build
WITCODE_WORKSPACE=/path/to/your/project pnpm --filter @witcode/server start
```

浏览器/穿透域名直接访问 `http://<host>:21004` 即可，无需再开 Vite。
服务端默认端口 21004，可用 `PORT` 覆盖。

### 配置模型

打开 **设置 → Providers → 添加提供商**，填：

- 名称（随便起）
- Base URL（如 `https://api.deepseek.com/v1`）
- API Key
- 模型列表（逗号分隔，如 `deepseek-chat, deepseek-reasoner`）
- 上下文窗口（tokens，**硬性 ≥1M**；输出统一强制 128K）

保存后回到聊天，顶部选择模型即可。

任何 OpenAI 兼容服务都可以：DeepSeek、GLM、中转站、本地 Ollama。

### 环境变量兜底

不配置提供商时，服务端仍可用环境变量启动一个兜底模型：

```bash
WITCODE_BASE_URL=https://api.deepseek.com/v1
WITCODE_API_KEY=sk-...
WITCODE_MODEL=deepseek-chat
```

一个都没有时，退回回声模型，界面会提示。

### 开发用剧本模型

不花 token，验证「模型 → 工具 → 结果 → 再想」：

```bash
WITCODE_MODEL_MODE=scripted pnpm dev:server
```

---

## 现在有什么

| 能力 | 状态 |
|---|---|
| 流式聊天 / 取消 | ✅ |
| 工具：`read_file` / `write_file` / `list_dir` / `grep` / `run_command` | ✅ |
| 工具调用内联摘要（可展开、成功/失败） | ✅ |
| 会话持久化（SQLite，刷新/重连回放） | ✅ |
| 项目记忆（自动扫描 + `.witcode/memory.md`） | ✅ |
| 模型管家：多提供商、路由、失败切换、用量 | ✅ |
| **模型硬约束**：上下文窗口 ≥1M、输出强制 128K | ✅ |
| **Brain 插件**：15 个脑子（3 官方 + 12 参照），会话级可选 | ✅ |
| **四档权限**：只读 / 普通 / 自主 / 全部 + 确认弹窗 | ✅ |
| **上下文内核**：off / summary / acp 三模式（1M = 800K 会话 + 200K 脑子） | ✅ |
| **伙伴**：2 个槽位、只读、独立脑子与模型、共享完整历史 | ✅ |
| **子智能体**：独立会话、权限透传、最多 3 层 | ✅ |
| 单端口部署：页面 + `/ws` 同在 21004 | ✅ |
| 右栏文件/Git/终端面板 | ⏳ |
| 插件安装 / 市场 / 主题 | ⏳ |

---

## 架构

```
packages/
├── kernel/          # 插座板：服务容器 + 插件生命周期 + 事件
├── protocol/        # 前后端共享协议（消息/工具/会话/模型/脑子/协作）
├── session/         # SQLite 会话存储
├── tools/           # 工具注册表 + 5 个内置工具
├── model/           # 模型网关：Provider / 路由 / 用量 / 选型
├── brains/          # Brain 插件：3 官方 + 12 参照
├── context/         # 上下文压缩（off / summary / acp）
├── security/        # 路径/命令守卫 + 四档权限 + 审计
└── plugins/
    └── echo/        # 回声模型（兜底）
apps/
├── server/          # HTTP + WebSocket + 工作循环 + 伙伴/子智能体
└── web/             # React 工作台
```

内核只做四件事：**注册服务、加载插件、发事件、卸载清理**。

插件就是一个带名字的 `apply(ctx)`：

```ts
export const myPlugin: Plugin = {
  name: 'my-plugin',
  inject: ['model'],
  apply(ctx) {
    ctx.provide('tools', { ... });
    ctx.on('message', ...);
    // 插件卸载时，上面注册的东西自动清理
  },
};
```

---

## 工作循环

```
用户输入
  ↓
拼 system prompt（人格 + 项目记忆）
  ↓
┌─→ 调模型（流式）
│     ├─ 有文本 → 推给浏览器
│     └─ 有工具调用 → 执行工具 → 结果回给模型
└─────┘（最多 20 轮）
  ↓
落库（assistant + tool 消息）
  ↓
完成
```

---

## 测试

```bash
pnpm -r typecheck          # 全量类型检查
pnpm -r test               # 单元测试
cd apps/server && node --test e2e/*.test.mjs   # 端到端（5 个用例）
```

当前：**129 个单测 + 5 个 e2e 全绿**。

---

## 设计规矩

1. 内核不超过 1000 行。
2. 任何能力先问：能不能做成插件？
3. 插件注册的一切必须可撤销。
4. 前后端只通过 `protocol` 包通信。
5. 每个阶段必须有可运行的验收。

---

## 路线

| 阶段 | 目标 | 状态 |
|---|---|---|
| P0 | 骨架：内核 + Web + 流式链路 | ✅ |
| P1 | 脑子和手：工作循环 + 工具 + 会话 + 真实模型 | ✅ |
| P2 | 模型管家：提供商 / 路由 / 失败切换 / 用量 | ✅ |
| P3 | Brain 宿主：脑子库 + 上下文内核 + Web 工作台 | ✅ |
| P4 | 执行与安全：四档权限 + 路径/命令守卫 + 确认 | ✅ |
| P5 | 协作：伙伴槽位 + 子智能体（3 层） | ✅ |
| P6 | 插件生态：安装 / UI 面板 / 主题 / 市场 | 待开始 |
| P7 | 打磨与发布 | 待开始 |

详见 [docs/study/07-plan-v2.md](docs/study/07-plan-v2.md)。

---

## 与三个参照项目的关系

WitCode 是全新实现，不 fork、不复制代码，只参考设计：

- **ZCode**：Agent 的工作循环、工具契约、上下文管理
- **DeepSeek Harness**：万物插件、事件分层、能力 seam
- **Magpie**：提供商 / 账号 / 额度 / 路由

学习档案在 [docs/study/](docs/study/)。

---

## 许可

[Apache-2.0](LICENSE)。
