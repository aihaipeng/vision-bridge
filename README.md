# 🖼️ img2txt

`img2txt` 是一个面向智能体的图像理解 Skill。它统一读取本地文件、公开 URL、Data URL、Base64、聊天附件真实路径和 Windows 剪贴板中的图片，经过解码、安全校验与格式标准化后，调用智谱 GLM 或 Google Gemini 视觉模型输出文字。

适合以下任务：

- 描述图片、截图或界面
- 提取图片中的可见文字（OCR）
- 解释图表、流程图和错误截图
- 在当前 Agent 无法直接读取图片时提供视觉模型后备能力

## ⚙️ 运行要求

- Windows 10/11
- Node.js 20.9 或更高版本
- npm
- 可访问智谱或 Gemini API 的出站 HTTPS 网络
- 使用 `clipboard` 输入时，允许读取 Windows 剪贴板

## 🚀 快速开始

至少配置一个 Provider 的 API Key；同时配置两个 Key 可以获得完整的跨 Provider 自动回退能力。

配置完成后，直接在对话中上传图片或提供图片来源，并说明任务。例如：

- 上传图片后说：“请详细描述这张图片。”
- 提供本地路径：“提取 `C:\images\receipt.png` 中的文字。”
- 提供公开 URL：“分析 `https://example.com/chart.png` 中的数据趋势。”
- 明确使用剪贴板：“读取剪贴板中的截图并解释报错。”

仅发送图片而不附带说明时，Skill 会自动详细描述图片。

## 🔑 申请并设置 API Key

智谱：https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys

Gemini：https://aistudio.google.com/apikey

### PowerShell

```powershell
# 设置 apikey
[Environment]::SetEnvironmentVariable('ZHIPU_API_KEY', 'YOUR_ZHIPU_API_KEY', 'User')
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'YOUR_GEMINI_API_KEY', 'User')

# 验证环境变量生效
[Environment]::GetEnvironmentVariable('ZHIPU_API_KEY', 'User')
[Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')

# 更新 apikey
[Environment]::SetEnvironmentVariable('ZHIPU_API_KEY', 'YOUR_NEW_ZHIPU_API_KEY', 'User')
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'YOUR_NEW_GEMINI_API_KEY', 'User')

# 删除 apikey
[Environment]::SetEnvironmentVariable('ZHIPU_API_KEY', $null, 'User')
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', $null, 'User')
```

### CMD

```cmd
# 设置 apikey
setx ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_GEMINI_API_KEY"

# 验证环境变量生效
echo %ZHIPU_API_KEY%
echo %GEMINI_API_KEY%

# 更新 apikey
setx ZHIPU_API_KEY "YOUR_NEW_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_NEW_GEMINI_API_KEY"

# 删除 apikey
reg delete "HKCU\Environment" /v ZHIPU_API_KEY /f
reg delete "HKCU\Environment" /v GEMINI_API_KEY /f
```

## 🤖 支持的模型

| Provider | 模型                        | 简要介绍                                                                 | 默认角色       |
| -------- | --------------------------- | ------------------------------------------------------------------------ | -------------- |
| GLM      | `glm-4.1v-thinking-flash` | 偏视觉思考与推理的 GLM 多模态模型，适合需要分析过程的图片理解任务。      | 默认模型       |
| GLM      | `glm-4.6v-flash`          | GLM Flash 视觉模型，用于快速图像理解，并作为智谱模型池的第二顺位。       | 智谱后备       |
| Gemini   | `gemini-3.7-flash`        | 固定版本的 Gemini Flash 多模态模型，支持`generateContent`。            | Gemini 首选    |
| Gemini   | `gemini-3.6-flash`        | 固定版本的 Gemini Flash 多模态模型，用于 3.7 不可用时继续处理请求。      | Gemini 后备 1  |
| Gemini   | `gemini-3.5-flash`        | 固定版本的 Gemini Flash 多模态模型，提供更深一层的版本回退。             | Gemini 后备 2  |
| Gemini   | `gemini-flash-latest`     | 指向当前最新 Gemini Flash 的浮动别名，实际版本可能随 Google 更新而变化。 | Gemini 后备 3 |

## 🔀 模型调用顺序

### 默认顺序

`VISION_PROVIDER=auto` 或未设置时，按上表顺序调用：先 GLM 模型池，全部失败后回退 Gemini 模型池。只配置一个 Provider 的 Key 时，自动跳过没有 Key 的 Provider。

### 用户指定模型或 Provider

用户问题中的明确模型意图优先于 `VISION_PROVIDER`：

| 用户表达                           | 首选顺序                                   |
| ---------------------------------- | ------------------------------------------ |
| 未指定模型，或要求使用 GLM/智谱    | GLM 4.1V -> GLM 4.6V -> Gemini 模型池      |
| 指定`glm-4.6v-flash`             | GLM 4.6V -> GLM 4.1V -> Gemini 模型池      |
| 要求使用 Gemini、Google 或谷歌模型 | Gemini 模型池 -> GLM 4.1V -> GLM 4.6V      |
| 指定某个`gemini-*` 模型          | 指定模型 -> 其他 Gemini 模型 -> GLM 模型池 |

### 失败、重试与回退

- 认证失败不在当前 Provider 内重试；如果另一个 Provider 有可用 Key，则继续尝试另一个 Provider。
- 网络错误、HTTP 5xx 和普通 Provider 级 429 最多请求 3 次，重试间隔为 2 秒、4 秒。
- Gemini 模型级 429 不等待当前模型恢复，立即尝试下一个 Gemini 模型。
- Gemini Provider 级 429 如果给出明确恢复时间，立即切换备用 Provider。
- 智谱请求返回 HTTP 400 时，不继续尝试其他智谱模型，直接进入 Gemini 回退链路。
- 所有可用 Provider 都失败后，脚本返回 `PROVIDERS_FAILED`；缺少 Key 或认证失败时返回 `KEY_REQUIRED`。

## 📥 支持的图片输入

| 输入来源           | 示例                              | 说明                               |
| ------------------ | --------------------------------- | ---------------------------------- |
| 本地绝对或相对路径 | `C:\images\shot.png`            | 支持有扩展名和无扩展名文件         |
| `file://` URL    | `file:///C:/images/shot.png`    | 转换为本地路径后读取               |
| 公开 HTTP(S) URL   | `https://example.com/image.jpg` | 拒绝私网、回环和带用户名密码的 URL |
| Data URL           | `data:image/png;base64,...`     | 必须声明为`image/*`              |
| 裸 Base64          | `iVBORw0KGgo...`                | 解码后仍执行真实格式校验           |
| SVG 文本           | `<svg ...>...</svg>`            | 渲染为 PNG 后发送                  |
| 聊天附件路径       | Agent 提供的真实绝对路径          | 仅显示名不等于可读取路径           |
| Windows 剪贴板     | `clipboard`                     | 仅在用户明确要求时读取             |

## 🖼️ 支持的图片格式

格式按实际文件字节识别，不依赖扩展名、URL 后缀、HTTP `Content-Type` 或 Data URL 声明。

| 格式                  | 支持状态 | 标准化行为                    | 备注                                                       |
| --------------------- | -------- | ----------------------------- | ---------------------------------------------------------- |
| JPEG / JPG            | 支持     | 保留为 JPEG；超限时重新压缩   | 稳定支持                                                   |
| PNG                   | 支持     | 保留为 PNG；超限时可转为 JPEG | 透明区域转 JPEG 时填充白色                                 |
| WebP                  | 支持     | 转为 JPEG                     | 已有自动化测试                                             |
| TIFF / TIF            | 支持     | 读取第一页并转为 JPEG         | 已有自动化测试                                             |
| GIF                   | 支持     | 读取第一帧并转为 JPEG         | 不进行动画分析                                             |
| BMP                   | 支持     | 使用内置 BMP 解码器转为 JPEG  | 解码前先校验尺寸                                           |
| SVG                   | 支持     | 以 144 DPI 渲染为 PNG         | 支持文件、Data URL、Base64 和 SVG 文本                     |
| AVIF                  | 条件支持 | 解码后转为 JPEG               | 取决于当前 Sharp/libvips 构建；当前锁定依赖环境可解码 AVIF |
| HEIC / HEIF           | 条件支持 | 可解码时转为 JPEG             | 是否可用取决于 Sharp/libvips 的编解码器构建                |
| 其他 Sharp 可解码格式 | 条件支持 | 通常转为 JPEG                 | 以运行环境的`sharp.format` 能力为准                      |

损坏图片、HTML、伪造图片声明或当前解码器不支持的数据会在调用 Provider 前返回 `IMAGE_INPUT`。

## 📐 图片限制与转换

| 阶段               | 限制                                      | 处理方式                                            |
| ------------------ | ----------------------------------------- | --------------------------------------------------- |
| 本地读取或远程下载 | 最大 32 MB                                | 超限时在解码前拒绝                                  |
| 解码后图片         | 最大 100,000,000 像素                     | 防止解压缩炸弹和过量内存分配                        |
| 远程 URL           | 最多 5 次重定向                           | 每次重定向都重新执行公网地址校验                    |
| 智谱 Provider      | 小于 5,000,000 字节，宽高不超过 6000 像素 | 逐档缩放并压缩为 JPEG                               |
| Gemini Provider    | 原始图片数据小于 14,000,000 字节          | 为 20 MB 内联请求的 Base64、JSON 和提示文本预留空间 |

Provider 最终只会收到 `image/jpeg` 或 `image/png`。最低压缩档仍无法满足限制时，请求会在上传前失败。

## 🛠️ 配置项

| 环境变量                         | 默认值             | 说明                                                              |
| -------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `ZHIPU_API_KEY`                | 无                 | 智谱 API Key                                                      |
| `GEMINI_API_KEY`               | 无                 | Gemini API Key                                                    |
| `VISION_PROVIDER`              | `auto`           | 可设为`auto`、`zhipu` 或 `gemini`，只调整 Provider 首选顺序 |
| `ZHIPU_MODELS`                 | 内置 GLM 模型池    | 逗号分隔的智谱模型调用顺序                                        |
| `GEMINI_MODELS`                | 内置 Gemini 模型池 | 逗号分隔的 Gemini 模型调用顺序                                    |
| `ZHIPU_MODEL`                  | 无                 | 兼容旧版单模型配置；仅在未设置`ZHIPU_MODELS` 时生效             |
| `VISION_MODEL`                 | 无                 | 更早的兼容配置，仅作为`ZHIPU_MODEL` 的后备值                    |
| `VISION_API_TIMEOUT_MS`        | `30000`          | 单次 Provider 请求超时，单位为毫秒                                |
| `HTTPS_PROXY` / `HTTP_PROXY` | 无                 | Provider 请求代理                                                 |
| `NO_PROXY`                     | 无                 | 不经过代理的主机列表                                              |

例如，将 Gemini 设为首选 Provider：

```powershell
$env:VISION_PROVIDER = 'gemini'
```

## 🔒 安全与隐私

- 图片内容会上传到最终选中的智谱或 Google 云端 Provider，请仅处理已获授权的图片。
- 不要使用本 Skill 处理未经授权的身份证、合同、凭证或其他敏感资料。
- Skill 不会因为附件读取失败而自动读取剪贴板；只有用户明确要求时才使用 `clipboard`。
- 远程 URL 会拒绝私网、回环、链路本地、UNC 网络共享和含用户名密码的地址，以降低 SSRF 风险。
- API Key 不会写入请求 URL 或正常输出；Gemini 使用 `x-goog-api-key` 请求头，智谱使用 Bearer 认证头。

## 🩺 故障排查

| 退出码 | 错误类型                                             | 处理方式                                         |
| ------ | ---------------------------------------------------- | ------------------------------------------------ |
| `0`  | 成功                                                 | stdout 仅包含模型返回的文字                      |
| `1`  | `IMAGE_INPUT`、`CONFIG`、`PROVIDERS_FAILED` 等 | 根据 stderr 修正输入、配置、网络或 Provider 问题 |
| `2`  | `KEY_REQUIRED`                                     | 按错误中提供的注册地址配置有效 Key 后重试        |

stderr 固定格式：

```text
[ERROR] <CODE>: <message>
```

常见检查：

```powershell
node -e "require('sharp'); require('bmp-ts')"
npm run check
npm test
```

完整恢复步骤见 [`references/troubleshooting.md`](references/troubleshooting.md)，Provider 与图片限制见 [`references/provider_limits.md`](references/provider_limits.md)。

## 🔗 官方参考

- [Gemini API Key](https://aistudio.google.com/apikey)
- [Gemini 图片理解](https://ai.google.dev/gemini-api/docs/image-understanding)
- [智谱 API Key 管理](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys)
- [智谱对话补全 API](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)
- [智谱视觉模型](https://docs.bigmodel.cn/cn/guide/models/vlm)
