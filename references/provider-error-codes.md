# 五厂商视觉模型 API 错误码手册

> 调研日期：2026-08-16。来源：各厂商官方文档、NVIDIA 开发者论坛、本项目真实调用记录。
> 覆盖：智谱 GLM、Google Gemini、Mistral、NVIDIA NIM、Cloudflare Workers AI。

## 1. 智谱（bigmodel.cn）

> 双层结构：外层 HTTP 状态码 + 响应体 `error.code` 业务错误码。来源：docs.bigmodel.cn/cn/api/api-code

| 业务码 | HTTP | 含义 | 处置建议 |
|---|---|---|---|
| 1000 | 401 | 身份验证失败 | 检查 API Key |
| 1001 | 401 | Header 未收到 Authentication 参数 | 检查请求头 |
| 1003 | 401 | Token 已过期 | 重新生成 Key |
| 1005 | 401 | 已开启二次认证保护 | 到控制台完成二次认证 |
| 1113 | 429 | 账户已欠费 | 充值 |
| 1200 | 500 | API 调用失败（内部错误） | 重试或稍后再试 |
| 1210 | 400 | 调用参数有误 | 对照文档检查请求体 |
| 1211 | 400 | 模型不存在 | 核对模型 ID |
| 1212 | 400 | 当前模型不支持该调用方式 | 换调用方式或模型 |
| 1213 | 400 | 未正常接收到 `${field}` 参数 | 补充必填参数 |
| 1214 | 400 | `${field}` 参数非法 | **实测：`modelCode：不存在`，按模型级回退** |
| 1215 | 400 | 两参数不能同时设置 | 二选一 |
| 1220 | 403 | 无权访问该 API | 检查账户权益 |
| 1221 | 400 | API 已下线 | 停用该 API |
| 1222 | 400 | API 不存在 | 核对路径 |
| 1230 | 500 | 调用流程出错 | 重试 |
| 1234 | 500 | 网络错误（附 error_id） | 联系客服 |
| 1261 | 400 | Prompt 超长 | 压缩输入 |
| 1301 | 400 | 内容安全拦截（敏感内容） | 修改提示词 |
| 1302 | 429 | **账户级**速率/并发限制 | 降频、降并发 |
| 1305 | 429 | **平台级**过载（该模型访问量过大）| **实测高频出现，重试或切换厂商** |
| 1308 | 429 | 达到用量上限（`${next_flush_time}` 重置） | 等待重置 |
| 1309 | 429 | GLM Coding Plan 套餐到期 | 续订 |
| 1310 | 429 | 周/月使用上限 | 等待重置 |
| 1311 | 429 | 套餐未开放该模型权限 | 换模型或升级套餐 |
| 1313 | 429 | 违反公平使用策略被限频 | 到个人中心申请解除 |
| 1314 | 429 | 企业套餐已失效 | 联系企业管理员 |
| 1315 | 429 | Key 仅限企业编程套餐场景 | 更换 Key 类型 |

**关键区分**：1302（你的账户太快）vs 1305（平台太挤）vs 1308/1310（额度耗尽）。免费层视觉模型主要撞 1302/1305。

## 2. Google Gemini

> 来源：ai.google.dev/gemini-api/docs/api-errors、/troubleshooting。HTTP 码 + gRPC 状态 + `error.details`（QuotaFailure/RetryInfo）。

| HTTP | gRPC 状态 | 含义 | 处置建议 |
|---|---|---|---|
| 400 | INVALID_ARGUMENT | 请求体格式错误 | 对照 API 参考检查 |
| 400 | FAILED_PRECONDITION | 免费层不支持当前地区 | 需开通付费计划 |
| 400 | —（API_KEY_INVALID）| API Key 无效 | **adapter 已按 AUTH 处理** |
| 403 | PERMISSION_DENIED | Key 无权访问该资源（如 tuned model） | 检查 Key 权限 |
| 404 | NOT_FOUND | 模型/资源不存在 | **实测：`models/xxx is not found`，按模型级回退；2.5 系对新 Key 即此错** |
| 429 | RESOURCE_EXHAUSTED | 触发限流（RPM/TPM/RPD/spend） | 看 `QuotaFailure.violations.quotaDimensions.model` 区分模型级/项目级；按 `RetryInfo.retryDelay` 退避 |
| 500 | INTERNAL | 服务端内部错误（常见于上下文过长） | 缩短输入、换模型、重试 |
| 503 | UNAVAILABLE | 服务过载/不可用 | **实测 `high demand` 消息按模型级回退** |
| 504 | DEADLINE_EXCEEDED | 超时（prompt 过大） | 加大客户端超时或缩减输入 |

新式 `code` 字符串码（同一文档并存）：`invalid_request`/`parameter_unknown`(400)、`permission_denied`(403)、`not_found`(404)、`rate_limit_exceeded`/`quota_exceeded`(429)、`api_error`(500)、`service_unavailable`(503)。

## 3. Mistral

> 来源：docs.mistral.ai/resources/error-glossary。统一 JSON：`{object:"error", message, type, param, code}`；`type` ∈ invalid_request_error / authentication_error / rate_limit_error / server_error。

| HTTP | type（典型） | 含义 | 处置建议 |
|---|---|---|---|
| 400 | invalid_request_error | 请求错误：含 `invalid_model`（code 1500，模型名错/已下线）、上下文超长 | **实测 pixtral 系下线即此错，按模型级回退** |
| 401 | authentication_error | Key 缺失/无效 | 检查 `Authorization: Bearer` |
| 402 | — | 账户无支付方式（付费模型） | 到 Admin Panel 绑卡 |
| 403 | — | 无权访问该模型/端点 | 检查订阅与 Key 权限 |
| 404 | — | 端点不存在 | 核对 URL |
| 422 | invalid_request_error | 参数校验失败（`param` 指明字段） | 修正字段类型 |
| 429 | rate_limit_error | 限流（Free 层约 1 RPS，按组织+模型计） | 指数退避；Limits 页查档位 |
| 500/502/503/504 | server_error | 服务端故障 | 退避重试 |

**注意**：模型下线用 400 + `type:"invalid_model"` 表达而非 404，正则需覆盖 `invalid[_\s]*model`（本项目已实现）。

## 4. NVIDIA NIM（integrate.api.nvidia.com）

> 无官方公开错误码表；以下来自开发者论坛高频问题与实测。响应形状：`{"status","title","detail"}`。

| HTTP | 典型响应 | 含义 | 处置建议 |
|---|---|---|---|
| 400 | `{"title":"Bad Request"}` | 请求体/参数错误（图片过大、格式不支持） | 检查载荷 |
| 401 | `{"title":"Unauthorized"}` | Key 无效/缺失；**特例**：`/v1/models` 通但 chat 401 = 账户缺 "Public API Endpoints" entitlement | 重生成 Key； entitlement 问题需工单 |
| 403 | `{"detail":"Authorization failed"}` | 同上 entitlement 缺失的另一形态 | 工单开通权限 |
| 404 | `404 page not found`（纯文本） | **模型 ID 不存在**（目录轮换/改名） | **实测：旧 nemotron ID 即此错，按模型级回退** |
| 404 | `{"detail":"Function '<uuid>': Not found for account '<id>'"}` | 账户未授权该模型（个人/新建组织常见） | 换已授权模型或工单 |
| 429 | `{"title":"Too Many Requests"}` | 评估层限流（~40 RPM）；有论坛报告触发后长时间不重置（类锁定行为） | 退避；持续 429 换厂商 |
| 500 | `{"title":"Internal Server Error"}` 等 | 服务端错误（实测空 Bearer 亦触发 500 而非 401） | 检查请求头后重试 |
| 503 | — | 容量不足 | 退避重试 |

**注意**：404 有两种形态——模型不存在（可回退下一模型）vs Function not found for account（账户级，整厂商都会失败，应熔断）。本项目当前按模型级处理，前者已实测验证。

## 5. Cloudflare Workers AI

> 双层结构：v4 API 通用层（code 7000/9109/10000 系）+ Workers AI 内部层（`errors[].code`，文档 developers.cloudflare.com/workers-ai/platform/errors）。

### 5.1 Workers AI 内部错误码

| 内部码 | HTTP | 名称 | 含义 | 处置建议 |
|---|---|---|---|---|
| 3003 | 400 | Incomplete request | 缺 headers 或 body | 补全请求 |
| 3006 | 413 | Request too large | 请求体过大 | 压缩图片 |
| 3007 | 408 | Timeout | 请求超时 | 重试 |
| 3008 | 408 | Aborted | 请求被中止 | 重试 |
| 3023 | 403 | Account blocked | 账户被封禁 | 联系支持 |
| 3030 | 400 | Model input invalid | 模型输入不合法（缺必填字段等） | **实测：OpenAI 兼容端点丢图片即此码** |
| 3036 | 429 | Account limited | **每日 10,000 neurons 免费额度耗尽** | 次日重置或升级付费 |
| 3040 | 429 | Out of capacity | 无可用数据中心承载 | 退避重试或换厂商 |
| 3041 | 403 | Account not allowed | 无权访问私有模型 | 换公开模型 |
| 3042 | 404 | Invalid model ID | 模型名无效 | 核对模型 ID |
| 5016 | 403 | Model agreement | 未同意模型条款 | **实测：先发 `{"prompt":"agree"}`；首次同意的响应也是 403+5016（带感谢语），并非失败** |
| 5018 | 403 | Account not allowed | 同 3041 | — |
| 5019 | 405 | Deprecated SDK | SDK 版本过旧 | 升级 |
| 5035 | 403 | Requires Workers Paid | 该模型需付费计划 | 升级或换模型 |
| 5004 | 400 | Invalid data | base64 输入类型非法 | 检查编码 |
| 5005 | 405 | LoRa unsupported | 模型不支持 LoRa | — |
| 5007 | 400 | No such model | 模型/任务不存在 | 核对模型名 |

### 5.2 v4 API 通用层错误码（实测+文档）

| code | HTTP | 含义 | 处置建议 |
|---|---|---|---|
| 10000 | — | Authentication error（token 无效） | 重建 token |
| 10001 | — | Unable to authenticate（认证头/格式问题） | 检查 Bearer 头 |
| 7000 | 400 | No route for that URI | **实测：模型名整体编码（`/`→`%2F`）即触发；按路径分段编码解决** |
| 7001 | 400 | 方法不支持（如对 run 端点 GET） | 改用 POST |
| 9109 | 403 | 有路由但无该资源权限（如缺 Account Settings:Read） | 补 token 权限或忽略 |

## 6. 失败决策与处置（错误语义 → 判定 → 处置）

> 核心原则：**失败作用域决定下一步**——模型级换同厂商下一模型；Provider 级熔断整厂商换下一厂商；全部耗尽按主导错误聚合成终态。依据 `scripts/errors.js` 的 `providerFailureScope` 与全量真实调用实测（2026-08-16）。

| 错误语义 | 判定信号（各厂商表现） | 作用域 | 处置 |
|---|---|---|---|
| **认证失效** | 401/403：智谱 1000 系、Gemini API_KEY_INVALID、Mistral 401、NVIDIA 401/403、CF 10000/10001 | provider | 熔断 → 下一厂商；若全部厂商皆 AUTH/缺 Key → **KEY_REQUIRED**（退出码 2） |
| **模型不存在** | 智谱 1214、Gemini 404 NOT_FOUND、Mistral 400 invalid_model、NVIDIA 404（纯文本）、CF 5007/3042 | model | 换同厂商下一模型（MODEL_SWITCH）；池内无下一模型 → 换厂商 |
| **限流 / 配额耗尽** | 429：智谱 1302/1305/1308、Gemini RESOURCE_EXHAUSTED、Mistral 429、NVIDIA 429、CF 3036 neurons/3040 容量 | provider（Gemini 例外见特例 1） | 熔断 → 下一厂商；不做原地等待重试 |
| **平台故障 / 过载** | 500/503/504：智谱 1200/1230、Gemini INTERNAL/UNAVAILABLE、Mistral 5xx、NVIDIA 500、CF 5xx | provider（Gemini 503 high demand 例外见特例 1） | 熔断 → 下一厂商 |
| **网络不可达** | 请求层异常：TLS 断连、ECONNRESET、超时（国内直连 Mistral 典型） | provider | 熔断 → 下一厂商；全部 NETWORK → **NETWORK_UNAVAILABLE** |
| **请求/输入不合法** | 400/413/422：载荷格式错、图片超限、参数校验失败、内容安全拦截（智谱 1301）、CF 3030 | provider | 熔断 → 下一厂商（输入经统一网关，正常不应触发；触发即怀疑厂商侧兼容性） |
| **响应异常** | HTTP 200 但内容空/非 JSON | model | 换同厂商下一模型 |
| **配置缺失** | CF 缺 CLOUDFLARE_ACCOUNT_ID | provider | 进池前即被 PROVIDER_SKIPPED 跳过（不算失败） |

### 终态聚合（全部厂商耗尽时）

| 主导错误 | 终态码 | 退出码 |
|---|---|---|
| 全部缺 Key 或 AUTH | KEY_REQUIRED | 2 |
| 全部 NETWORK | NETWORK_UNAVAILABLE | 1 |
| 全部 408/5xx | SERVICE_UNAVAILABLE | 1 |
| 全部 429/RATE_LIMIT | RATE_LIMITED | 1 |
| 混合 | PROVIDERS_FAILED | 1 |

### 三个厂商特例

1. **Gemini 429 细分**：`QuotaFailure.violations` 含 `quotaDimensions.model` → 模型级（换下一模型）；否则项目级（熔断）。503 + `high demand` 报文 → 模型级。
2. **Cloudflare 首次条款同意**：agree 请求返回 403 + "Thank you for agreeing"（内部码 5016）是**成功信号**，不是认证失败，不熔断；仅无感谢语的 401/403 才熔断。
3. **NVIDIA 账户级 404**（`Function not found for account`）：语义是账户无权限（应熔断），当前按模型级处理——多试一个模型后自然熔断，代价可接受。

### 失败的后续影响（健康度冷却）

失败不止步于切换，还会写入跨进程健康状态（`%TEMP%\vision_bridge_health.json`）影响后续调用：

- **冷却阶梯 1→2→4→8→16 分钟**（封顶 16 分钟）：同一模型连续失败逐级升级；服务端建议的 `retryAfterMs` 更长时取较大值（仍封顶）。
- **AUTH 例外**：认证失败不冷却（换厂商已是最优解，冷却无意义）。
- **降权不剔除**：冷却中的模型排池尾、Provider 排队列尾，全冷却时仍兜底可用。
- **成功即复位**：命中后清零失败计数、记录 `lastSuccess`；冷却解除后模型回到原速度序位置。
- 删除状态文件即可重置。

### 观测与原则

- stderr 事件：`MODEL_SWITCH`/`MODEL_FAILED`（模型级）、`PROVIDER_SWITCH`/`PROVIDER_FAILED`（Provider 级）、`MODEL_COOLDOWN`/`PROVIDER_COOLDOWN`（冷却降权）——均为中间状态，Agent 须等进程退出再下结论。
- **同一模型只请求一次，失败即切换，不做原地重试**：更快暴露真实可用性，等待/退避交给上层 Agent。

## 参考链接

- 智谱错误码：<https://docs.bigmodel.cn/cn/api/api-code>
- 智谱速率限制：<https://docs.bigmodel.cn/cn/api/rate-limit>
- Gemini API errors：<https://ai.google.dev/gemini-api/docs/api-errors>
- Gemini Troubleshooting：<https://ai.google.dev/gemini-api/docs/troubleshooting>
- Mistral Error glossary：<https://docs.mistral.ai/resources/error-glossary>
- Cloudflare Workers AI Errors：<https://developers.cloudflare.com/workers-ai/platform/errors/>
- NVIDIA NIM（无官方错误码表，依据论坛实测）：<https://forums.developer.nvidia.com/c/ai-ml/nim/>
