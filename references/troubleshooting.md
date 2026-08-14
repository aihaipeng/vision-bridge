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

从 Skill 目录运行：

```cmd
node -e "require('sharp'); require('bmp-ts')"
```

只有该命令失败时才安装锁定依赖：

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

设置 Windows 当前用户环境变量：

```cmd
setx ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_GEMINI_API_KEY"
```

`setx` 不会修改已经运行的进程。脚本会直接读取用户级持久化值，因此可以在当前会话重新调用。

用户直接提供新 key 时，通过标准输入传递，禁止放进命令参数。

CMD：

```cmd
(echo GEMINI_API_KEY=YOUR_GEMINI_API_KEY)| node scripts/describe_image.js "C:\path\to\image.png" "描述图片内容"
(echo ZHIPU_API_KEY=YOUR_ZHIPU_API_KEY)| node scripts/describe_image.js "C:\path\to\image.png" "描述图片内容"
```

PowerShell：

```powershell
'GEMINI_API_KEY=YOUR_GEMINI_API_KEY' | node scripts/describe_image.js "C:\path\to\image.png" "描述图片内容"
'ZHIPU_API_KEY=YOUR_ZHIPU_API_KEY' | node scripts/describe_image.js "C:\path\to\image.png" "描述图片内容"
```

Bash/Git Bash/MSYS：

```bash
printf '%s\n' 'GEMINI_API_KEY=YOUR_GEMINI_API_KEY' | node scripts/describe_image.js 'C:/path/to/image.png' '描述图片内容'
printf '%s\n' 'ZHIPU_API_KEY=YOUR_ZHIPU_API_KEY' | node scripts/describe_image.js 'C:/path/to/image.png' '描述图片内容'
```

只有视觉请求实际成功后，脚本才把标准输入中的 key 持久化到当前用户环境变量。

## 剪贴板与重试缓存

`clipboard` 优先读取 Windows 剪贴板位图，没有位图时回退到文件列表中的第一个图片文件。

只有用户在当前请求中明确说明图片位于剪贴板或要求读取剪贴板时，才能调用 `clipboard`。聊天附件路径缺失、附件仅显示为 `image.png`，或直接图片读取工具报“不支持图片输入”时，不得自动检查剪贴板：剪贴板可能保留与当前请求无关的私密内容，不能作为附件的隐式后备来源。

如果附件只有显示名而没有可读取的真实路径：

1. 确认该显示名在当前工作目录中是否确实存在；只检查给定路径，不搜索同名文件。
2. 不存在时请用户重新上传为带真实路径的附件，或提供图片的绝对路径。
3. 只有用户随后明确指定剪贴板，才改用 `clipboard`。

在 OpenCode 或 Claude Code 中粘贴到聊天的图片不一定仍保留在 Windows 剪贴板中。如果脚本返回 `IMAGE_INPUT: 剪贴板中没有图片`：

1. 不要重复调用 `clipboard`，也不要猜测文件名。
2. 请用户提供图片的绝对路径，或重新上传为会话能够提供真实路径的附件。
3. 取得路径后使用原问题重新调用脚本，不要再读取剪贴板。

缺少 key 或 Provider 失败时，脚本可能返回 `img2txt_retry_*` 临时路径。取得 key 后使用该路径重试，不要再次读取剪贴板。成功后缓存立即删除；超过缓存有效期的文件会在后续调用启动时清理。

## 错误处理

| 退出码 | 处理方式                                                   |
| ------ | ---------------------------------------------------------- |
| `0`  | 使用 stdout 继续回答用户                                   |
| `1`  | 根据 stderr 的错误代码修正输入、依赖、网络或 Provider 问题 |
| `2`  | 展示注册地址和设置命令，请用户提供或配置有效 key           |

stderr 固定格式：

```text
[ERROR] <CODE>: <message>
```

常见错误：

- `IMAGE_INPUT`：确认路径真实存在；不要猜测文件名；远程 URL 必须是公网地址。Bash 中把 Windows 路径写成 `C:/...`。Bing 的 `/th/id/` 缩略图链接会自动切换到稳定的 `global.bing.com` 图片域名。
- `CONFIG`：检查 `VISION_PROVIDER` 和超时配置。
- `KEY_REQUIRED`：配置至少一个 Provider 的有效 key 后重试。
- `PROVIDERS_FAILED`：检查网络、代理、模型可用性和图片限制；必要时读取 `references/provider_limits.md`。
- `UNEXPECTED`：先运行 `npm run check` 和 `npm test`，不要向用户输出 Node 堆栈。

## 代理

Provider 请求支持 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。代理连接失败时确认代理 URL、端口和 `NO_PROXY` 主机匹配规则，不要在日志中输出包含认证信息的代理 URL。
