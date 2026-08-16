# Provider 与图片限制

仅在进入 vision-bridge SOP 并修改 Provider、模型列表、图片转换、路由规则或诊断请求被拒绝时读取本文件。Agent 原生视觉结果不经过这里描述的输入网关、压缩策略或 Provider 轮询。

## 组件边界

- `scripts/image_input_resolver.js`：从路径、URL、Data URL、Base64 和剪贴板取得原始字节，并强制调用统一标准化网关。
- `scripts/recover_session_images.js`：从当前 Claude Code/OpenCode 本地会话恢复图片 part，再交给统一输入网关；不读取 Provider 或对话正文。
- `scripts/image_preparer.js`：将可解码输入标准化为 JPEG/PNG，再按 Provider 配置缩放和压缩。
- `scripts/providers/gemini.js`：构造 Gemini `generateContent` 请求并执行模型回退。
- `scripts/providers/zhipu.js`：构造智谱对话补全请求并执行模型回退。
- `scripts/describe_image.js`：选择 Provider、管理密钥、维护临时缓存和 CLI 输出协议。

Provider 不得重新解析文件路径、直接读取剪贴板或负责首次格式合法化。

## 输入网关限制

- 不使用文件扩展名、URL 后缀、Content-Type 或 Data URL 声明判断真实格式。
- 接受 Sharp/libvips 当前构建可解码的图片，以及内置解码器支持的 BMP；具体 HEIC/AVIF 能力取决于当前 Sharp 构建。
- JPEG/PNG 经解码元数据与像素上限校验，存在 EXIF Orientation 时先纠正方向；SVG 和 BMP 转为 PNG；WebP、TIFF、GIF 首帧及其他格式按透明通道转为 PNG 或 JPEG。
- 含透明通道的输入保持 PNG，不通过白底扁平化丢失透明前景；不透明的非标准格式转为 JPEG。
- 网关成功时只输出 `image/jpeg` 或 `image/png`；HTML、损坏数据和当前解码器不支持的格式统一返回 `IMAGE_INPUT`。
- 远程下载与本地读取上限为 32MB。
- 远程 URL 最多跟随 5 次重定向。
- 拒绝私网、回环、链路本地、UNC 网络共享和带用户名密码的 URL。
- 图片在网关中受 100MP 总像素上限约束，BMP 在分配解码缓冲区前先校验文件头尺寸。

## 固定轮询与熔断

脚本先检查两个 Key，只将已配置的 Provider 加入队列。顺序不可由用户问题修改：

1. `glm-4.1v-thinking-flash`
2. `glm-4.6v-flash`
3. `gemini-3.7-flash`
4. `gemini-3.6-flash`
5. `gemini-3.5-flash`
6. `gemini-flash-latest`

同一模型只请求一次，不做原地重试或等待。失败作用域决定下一步：

- 模型级：404、模型维度配额、空响应和响应解析错误，切换同 Provider 下一模型。
- Provider 级：认证、网络、超时、Provider 维度配额、HTTP 400/408/429/5xx，立即熔断当前 Provider 并切换下一 Provider。
- Gemini `QuotaFailure` 包含 `quotaDimensions.model` 或按模型计算的 `quotaId` 时判定为模型级；其他 429 判定为 Provider 级。
- 每次失败通过 stderr 的 `MODEL_SWITCH`、`MODEL_FAILED`、`PROVIDER_SWITCH` 或 `PROVIDER_FAILED` 告知主 Agent；切换事件包含下一目标，成功 stdout 末尾注明实际模型。

用户问题中的 GLM、Gemini 或具体模型名称只是发送给视觉模型的任务文本，不参与路由。

## Provider 图片准备

Provider 输入已经是 JPEG/PNG，只执行自身尺寸与体积限制。低熵 PNG 和透明 PNG 先无损优化；透明 PNG 超限时保持 PNG 并逐档缩放。不透明图片使用快速 JPEG 探测搜索当前尺寸的最高可用质量，再用 MozJPEG 生成最终候选；达到质量下限后才降低尺寸。每次压缩后检查最终字节数和尺寸，最低档仍不满足时在发送请求前失败。

| Provider | 实现限制 | 发送格式 |
|---|---|---|
| Gemini | 图片原始数据小于 14,000,000 字节，为 20MB 内联请求的 Base64、JSON 和提示文本预留空间 | JPG 或 PNG，`inline_data` Base64 |
| 智谱 | 图片小于 5,000,000 字节，宽高不超过 6000 像素 | JPG 或 PNG，裸 Base64 |

低熵 PNG 转 JPEG 时使用 `4:4:4` 色度采样保护截图细节，高熵 PNG 和原生 JPEG 使用 `4:2:0` 控制照片体积。Provider 收到其他 MIME 时视为网关绕过错误。

限制来源：

- Gemini：<https://ai.google.dev/gemini-api/docs/image-understanding>
- 智谱：<https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8>

## 配置项

| 环境变量 | 说明 |
|---|---|
| `GEMINI_MODELS` | 逗号分隔的 Gemini 模型回退顺序 |
| `ZHIPU_MODELS` | 逗号分隔的智谱模型回退顺序 |
| `ZHIPU_MODEL` | 兼容单模型配置，覆盖默认智谱列表 |
| `VISION_MODEL` | 旧配置兼容，仅作为 `ZHIPU_MODEL` 后备值 |
| `VISION_API_TIMEOUT_MS` | 单次 Provider 请求超时，默认 30000ms |

Provider 请求遵循 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。
