---
name: img2txt
description: 统一读取本地路径、file URL、公开网络 URL、Data URL、Base64、上传附件或 Windows 剪贴板中的图片，并调用智谱 GLM 或 Gemini 视觉模型返回文字结果。用于看图、描述图片、分析截图、解释图表和识别图片文字。用户仅发送图片、附件、图片路径或图片 URL 而没有文字说明时也必须立即使用；当前 Agent 或系统报告 Unsupported Image、图片无法显示、无法加载或无法直接读取时，必须改用本技能，不得询问用户是否调用视觉模型或想对图片做什么。没有明确任务时默认详细描述图片。
---

# 图像转文本（img2txt）

通过统一输入网关读取图片，在内存中完成解码、安全校验、方向纠正与格式转换，再调用可用的视觉 Provider。所有来源都必须经过同一网关，Provider 只接收网关输出的 JPEG 或 PNG；透明内容保持 PNG。默认优先智谱 GLM，失败后自动回退 Gemini。

## 默认行为

- 用户仅发送图片且没有文字说明时，立即运行脚本并详细描述图片，不询问用途。
- 原生读取返回 `Unsupported Image`、无法显示或无法加载时，使用附件元数据中的真实路径运行脚本；这不是停止条件。
- 用户明确要求 OCR、分析、比较或其他图片任务时，将该要求作为问题传给脚本。

## 工作流

1. 将命令的工作目录设置为本 `SKILL.md` 所在目录。优先使用工具提供的 `cwd`/`workdir` 参数，避免在命令文本中拼接 `cd`。
2. 按“输入选择顺序”确定唯一图片输入，不猜测文件名。附件已经提供真实路径时直接使用，不再次尝试原生读取。
3. 检查运行依赖。只有 `node -e "require('sharp'); require('bmp-ts')"` 失败时才运行 `npm ci --omit=dev`。
4. 执行脚本时始终写成 `scripts/describe_image.js`，不要使用反斜杠连接 `scripts` 和文件名。普通文件与剪贴板分别使用：

   ```cmd
   node scripts/describe_image.js "C:\path\to\image.png" "描述图片内容"
   node scripts/describe_image.js clipboard "提取可见文字"
   ```

   当前命令执行器是 Bash、Git Bash 或 MSYS 时，将 Windows 本地文件路径改为正斜杠并逐个引用参数：

   ```bash
   node scripts/describe_image.js 'C:/path/to/image.png' '描述图片内容'
   node scripts/describe_image.js clipboard '提取可见文字'
   ```

5. 退出码为 `0` 时，把 stdout 作为图片内容继续回答用户，不暴露 Provider 调用细节。
6. 出现 `KEY_REQUIRED` 时，向用户展示错误中给出的注册地址和设置命令。用户提供 key 后，使用带 Provider 前缀的标准输入重试。
7. 其他失败按 `references/troubleshooting.md` 处理；不要把 stderr 或堆栈伪装成识图结果。

问题可省略。用户没有文字说明时不要追问，直接使用默认问题 `请详细描述这张图片的内容`。

## 输入选择顺序

1. 使用消息附件或 `<image ... path="...">` 元数据中的真实绝对路径。
2. 使用用户明确提供或 `@` 引用的文件路径。
3. 使用用户提供的远程 URL、Data URL 或 Base64。
4. 仅当用户明确说明图片位于剪贴板或明确要求读取剪贴板时使用 `clipboard`。

支持本地绝对或相对路径、`file://` URL、公开 `http(s)` URL、Data URL、裸 Base64、SVG 文本和 Windows 剪贴板。文件名和扩展名不参与格式判定；内容能被 Sharp/libvips 或内置 BMP 解码器识别即可进入标准化流程。

禁止猜测 `image.png`、`screenshot.png` 等文件名，也不要搜索推测出的文件。

聊天中出现的 `image.png` 等显示名不等于可读取路径。如果附件元数据没有真实路径，或路径在当前会话中不存在，说明图片字节没有传递给技能：不要把同名文件当作附件，不要自动回退到剪贴板；直接请用户重新上传为带真实路径的附件，或提供本地绝对路径。读取剪贴板属于独立输入操作，不能用来猜测或恢复缺失附件。

## 运行要求

- Windows 10/11，以及 CMD、PowerShell 5+、Bash、Git Bash 或 MSYS
- Node.js 20.9+ 和 npm
- 访问智谱或 Gemini API 的出站 HTTPS 网络
- 使用 `clipboard` 时允许读取 Windows 剪贴板

## Provider 与密钥

脚本自动完成模型选择、图片准备、重试和跨 Provider 回退。Gemini 返回带模型维度的配额 429 时，不等待该模型恢复，直接尝试下一模型；Provider 级 429 带明确恢复时间时，直接切换备用 Provider。用户显式指定 GLM、Gemini 或具体模型时，脚本调整首选顺序，并忽略“不要使用”等否定上下文中的模型名称，但仍保留备用 Provider。

支持 `ZHIPU_API_KEY` 和 `GEMINI_API_KEY`。密钥读取顺序为：带 Provider 前缀的标准输入、Windows 当前用户环境变量、当前进程环境变量。

禁止把 API key 写入仓库文件、命令参数、日志或最终回复。首次配置、持久化和认证恢复步骤见 `references/troubleshooting.md`。

## 输出协议

- 成功：退出码 `0`，stdout 仅包含视觉模型返回的文字。
- 普通失败：退出码 `1`，stdout 为空，stderr 为 `[ERROR] <CODE>: <message>`。
- 缺少或认证失败：退出码 `2`，错误代码为 `KEY_REQUIRED`，stdout 为空。

## 关键约束

- 只要消息包含有效图片输入，立即运行本技能；不要先回复“当前模型不支持图片”，也不要询问用户想对图片做什么。
- 不要把路径解析放进 Provider。Provider 只接收输入网关产生的统一图片对象。
- 不要根据扩展名、URL 后缀或 Data URL 声明跳过校验；实际字节必须统一解码并标准化为 JPEG/PNG。
- 不要在 Provider 中自行扁平化透明区域或忽略 EXIF 方向；输入网关和图片准备器负责保持可见内容一致。
- 不要混用 Shell 语法。Bash 中脚本路径和 Windows 路径参数都必须使用正斜杠。
- 图片可能上传到所选云端 Provider；不要处理未经授权的身份证、合同、凭证等敏感图片。
- 未经用户在当前请求中明确指定，不要读取、描述或透露剪贴板内容。附件读取失败不构成剪贴板授权。
- 剪贴板失败重试应使用脚本返回的缓存路径，避免输入 key 时覆盖剪贴板图片。
- `clipboard` 返回“剪贴板中没有图片”时，说明聊天中的粘贴图片没有作为 Windows 剪贴板位图传递。不要重复调用 `clipboard`，立即请用户提供绝对路径或重新上传为带路径的附件。
- 不要将 `glm-4v-flash` 配置为智谱视觉模型，它不支持当前 Base64 图片调用方式。

## 按需参考

- 修改模型、格式、压缩策略、路由或 API 限制时，读取 `references/provider_limits.md`。
- 处理依赖、密钥、代理、剪贴板、退出码或失败恢复时，读取 `references/troubleshooting.md`。

## 验证

在 Skill 目录运行：

```cmd
npm run check
npm test
```
