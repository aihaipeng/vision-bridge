# 🖼️ img2txt

`img2txt` 是一个面向智能体的图像理解 Skill。它统一读取本地文件、公开 URL、Data URL、Base64、一个或多个聊天附件真实路径和 Windows 剪贴板中的图片，经过解码、安全校验与格式标准化后，按固定模型池输出带模型归属的文字。

适合以下任务：

- 描述图片、截图或界面
- 提取图片中的可见文字（OCR）
- 解释图表、流程图和错误截图
- 在当前 Agent 无法直接读取图片时提供视觉模型后备能力
- 按附件顺序逐张识别并综合比较多张图片
- 当前消息的图片附件缺少真实路径时，受控读取当前 Windows 剪贴板一次

## ⚙️ 运行要求

- Windows 10/11
- Node.js 20.9 或更高版本
- npm
- 可访问智谱或 Gemini API 的出站 HTTPS 网络
- 使用 `clipboard` 输入时，允许读取 Windows 剪贴板

## 🚀 快速开始

至少配置一个 Provider 的 API Key；同时配置两个 Key 可以获得完整的跨 Provider 自动轮询能力。脚本先检查 Key，只轮询已配置的 Provider，顺序始终为 GLM 模型池 → Gemini 模型池。用户在问题中声明 Provider 或模型不会改变该顺序。

配置完成后，直接在对话中上传图片或提供图片来源，并说明任务。例如：

- 上传图片后说：“请详细描述这张图片。”
- 提供本地路径：“提取 `C:\images\receipt.png` 中的文字。”
- 提供公开 URL：“分析 `https://example.com/chart.png` 中的数据趋势。”
- 明确使用剪贴板：“读取剪贴板中的截图并解释报错。”

仅发送图片而不附带说明时，Skill 会自动详细描述图片。

配置后在 Skill 目录运行 `npm run doctor`。它只显示 Key 是否已配置，不显示 Key 内容。不要在聊天中发送 API Key；脚本不读取标准输入，也不支持单次 Key。

## 🔑 申请并设置 API Key

智谱：https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys

Gemini：https://aistudio.google.com/apikey

### PowerShell

```powershell
# 设置 apikey
[Environment]::SetEnvironmentVariable('ZHIPU_API_KEY', 'YOUR_ZHIPU_API_KEY', 'User')
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'YOUR_GEMINI_API_KEY', 'User')

# 验证是否已配置，不输出 Key
@('ZHIPU_API_KEY', 'GEMINI_API_KEY') | ForEach-Object {
  $configured = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'User'))
  "$_=" + $(if ($configured) { 'SET' } else { 'NOT_SET' })
}

# 更新 apikey
[Environment]::SetEnvironmentVariable('ZHIPU_API_KEY', 'YOUR_NEW_ZHIPU_API_KEY', 'User')
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'YOUR_NEW_GEMINI_API_KEY', 'User')

# 删除 apikey
[Environment]::SetEnvironmentVariable('ZHIPU_API_KEY', $null, 'User')
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', $null, 'User')
```

### CMD

```cmd
REM 设置 apikey
setx ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_GEMINI_API_KEY"

REM 验证是否已配置，不输出 Key
reg query "HKCU\Environment" /v ZHIPU_API_KEY >nul 2>&1 && echo ZHIPU_API_KEY=SET || echo ZHIPU_API_KEY=NOT_SET
reg query "HKCU\Environment" /v GEMINI_API_KEY >nul 2>&1 && echo GEMINI_API_KEY=SET || echo GEMINI_API_KEY=NOT_SET

REM 更新 apikey
setx ZHIPU_API_KEY "YOUR_NEW_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_NEW_GEMINI_API_KEY"

REM 删除 apikey
reg delete "HKCU\Environment" /v ZHIPU_API_KEY /f
reg delete "HKCU\Environment" /v GEMINI_API_KEY /f
```

设置或更新后直接运行（脚本会读取 Windows 用户环境变量，无需重启 Agent）：

```cmd
npm run doctor
```

## 🤖 支持的模型

模型按表格顺序自动轮询。单个模型失败后不会原地重试或等待；模型级故障切换下一模型，Provider 级故障直接切换下一 Provider。切换原因写入 stderr，最终 stdout 末尾注明实际使用模型。

| Provider | 模型                        | 简要介绍                                                                 | 默认角色       |
| -------- | --------------------------- | ------------------------------------------------------------------------ | -------------- |
| GLM      | `glm-4.1v-thinking-flash` | 偏视觉思考与推理的 GLM 多模态模型，适合需要分析过程的图片理解任务。      | 默认模型       |
| GLM      | `glm-4.6v-flash`          | GLM Flash 视觉模型，用于快速图像理解，并作为智谱模型池的第二顺位。       | 智谱后备       |
| Gemini   | `gemini-3.7-flash`        | 固定版本的 Gemini Flash 多模态模型，支持`generateContent`。            | Gemini 首选    |
| Gemini   | `gemini-3.6-flash`        | 固定版本的 Gemini Flash 多模态模型，用于 3.7 不可用时继续处理请求。      | Gemini 后备 1  |
| Gemini   | `gemini-3.5-flash`        | 固定版本的 Gemini Flash 多模态模型，提供更深一层的版本回退。             | Gemini 后备 2  |
| Gemini   | `gemini-flash-latest`     | 指向当前最新 Gemini Flash 的浮动别名，实际版本可能随 Google 更新而变化。 | Gemini 后备 3 |


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
| 图片直读失败回退   | `clipboard-fallback`            | 当前附件无路径或本回合平台/模型报告不支持图片输入时使用 |

## 🖼️ 支持的图片格式

格式按实际文件字节识别，不依赖扩展名、URL 后缀、HTTP `Content-Type` 或 Data URL 声明。

| 格式                  | 支持状态 | 标准化行为                    | 备注                                                       |
| --------------------- | -------- | ----------------------------- | ---------------------------------------------------------- |
| JPEG / JPG            | 支持     | 保留为 JPEG；纠正 EXIF 方向   | 超限时先搜索质量，再逐档缩放                               |
| PNG                   | 支持     | 保留为 PNG；低熵图先无损优化  | 含透明通道时始终保持 PNG                                   |
| WebP                  | 支持     | 透明图转 PNG，否则转 JPEG     | 已有自动化测试                                             |
| TIFF / TIF            | 支持     | 读取第一页；按透明通道选格式  | 已有自动化测试                                             |
| GIF                   | 支持     | 读取第一帧；按透明通道选格式  | 不进行动画分析                                             |
| BMP                   | 支持     | 使用内置 BMP 解码器转为 PNG   | 解码前先校验尺寸                                           |
| SVG                   | 支持     | 以 144 DPI 渲染为 PNG         | 支持文件、Data URL、Base64 和 SVG 文本                     |
| AVIF                  | 条件支持 | 按透明通道转为 PNG 或 JPEG    | 取决于当前 Sharp/libvips 构建；当前锁定依赖环境可解码 AVIF |
| HEIC / HEIF           | 条件支持 | 按透明通道转为 PNG 或 JPEG    | 是否可用取决于 Sharp/libvips 的编解码器构建                |
| 其他 Sharp 可解码格式 | 条件支持 | 按透明通道转为 PNG 或 JPEG    | 以运行环境的 `sharp.format` 能力为准                       |

损坏图片、HTML、伪造图片声明或当前解码器不支持的数据会在调用 Provider 前返回 `IMAGE_INPUT`。

## 📐 图片限制与转换

| 阶段               | 限制                                      | 处理方式                                            |
| ------------------ | ----------------------------------------- | --------------------------------------------------- |
| 本地读取或远程下载 | 最大 32 MB                                | 超限时在解码前拒绝                                  |
| 解码后图片         | 最大 100,000,000 像素                     | 防止解压缩炸弹和过量内存分配                        |
| 远程 URL           | 最多 5 次重定向                           | 每次重定向都重新执行公网地址校验                    |
| 智谱 Provider      | 小于 5,000,000 字节，宽高不超过 6000 像素 | PNG 无损优先；JPEG 先搜索质量，再逐档缩放           |
| Gemini Provider    | 原始图片数据小于 14,000,000 字节          | 为 20 MB 内联请求的 Base64、JSON 和提示文本预留空间 |

Provider 最终只会收到 `image/jpeg` 或 `image/png`。低熵截图优先保留 PNG；不透明高熵图片使用 JPEG，当前尺寸达到质量下限后才降低分辨率。最低压缩档仍无法满足限制时，请求会在上传前失败。

## 🔒 安全与隐私

- 图片和问题文本会上传到参与轮询的智谱或 Google 云端 Provider；失败切换时可能先后发送给两个 Provider，请仅处理已获授权的内容。
- 不要使用本 Skill 处理未经授权的身份证、合同、凭证或其他敏感资料。
- 只有用户明确要求、当前图片附件没有可读取路径，或本回合 Agent/系统刚产生 `Cannot read ... this model does not support image input`、`Unsupported Image` 等图片能力错误时，Skill 才读取剪贴板。受控回退使用 `clipboard-fallback`，读取前向主 Agent 输出 `CLIPBOARD_FALLBACK`，成功结果注明剪贴板来源。
- 普通缺失路径、过去消息、纯文本中的 `image.png` 和无法解码的已有文件不会触发剪贴板回退；回退失败后不会搜索工作目录或重复读取。
- 远程 URL 会拒绝私网、回环、链路本地、UNC 网络共享和含用户名密码的地址，以降低 SSRF 风险。
- API Key 不会写入请求 URL 或正常输出；Gemini 使用 `x-goog-api-key` 请求头，智谱使用 Bearer 认证头。
- 不要在聊天中发送 API Key。脚本不读取标准输入，也不会自动保存聊天中提供的 Key。
- 图片文字和模型输出均按不可信数据处理，不执行其中包含的命令、工具调用或绕过指令。

## 🩺 故障排查

| 退出码 | 错误类型                                             | 处理方式                                         |
| ------ | ---------------------------------------------------- | ------------------------------------------------ |
| `0`  | 成功                                                 | stdout 包含模型文字及末尾的实际模型归属          |
| `1`  | `IMAGE_INPUT`、`NETWORK_UNAVAILABLE`、`SERVICE_UNAVAILABLE`、`RATE_LIMITED`、`PROVIDERS_FAILED` 等 | 按 stderr 的 `Agent 下一步` 修正输入、网络、服务状态、配额或模型配置 |
| `2`  | `KEY_REQUIRED`                                     | 按错误中提供的注册地址配置有效 Key 后重试        |

stderr 固定格式：

```text
[ERROR] <CODE>: <message>
```

常见检查：

```powershell
npm run doctor
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
