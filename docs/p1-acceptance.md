# P1 验收单（总管版）

> 用途：集成时逐条打勾，不靠“感觉做完了”。
> 状态：待验收 / 通过 / 打回

## A. 会话（Coding-1）

- [ ] 创建会话返回 id、标题、时间
- [ ] 追加 user / assistant / tool 消息后能按顺序读回
- [ ] 关闭进程重开，数据仍在
- [ ] 列表按最近更新倒序
- [ ] 重命名生效
- [ ] 删除会话时消息一起删
- [ ] `pnpm --filter @witcode/session test` 通过

## B. 工具（Coding-2）

- [ ] `read_file` 返回带行号内容，超长截断
- [ ] `write_file` 自动建目录，返回字节数
- [ ] `list_dir` 区分文件/目录并带大小
- [ ] `grep` 跳过 node_modules/.git/dist，最多 100 条
- [ ] `run_command` 返回 exitCode + stdout + stderr，超时被杀
- [ ] 路径逃逸（`../../etc`）被拒绝
- [ ] 工具抛错转成 `{ ok:false, error }`，不崩服务
- [ ] `pnpm --filter @witcode/tools test` 通过

## C. 模型与前端（Coding-3）

- [ ] OpenAI 兼容流式解析：文本增量正确
- [ ] `tool_calls` 增量能聚合成完整调用
- [ ] HTTP 非 2xx / 流中断变成 `error` chunk
- [ ] 没配 key 时界面提示，不崩
- [ ] 前端有左侧会话列表（可折叠）
- [ ] 工具调用卡片可折叠，成功/失败颜色不同
- [ ] WebSocket 地址不硬编码（从 `location` 推导或环境变量）
- [ ] 断线后 `busy` 复位、流式光标停止
- [ ] 流式输出自动滚底，上滚时不打断
- [ ] `pnpm --filter @witcode/model typecheck` 与 `pnpm --filter @witcode/web typecheck` 通过

## D. 测试（Test-1 / Test-2）

- [ ] kernel 单测覆盖注册、依赖、卸载、事件
- [ ] `packages/kernel` 的 `pnpm test` 通过
- [ ] e2e 两个用例通过（prompt 流式、cancel 中断）
- [ ] e2e 连跑两次无残留进程/端口

## E. 集成（总管）

- [ ] server 启动时自动加载：echo 或真实 provider、session store、tool service
- [ ] 一句话「看看这个项目是干嘛的」能触发 `list_dir` + `read_file`
- [ ] 一句话「把 README 第一行改掉」能触发 `read_file` + `write_file`
- [ ] 一句话「跑一下测试」能触发 `run_command`
- [ ] 工具调用在界面出现卡片，结果可展开
- [ ] 刷新页面后会话还在
- [ ] 中文输入、流式、取消都正常

## F. 视觉（Visual-1）

- [ ] 三档视口（1440 / 1280 / 768）无溢出
- [ ] 空态、连接中、断开、错误四态都有明确提示
- [ ] 键盘：Enter 发送、Shift+Enter 换行、焦点可见
- [ ] 对比度与按钮可读名称满足基本可访问性

## 打回规则

任一条不通过：写清「哪条、现象、复现步骤」，退回给对应负责人，不在集成阶段替它改。
