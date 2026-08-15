# Provider 与图片限制

仅在修改 Provider、模型列表、图片转换、路由规则或诊断请求被拒绝时读取本文件。

## 组件边界

- `scripts/image_input_resolver.js`：从路径、URL、Data URL、Base64 和剪贴板取得原始字节，并强制调用统一标准化网关。
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

## 默认路由

`VISION_PROVIDER=auto` 时：

1. `glm-4.1v-thinking-flash`
2. `glm-4.6v-flash`
3. `gemini-3.7-flash`
4. `gemini-3.6-flash`
5. `gemini-3.5-flash`
6. `gemini-flash-latest`

任一 GLM 请求返回 HTTP 400 时，立即切换到 Gemini。Gemini 的 429 按错误详情分类：

- `QuotaFailure` 包含 `quotaDimensions.model` 或按模型计算的 `quotaId` 时，属于模型级配额。记录 `RetryInfo.retryDelay`，但不等待、不重试当前模型，立即尝试 Gemini 模型池的下一项。
- 未包含模型维度的 429 按 Provider 级限流处理。包含 `RetryInfo.retryDelay` 时不执行短间隔无效重试，立即切换备用 Provider；缺少结构化恢复时间时，在当前模型重试 3 次，等待 2/4 秒。
- 认证失败不重试；网络和 5xx 错误在当前 Provider 完成重试后，再切换备用 Provider。

显式模型声明优先于 `VISION_PROVIDER`：

| 用户表达 | 首选顺序 |
|---|---|
| 未指定或使用 GLM | GLM 4.1V → GLM 4.6V → Gemini |
| 使用 `glm-4.6v-flash` | GLM 4.6V → GLM 4.1V → Gemini |
| 使用 Gemini、Google 或谷歌模型 | Gemini → GLM 4.1V → GLM 4.6V |
| 指定某个 `gemini-*` | 指定模型 → 其他 Gemini → GLM |

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
| `VISION_PROVIDER` | `auto`、`gemini` 或 `zhipu`；只调整首选顺序 |
| `GEMINI_MODELS` | 逗号分隔的 Gemini 模型回退顺序 |
| `ZHIPU_MODELS` | 逗号分隔的智谱模型回退顺序 |
| `ZHIPU_MODEL` | 兼容单模型配置，覆盖默认智谱列表 |
| `VISION_MODEL` | 旧配置兼容，仅作为 `ZHIPU_MODEL` 后备值 |
| `VISION_API_TIMEOUT_MS` | 单次 Provider 请求超时，默认 30000ms |

Provider 请求遵循 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。
