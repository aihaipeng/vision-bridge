# 故障排查与恢复

仅在依赖、密钥、代理、剪贴板、退出码或 Provider 调用失败时读取本文件。

## 命令行说明

先确认当前命令执行器是 CMD、PowerShell 还是 Bash/Git Bash/MSYS，不要混用语法。所有终端都使用 `scripts/describe_image.js`；Bash 中将 Windows 本地路径写成 `C:/...` 并使用单引号，避免反斜杠被解释为转义字符。

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

本会话首次使用或发生运行错误后，从 Skill 目录运行：

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

不要要求用户在聊天中发送 Key，也不要通过标准输入或命令参数把用户发来的 Key 传给脚本。请用户在自己的终端设置 Windows 当前用户环境变量：

```cmd
setx ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_GEMINI_API_KEY"
```

`setx` 不会修改已经运行的进程。脚本会直接读取用户级持久化值，因此可以在当前会话重新调用。
设置或更新后直接运行 `npm run doctor`；脚本会读取 Windows 用户环境变量，无需重启 Agent。看到至少一个 `API_KEY: 已配置` 后重新执行识图。脚本不支持单次 Key，也不会自动持久化 Key。

## 剪贴板与重试缓存

`clipboard` 优先读取 Windows 剪贴板位图，没有位图时回退到文件列表中的第一个图片文件。

用户在当前请求中明确说明图片位于剪贴板时，调用 `clipboard`。另有一个严格受限的自动例外：当前消息确有平台图片附件，但平台没有提供可读取的真实路径时，立即调用 `clipboard-fallback`，不要先询问用户是否处理。脚本会在读取前输出 `CLIPBOARD_FALLBACK`，成功后在 stdout 标注剪贴板来源。

以下情况不授权自动读取剪贴板：过去消息中的图片、纯文本中的 `image.png`、用户转述或粘贴的 Unsupported Image 错误、普通路径不存在、已有文件无法解码。无法确认当前消息确有图片附件时，不要使用 `clipboard-fallback`。

如果当前图片附件只有显示名而没有可读取的真实路径：

1. 不要把显示名当路径，也不要检查或搜索工作目录。
2. 立即使用 `clipboard-fallback` 读取当前 Windows 剪贴板一次。
3. 成功时保留 stdout 中的 `[图片来源: Windows 剪贴板（附件路径缺失回退）]`；失败时按错误中的 `Agent 下一步` 请用户重新上传或提供绝对路径。

在 OpenCode 或 Claude Code 中粘贴到聊天的图片不一定仍保留在 Windows 剪贴板中。如果 `clipboard-fallback` 返回 `IMAGE_INPUT`：

1. 不要重复调用剪贴板，不要检查工作目录，也不要猜测文件名。
2. 请用户提供图片的绝对路径，或重新上传为会话能够提供真实路径的附件。
3. 取得路径后使用原问题重新调用脚本，不要再读取剪贴板。

缺少 Key 或 Provider 失败时，脚本可能返回 `img2txt_retry_*` 临时路径。用户完成本机配置并通过 doctor 验证后，使用该路径重试，不要再次读取剪贴板。受控回退缓存会保留剪贴板来源标记，后续成功输出仍会注明来源。成功后缓存立即删除；超过缓存有效期的文件会在后续调用启动时清理。

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
