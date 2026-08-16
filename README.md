# vision-bridge

## 1. 项目简介 (Introduction)

`vision-bridge` 是一个面向编码智能体的图像理解 Skill，让未取得图片内容或不支持图片输入的模型也能完成 OCR、图片描述、视觉分析、错误诊断和多图比较。

### 核心功能点 (Features)

- 提取图片中的可见文字、代码、表格和字段，并尽量保留阅读顺序与结构。
- 描述人物、物体、场景、布局、界面状态和显著细节。
- 分析截图、图表、流程图、文档影像及视觉关系，并按用户问题给出结论。
- 根据错误截图区分可见证据与可能原因，提供可执行的排查步骤。
- 并行处理多张图片，保留输入顺序、逐图结果、共同点、差异和失败项。
- 统一接收本地路径、`file://` URL、公开 HTTP(S) URL、Data URL、Base64、系统剪贴板及恢复后的会话附件。
- 自动校验真实图片格式、转换图片并按 GLM、Gemini 的固定顺序回退。
- 在成功结果末尾保留实际使用的 `[识别模型: provider/model]`，便于追溯。

### 适用边界

在以下情况使用 `vision-bridge`：

- 用户明确要求使用 `vision-bridge`。
- 当前模型不支持读取图片。


## 2. 快速开始 (Quick Start)

### 前提条件

- Windows 10/11, macOS。
- Node.js 20.9 或更高版本及 npm。
- Git，用于从仓库安装或更新 Skill。
- 可访问智谱或 Gemini API 的出站 HTTPS 网络。
- 至少配置一个 `ZHIPU_API_KEY` 或 `GEMINI_API_KEY`。

### 安装步骤

将仓库克隆到当前客户端或项目配置的 Skill 目录。不同客户端的目录规则不同，请把示例中的路径替换为实际的 `<skills-dir>`。

Windows CMD：

```cmd
set "SKILLS_DIR=C:\path\to\your\skills"
git clone https://github.com/aihaipeng/vision-bridge.git "%SKILLS_DIR%\vision-bridge"
cd /d "%SKILLS_DIR%\vision-bridge"
npm ci --omit=dev
npm run doctor
```

macOS Bash/zsh：

```bash
SKILLS_DIR='/path/to/your/skills'
git clone https://github.com/aihaipeng/vision-bridge.git "$SKILLS_DIR/vision-bridge"
cd "$SKILLS_DIR/vision-bridge"
npm ci --omit=dev
npm run doctor
```

如果仓库已经位于正确的 Skill 目录，只需进入仓库并执行：

```bash
npm ci --omit=dev
npm run doctor
```

### 配置 API Key

智谱 Key 注册地址：<https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys>

Gemini Key 注册地址：<https://aistudio.google.com/apikey>

Windows CMD：

```cmd
setx ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx GEMINI_API_KEY "YOUR_GEMINI_API_KEY"

reg query "HKCU\Environment" /v ZHIPU_API_KEY >nul 2>&1 && echo ZHIPU_API_KEY=SET || echo ZHIPU_API_KEY=NOT_SET
reg query "HKCU\Environment" /v GEMINI_API_KEY >nul 2>&1 && echo GEMINI_API_KEY=SET || echo GEMINI_API_KEY=NOT_SET
```

macOS Bash/zsh：

```bash
export ZHIPU_API_KEY='YOUR_ZHIPU_API_KEY'
export GEMINI_API_KEY='YOUR_GEMINI_API_KEY'

[ -n "$ZHIPU_API_KEY" ] && echo ZHIPU_API_KEY=SET || echo ZHIPU_API_KEY=NOT_SET
[ -n "$GEMINI_API_KEY" ] && echo GEMINI_API_KEY=SET || echo GEMINI_API_KEY=NOT_SET
```


配置后运行：

```bash
npm run doctor
```

### 调用案例
Coding Agent 以 OpenCode Desktop、Claude Code CLI、Reasonix、ZCode为例, 模型使用 deepseek-v4-pro
<img width="2558" height="1387" alt="image" src="https://github.com/user-attachments/assets/508bd7d7-24df-4856-aac4-cc6c5365def0" />

其中ZCode直接传入图片并发送后会报错，此时需要指定图片路径并显式调用 vision-bridge skill。
<img width="1198" height="798" alt="image" src="https://github.com/user-attachments/assets/748ea696-a2e0-45b3-a3bd-01ea5d962cd8" />
<img width="1198" height="1094" alt="image" src="https://github.com/user-attachments/assets/b8402be6-99c0-4a84-b61f-b0e07a132765" />


## 3. 目录结构说明 (Directory Structure)

```text
vision-bridge/
├── SKILL.md                         # Skill 入口、触发边界与执行工作流
├── README.md                        # 安装、配置、使用和维护说明
├── package.json                     # Node.js 版本、依赖和验证命令
├── package-lock.json                # 锁定的 npm 依赖版本
├── scripts/
│   ├── describe_image.js            # 图片识别 CLI 与 Provider 路由
│   ├── recover_session_images.js    # Claude Code/OpenCode 会话附件恢复
│   ├── doctor.js                    # 运行环境、依赖和 Key 诊断
│   ├── image_input_resolver.js      # 路径、URL、Base64、SVG、剪贴板输入网关
│   ├── image_preparer.js            # 图片校验、标准化、压缩与尺寸控制
│   ├── key_store.js                 # 从本机环境安全读取 Provider Key
│   ├── errors.js                    # 统一错误结构
│   └── providers/
│       ├── http.js                  # HTTP、代理、超时和网络错误处理
│       ├── zhipu.js                 # 智谱视觉 Provider 适配器
│       └── gemini.js                # Gemini 视觉 Provider 适配器
└── references/
    ├── provider_limits.md           # Provider、模型和图片限制
    └── troubleshooting.md           # 依赖、Key、代理和失败恢复
```

## 支持的输入

| 输入来源 | 示例 | 说明 |
| -------- | ---- | ---- |
| 本地绝对或相对路径 | `C:\images\shot.png` | 相对路径以 Agent 当前工作目录为基准 |
| `file://` URL | `file:///C:/images/shot.png` | 转换为本地路径后读取 |
| 公开 HTTP(S) URL | `https://example.com/image.jpg` | 拒绝私网、回环和带用户名密码的 URL |
| Data URL | `data:image/png;base64,...` | 必须声明为 `image/*` |
| 裸 Base64 | `iVBORw0KGgo...` | 解码后仍执行真实格式校验 |
| SVG 文本 | `<svg ...>...</svg>` | 渲染为 PNG 后发送 |
| 聊天附件路径 | Agent 提供的真实绝对路径 | 仅显示名不等于可读取路径 |
| 会话附件恢复 | `recover_session_images.js` | 支持 Claude Code 和 OpenCode |
| 系统剪贴板 | `clipboard` | 用户明确指定时读取；也可作为会话恢复失败后的单次回退 |

问题参数可以省略，默认问题为 `请详细描述这张图片的内容`。


## 默认模型顺序

| Provider | 模型 |
| -------- | ---- |
| GLM | `glm-4.1v-thinking-flash` |
| GLM | `glm-4.6v-flash` |
| Gemini | `gemini-3.7-flash` |
| Gemini | `gemini-3.6-flash` |
| Gemini | `gemini-3.5-flash` |
| Gemini | `gemini-flash-latest` |

## 图片格式与限制

- 支持 JPEG、PNG、WebP、TIFF、GIF 第一帧、BMP 和 SVG。
- AVIF、HEIC、HEIF 及其他格式取决于当前 Sharp/libvips 构建的解码能力。
- 本地文件或远程下载最大 32 MB，解码后最大 100,000,000 像素。
- 远程 URL 最多跟随 5 次重定向，每次都重新执行公网地址校验。
- Provider 最终只接收标准化后的 JPEG 或 PNG；超出 Provider 限制时会先压缩，再按需降低分辨率。
- 损坏图片、HTML、伪造图片声明或不支持的数据会在调用 Provider 前返回 `IMAGE_INPUT`。

更完整的格式和模型限制见 [`references/provider_limits.md`](references/provider_limits.md)。

### 官方参考

- [Gemini API Key](https://aistudio.google.com/apikey)
- [Gemini 图片理解](https://ai.google.dev/gemini-api/docs/image-understanding)
- [智谱 API Key 管理](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys)
- [智谱对话补全 API](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8)
- [智谱视觉模型](https://docs.bigmodel.cn/cn/guide/models/vlm)
- [Apple NSPasteboard](https://developer.apple.com/documentation/appkit/nspasteboard)
