# ADR 0006：模型管家

> 状态：已采纳（P2）
> 日期：2026-11-26

## 背景

P1 只有一个从环境变量读的 OpenAI 兼容 provider。用户需要：
- 同时配置多个提供商
- 选当前用哪个模型
- 主 provider 限流/故障时自动换下一个
- 看到每个 provider 消耗了多少 token

参照 Magpie 的产品模型，但 WitCode 是 Harness，不是号池。

## 决策

### 1. 边界：只做 API key 与自定义端点

**做**：用户自己填 `baseUrl + apiKey + modelIds` 的提供商。
**不做**：订阅账号 OAuth 反代、驱动官方 CLI、多账号轮换刷额度。

理由：
- 订阅反代依赖厂商私有接口，合规与维护风险高；
- 号池是另一个产品的问题，不是 Harness 的核心；
- 先把「用户已有的 key 管好」这件事做扎实。

### 2. 分层：registry / usage / router / gateway

| 层 | 职责 | 落盘 |
|---|---|---|
| registry | provider 配置 CRUD、key 脱敏 | `providers.json`（0600） |
| usage | 每次请求的用量 | `usage.jsonl` |
| router | 候选排序、失败切换、selection | `selection.json` |
| gateway | 组合三层，对上层暴露 `ModelService` | — |

gateway 不直接碰文件；router 不直接读环境变量；usage 不关心 provider 怎么创建。单一职责，便于单测。

### 3. 路由语义

- `order`：按 provider 列表顺序，每个用 `modelIds[0]`。
- `rotate`：从上次成功的下一个开始，平均摊薄限流。
- `selection` 指定：只走该 provider/model，**失败不切换**。用户明确选了就不替他做主。
- 无可用 provider：用环境变量 provider 或回声兜底，保证链路永远可用。

### 4. 失败切换规则

- 仅在「还没产出任何 text/tool-call」时切换，避免同一轮回答出现两段。
- 只对错误 chunk 切换；`signal.aborted` 不算失败，不切换。
- 全部失败：返回最后一个错误，不吞掉。
- 每次尝试都写 usage（含失败），便于排查「为什么切走了」。

### 5. 安全

- `providers.json` 权限 0600；返回前端的对象不含明文 key，只给 `apiKeyHint`。
- 编辑时 `apiKey` 留空 = 保留原值，避免前端回传掩码覆盖真实 key。
- 配置文件损坏时备份为 `.bad-<time>` 并返回空列表，不阻塞启动。

### 6. 兼容

- 现有 `WITCODE_BASE_URL / WITCODE_API_KEY / WITCODE_MODEL` 继续有效，作为「无配置时的兜底 provider」。
- 不迁移旧配置（P1 没有配置文件），只在首次启动时为空列表。

## 后果

- 正面：多提供商可用、故障可见、用量可查；没有引入新运行时依赖。
- 负面：没有费用估算（价格表未做）；没有预算拦截；没有订阅账号。
- 后续：P2.1 可加价格表与费用估算；P3 可把 provider 做成插件。

## 不采用

- Magpie 的 80+ Agent 配置适配：与 Harness 无关。
- 意图路由分类器：成本高、收益不确定。
- 本地 PII 模型：P4 再评估。
