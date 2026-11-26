# WitCode 全流程截图

> 生成方式：`node tools/screenshot-flow.mjs`（Playwright + Chromium，1440×900，移动端 390×844）
> 说明：截图会临时添加一个演示 provider，脚本结束自动恢复 `~/.witcode/providers.json`
> 状态：P2 完成时

## 流程与结论

| # | 文件 | 流程 | 结论 |
|---|---|---|---|
| 01 | `01-home.png` | 首页 | 正常。左侧会话列表，历史会话回放（含 P1 工具测试的对话），顶栏显示 echo 模型 |
| 02 | `02-new-session.png` | 新建会话 | 正常。消息区清空，会话列表新增条目 |
| 03 | `03-chat.png` | 发消息 | 正常。用户气泡 + 助手流式回复，状态栏显示连接/模型/会话 |
| 04 | `04-settings-providers-empty.png` | 设置页空态 | 正常。Providers 空态提示清楚 |
| 05 | `05-provider-form-empty.png` | 新增表单 | 正常。五个字段 + 启用开关 + 保存/取消 |
| 06 | `06-provider-form-errors.png` | 空提交校验 | 正常。三条红字 + 输入框红边 |
| 07 | `07-provider-form-filled.png` | 填写表单 | 正常。演示数据填入 |
| 08 | `08-provider-saved.png` | 保存成功 | 正常。卡片出现，API Key 显示 `sk-s...3456`（脱敏），模型数 2 |
| 09 | `09-model-menu.png` | 模型选择器 | 正常。列出两个模型，可切换 |
| 10 | `10-usage.png` | 用量页 | 正常。总请求 / token / 按 provider 分组 / 最近记录（echo 兜底调用被如实记录） |
| 11 | `11-delete-confirm.png` | 删除确认 | 正常。页内弹层，不是浏览器原生 confirm |
| 12 | `12-mobile-chat.png` | 移动端聊天 | 正常。侧栏抽屉化，消息区全宽（390），气泡 308 宽，输入框与发送按钮同行 |
| 13 | `13-mobile-settings.png` | 移动端设置 | 正常。单列布局，卡片完整 |

## 移动端问题与修复（已闭环）

首轮截图发现：390×844 下 `.sidebar` 仍占约 200px，消息区被挤成窄缝、文字逐字换行、输入框只剩细线。

修复后（`mobile-after.png` 为修复过程截图，`12-mobile-chat.png` 为最终版）：

| 验收项 | 修复前 | 修复后 |
|---|---|---|
| 侧栏 | 固定占 200px | 抽屉，默认 `translateX(-100%)`，header「会话」按钮打开 |
| 消息区宽度 | 约 150px | 390px |
| 助手气泡宽度 | 逐字换行 | 308px |
| 状态栏 | 竖排挤压 | 只留连接 + 模型，会话 id 隐藏 |
| 输入区 | 细缝 | textarea 290px + 按钮 68px 同行 |
| 关闭方式 | — | 遮罩点击 / Esc，焦点回到「打开会话列表」 |

## 复现

```bash
# 前置：server 8787 + web 5173 均在运行
node tools/screenshot-flow.mjs
```

## 备注

- 聊天回复来自 echo 兜底模型（当前未配置真实 provider）。
- 用量页里的 `echo / fallback` 是兜底调用，不是错误。
- 截图中的会话来自本地 SQLite，包含之前测试留下的记录。
