# 故障排查与恢复

仅在实际进入 img2txt SOP 后，处理依赖、密钥、代理、退出码或 Provider 调用失败时读取本文件。Agent 原生处理不需要运行 doctor、配置 SOP Provider Key 或读取本文件。

## 先确认执行路径

- 当前模型支持图片输入且用户未显式要求 `img2txt`：由 Agent 原生处理，结果标注 `[识别方式: Agent 原生视觉]`。
- 用户显式要求 `img2txt`，或当前模型不支持图片输入：进入 img2txt SOP。
- 系统剪贴板只是最后一级输入回退，不作为进入 SOP 的条件。Agent 取得图片后，再按上述两条选择执行路径。
- 原生视觉不可用但已有真实路径、URL、Data URL 或 Base64 时，直接把这些输入交给 SOP，不读取剪贴板。

## Claude Code / OpenCode 会话附件恢复

以下提示说明本回合存在图片，但当前模型没有取得图片像素：

- Claude Code：`[Image #n]`、`[Unsupported Image]`、`Cannot read "..." (this model does not support image input)`。
- OpenCode：`Image input unsupported error`、`Image input error: model cannot read image.png`、`Image input not supported by model`。

报错给出真实绝对路径时直接走 SOP。只有显示名、占位符或无路径报错时，在 Skill 目录运行：

```powershell
node scripts/recover_session_images.js --client auto --cwd 'C:\当前会话工作目录'
```

```bash
node scripts/recover_session_images.js --client auto --cwd 'C:/当前会话工作目录'
```

恢复器只读取限定时间内、工作目录匹配的用户图片 part，并将统一网关校验后的图片写入系统临时目录。它不输出对话正文或 Base64。使用返回 JSON 的 `images[].path` 进入 SOP；如果返回 `SESSION_AMBIGUOUS`，使用错误中对应的当前会话 ID 加 `--session <id>` 重试。

会话中没有可恢复图片时，再运行一次 `node scripts/describe_image.js clipboard '描述图片内容'`。不要手写 `powershell -Command ... Clipboard`；Claude Code 的 Bash 会先展开 `$img` 等 PowerShell 变量，造成“应为表达式”、乱码或空变量错误。会话恢复和内置剪贴板都失败后，才请用户重新粘贴、上传或提供真实路径。

## 命令行说明

先确认当前命令执行器是 CMD、PowerShell、Bash、zsh 还是 Git Bash/MSYS，不要混用语法。所有终端都使用 `scripts/describe_image.js`；Bash/zsh 中将 Windows 本地路径写成 `C:/...` 并使用单引号，避免反斜杠被解释为转义字符。

如果工具支持 `cwd` 或 `workdir`，直接将其设置为 Skill 目录。必须在命令中切换目录时，分别使用：

```cmd
cd /d "C:\path\to\img2txt"
```

```powershell
Set-Location -LiteralPath 'C:\path\to\img2txt'
```

```bash
cd 'C:/path/to/img2txt'
```

## 依赖检查

本会话首次进入 SOP 或 SOP 发生运行错误后，从 Skill 目录运行：

```cmd
npm run doctor
```

Doctor 会检查 Node.js 版本、`sharp`、`bmp-ts`、`https-proxy-agent` 和两个 Provider 的 Key 配置，只报告 Key 是否存在，不输出 Key 内容。只有返回 `DEPENDENCY` 时才安装锁定依赖：

```cmd
npm ci --omit=dev
```

不要在每次识图请求前重复执行安装。

## API Key

支持：

- `ZHIPU_API_KEY`
- `GEMINI_API_KEY`

注册地址：

- 智谱：[https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys)
- Gemini：[https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)

不要要求用户在聊天中发送 Key，也不要通过标准输入或命令参数把用户发来的 Key 传给脚本。Windows 用户在自己的终端设置当前用户环境变量：

```cmd
setx ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_GEMINI_API_KEY"
```

`setx` 不会修改已经运行的进程。脚本会直接读取用户级持久化值，因此可以在当前会话重新调用。
macOS 用户在启动 Agent 的同一 shell 环境中配置进程环境变量：

```bash
export ZHIPU_API_KEY='YOUR_ZHIPU_API_KEY'
export GEMINI_API_KEY='YOUR_GEMINI_API_KEY'
npm run doctor
```

Windows 设置或更新后直接运行 `npm run doctor`，脚本会读取用户环境变量，无需重启 Agent。macOS 的 Agent 进程必须继承上述环境变量。看到至少一个 `API_KEY: 已配置` 后重新执行识图。脚本不支持通过标准输入或命令参数接收 Key，也不会自动持久化。

## CLI 剪贴板兼容

系统剪贴板是会话附件恢复失败后的最后回退。内置 CLI 的 `clipboard` 输入在 Windows 直接调用 PowerShell 参数数组，不依赖 Bash 拼接。macOS 使用系统自带的 `osascript`/AppKit，不依赖 `pngpaste` 或其他 Homebrew 工具。`clipboard-fallback` 仅作为 CLI 兼容参数保留。

缺少 Key 或 Provider 失败时，CLI 可能返回 `img2txt_retry_*` 临时路径。完成本机 Key 配置并通过 doctor 后，使用该路径重试。

### macOS 实机验收

先复制一张截图，再在 Skill 目录运行：

```bash
node scripts/describe_image.js clipboard '描述图片内容'
```

随后在 Finder 中复制一个图片文件并重复命令。两次都应进入视觉模型，且临时目录中不应残留 `vision_clip_*.png`。如果 stderr 报告无法调用 `osascript`，确认命令存在且当前终端/Agent 有权读取系统剪贴板。

## 轮询状态

stderr 中以下状态用于主 Agent 判断进度，不是图片内容：

- `PROVIDER_AVAILABLE`：Key 已配置，Provider 已加入本次固定队列。
- `PROVIDER_SKIPPED`：Key 未配置，本次不调用该 Provider。
- `PROVIDER_SWITCH`：当前 Provider 发生 Provider 级故障，消息包含原因和下一 Provider。
- `PROVIDER_FAILED`：当前 Provider 发生 Provider 级故障且没有更多可用 Provider。
- `MODEL_SWITCH`：当前模型失败，消息包含错误代码、原因和下一模型或 Provider。
- `MODEL_FAILED`：当前模型失败且没有更多可用目标。

不要在看到 `MODEL_SWITCH` 时提前回复失败；等待进程最终退出。成功时 stdout 末尾的 `[识别模型: provider/model]` 必须保留到最终用户回答。

## 错误处理

| 退出码 | 处理方式                                                   |
| ------ | ---------------------------------------------------------- |
| `0`  | 使用 stdout 继续回答用户                                   |
| `1`  | 根据 stderr 的错误代码修正输入、依赖、网络或 Provider 问题 |
| `2`  | 展示注册地址和设置命令，指导用户在本机配置有效 Key         |

stderr 固定格式：

```text
[ERROR] <CODE>: <message>
```

常见错误：

- `IMAGE_INPUT`：确认路径真实存在；不要猜测文件名；远程 URL 必须是公网地址。Bash 中把 Windows 路径写成 `C:/...`。Bing 的 `/th/id/` 缩略图链接会自动切换到稳定的 `global.bing.com` 图片域名。
- `CONFIG`：检查模型列表和超时配置。
- `KEY_REQUIRED`：指导用户在本机配置或更新至少一个 Provider 的 Key 并运行 doctor；不要索取 Key。
- `NETWORK_UNAVAILABLE`：检查出站网络、代理和 `VISION_API_TIMEOUT_MS` 后重试。
- `SERVICE_UNAVAILABLE`：Provider 服务暂不可用；稍后重试或检查官方服务状态。
- `RATE_LIMITED`：等待配额恢复，或配置另一 Provider 的有效 Key。
- `PROVIDERS_FAILED`：按错误中的每个模型原因检查模型可用性、输入和 Provider 状态；必要时读取 `references/provider_limits.md`。
- `UNEXPECTED`：先运行 `npm run check` 和 `npm test`，不要向用户输出 Node 堆栈。

## 代理

Provider 请求支持 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。代理连接失败时确认代理 URL、端口和 `NO_PROXY` 主机匹配规则，不要在日志中输出包含认证信息的代理 URL。
