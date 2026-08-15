# 🖼️ img2txt

`img2txt` 是一个面向智能体的图像理解 Skill，可集成到 Claude Code、Codex、OpenCode 、Reasonix 等智能体。  

能力：

- 提取图片中的可见文字（OCR）
- 描述和分析图片、截图、界面、图表、流程图及错误信息
- Agent 可从附件、路径、URL、Base64 或系统剪贴板取得图片


## ⚙️ 执行边界

Agent 原生处理只依赖当前 Agent 的图片能力，不需要本仓库运行时、Provider Key 或额外网络请求。

img2txt SOP 需要：

- Windows 10/11，或带系统 `osascript`/AppKit 的 macOS
- Node.js 20.9 或更高版本及 npm
- 可访问智谱或 Gemini API 的出站 HTTPS 网络
- 至少一个 Provider API Key

## 🚀 快速开始

直接在对话中上传图片或提供图片来源，并说明任务。例如：

- 上传图片后说：“请详细描述这张图片。”
- 提供本地路径：“提取 `C:\images\receipt.png` 中的文字。”
- 提供公开 URL：“分析 `https://example.com/chart.png` 中的数据趋势。”
- 使用剪贴板：“读取剪贴板中的截图并解释报错。”
- 显式 SOP：“使用 img2txt 提取这张图片中的文字。”

仅发送图片而不附带说明时，具备视觉能力的 Agent 会直接详细描述并标注原生视觉，不进入 SOP。只有进入 img2txt SOP 时才需要配置 Provider API Key。

## 🔑 SOP API Key

智谱：https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys

Gemini：https://aistudio.google.com/apikey

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

### macOS Bash/zsh

```bash
# 设置 apikey
export ZHIPU_API_KEY='YOUR_ZHIPU_API_KEY'
export GEMINI_API_KEY='YOUR_GEMINI_API_KEY'

# 验证是否已配置，不输出 Key
[ -n "$ZHIPU_API_KEY" ] && echo ZHIPU_API_KEY=SET || echo ZHIPU_API_KEY=NOT_SET
[ -n "$GEMINI_API_KEY" ] && echo GEMINI_API_KEY=SET || echo GEMINI_API_KEY=NOT_SET

# 更新 apikey
export ZHIPU_API_KEY='YOUR_NEW_ZHIPU_API_KEY'
export GEMINI_API_KEY='YOUR_NEW_GEMINI_API_KEY'

# 删除 apikey
unset ZHIPU_API_KEY
unset GEMINI_API_KEY
```

`export` 只对当前 shell 生效，Agent 进程必须继承这些环境变量。永久生效时把两行 `export` 写入 `~/.zshrc`（zsh）或 `~/.bash_profile`（bash），再 `source` 或在同一 shell 中启动 Agent。配置后运行：

```bash
npm run doctor
```

脚本不会从聊天、标准输入或命令参数接收 Key。

## 🤖 SOP 支持的模型

模型按表格顺序自动轮询。

| Provider | 模型                        | 说明                                                                 | 
| -------- | --------------------------- | ------------------------------------------------------------------------ |
| GLM      | `glm-4.1v-thinking-flash` | 偏视觉思考与推理的 GLM 多模态模型，适合需要分析过程的图片理解任务。      | 
| GLM      | `glm-4.6v-flash`          | GLM Flash 视觉模型，用于快速图像理解，并作为智谱模型池的第二顺位。       | 
| Gemini   | `gemini-3.7-flash`        | 固定版本的 Gemini Flash 多模态模型。            | 
| Gemini   | `gemini-3.6-flash`        | 固定版本的 Gemini Flash 多模态模型，用于 3.7 不可用时继续处理请求。      | 
| Gemini   | `gemini-3.5-flash`        | 固定版本的 Gemini Flash 多模态模型，提供更深一层的版本回退。             | 
| Gemini   | `gemini-flash-latest`     | 指向当前最新 Gemini Flash 的浮动别名，实际版本可能随 Google 更新而变化。 | 


## 📥 SOP 支持的图片输入

| 输入来源           | 示例                              | 说明                               |
| ------------------ | --------------------------------- | ---------------------------------- |
| 本地绝对或相对路径 | `C:\images\shot.png`            | 支持有扩展名和无扩展名文件         |
| `file://` URL    | `file:///C:/images/shot.png`    | 转换为本地路径后读取               |
| 公开 HTTP(S) URL   | `https://example.com/image.jpg` | 拒绝私网、回环和带用户名密码的 URL |
| Data URL           | `data:image/png;base64,...`     | 必须声明为`image/*`              |
| 裸 Base64          | `iVBORw0KGgo...`                | 解码后仍执行真实格式校验           |
| SVG 文本           | `<svg ...>...</svg>`            | 渲染为 PNG 后发送                  |
| 聊天附件路径       | Agent 提供的真实绝对路径          | 仅显示名不等于可读取路径           |

## 🖼️ SOP 支持的图片格式

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

- Agent 原生处理遵循当前平台的图片处理与隐私策略；SOP 会把图片与问题上传到实际轮询到的视觉 Provider。
- 请仅处理已获授权的内容。
- 系统剪贴板由 Agent 读取，不作为进入 SOP 的条件。
- 远程 URL 拒绝私网、回环、链路本地、UNC 和带凭据的地址。
- API Key 通过请求头发送，不写入 URL 或输出；请勿在聊天中发送 Key。

## 🩺 SOP 故障排查

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
- [Apple NSPasteboard](https://developer.apple.com/documentation/appkit/nspasteboard)
