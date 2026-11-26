# P2 验收单（模型管家）

> 目标：多个提供商、按顺序/轮换路由、失败切换、用量可见、设置页可管理。
> 边界：只做 API key + 自定义端点；**不做**订阅账号反代、不做刷额度。

## A. Provider 注册表（Coding-1）

- [ ] 新增 provider 落盘 `providers.json`，重开进程仍在
- [ ] 编辑时 apiKey 留空 = 保留原 key
- [ ] 删除后列表与文件同步
- [ ] 文件损坏时备份为 `.bad-<time>` 并返回空列表，不崩
- [ ] 写入是原子的（临时文件 + rename）
- [ ] 返回给前端的对象不含明文 key，`apiKeyHint` 正确
- [ ] `modelIds` 去重、去空
- [ ] `pnpm --filter @witcode/model test` 通过

## B. 路由与用量（Coding-2）

- [ ] `order` 按 provider 列表顺序尝试
- [ ] `rotate` 每次从上次成功的下一个开始
- [ ] 主 provider 返回 429/5xx → 自动切下一个，用户无感
- [ ] 已经输出文本后再失败 → 不切换（避免重复）
- [ ] 全部失败 → 返回最后一个错误
- [ ] `selection` 指定后只走该 provider/model，失败不切换
- [ ] 每次尝试写一条 usage（成功/失败、token、耗时）
- [ ] `usage.list` 倒序、`summary` 汇总正确
- [ ] `pnpm --filter @witcode/model test` 通过

## C. 设置页（Coding-3）

- [ ] 顶栏显示当前模型，能切换
- [ ] 设置页两个 tab：Providers / Usage
- [ ] Providers 能新增、编辑、删除（删除有确认）
- [ ] 表单校验：name/baseUrl 必填，modelIds 至少一个
- [ ] 空态提示清楚
- [ ] Usage 显示总请求、总 token、按 provider 分组、最近记录
- [ ] 768 宽下可用
- [ ] `pnpm --filter @witcode/web typecheck` + `build` 通过
- [ ] 原有聊天不回归

## D. 集成（总管）

- [ ] server 启动装配 gateway（无 provider 时用环境变量或回声兜底）
- [ ] WS 处理 `providers:*`、`usage:list`、`selection:set`
- [ ] prompt 带上当前 selection
- [ ] `ready` 带当前模型
- [ ] 保存 provider 后无需重启即可用于下一次请求
- [ ] 删除当前 selection 指向的 provider 后，自动回退

## E. 测试

- [ ] 单测覆盖 registry / usage / router
- [ ] e2e：两个 mock provider，主返回 500、备正常，最终成功且 usage 有两条记录
- [ ] e2e：selection 指向主 provider，失败直接报错（不偷偷切换）

## F. 视觉

- [ ] 设置页在 1440 / 1280 / 768 三档无溢出
- [ ] 表单错误有明确提示
- [ ] 长 baseUrl / 长模型名截断合理

## 打回规则

任一条不通过：写清「哪条、现象、复现步骤」，退回给对应负责人。
