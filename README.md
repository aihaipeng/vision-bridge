<a id="top"></a>

# 👁️ vision-bridge

> Image understanding for coding agents, even when the active model cannot read images.

[中文](#chinese) | [English](#english)

<a id="chinese"></a>

## 🇨🇳 中文说明

### ✨ 项目简介

`vision-bridge` 是面向智能体的图像理解 Skill。支持接入多家提供免费额度的视觉模型；用户只需向任一支持的 Provider 申请 API Key 并在本地完成配置，即可在免费额度内使用。当前模型无法取得图片内容或不支持图片输入时，`vision-bridge` 可自动调用已配置的视觉模型完成：

- OCR、代码、表格与界面文字提取
- 人物、物体、场景、布局和状态描述
- 截图、图表、流程图、文档影像和错误信息分析
- 多图比较、内容去重、逐项结果与失败恢复

仅在用户明确要求使用 `vision-bridge`，或当前模型无法读取图片时调用。普通可直接看图的请求应由当前 Agent 原生处理。

### 🚀 快速开始

#### 📦 环境要求

- Windows 10/11 或 macOS
- Node.js 20.9.0+ 与 npm
- 可访问至少一个 Provider 的出站 HTTPS 网络
- 至少一个 Provider API Key

#### 🛠️ 安装

将仓库克隆到客户端或项目使用的 Skill 目录：

```bash
git clone https://github.com/aihaipeng/vision-bridge.git
cd vision-bridge
npm ci --omit=dev
npm run doctor
```

更新已安装的 Skill：

```bash
git pull
npm ci --omit=dev
npm run doctor
```

#### 🔑 配置 API Key

| Provider | 环境变量 | 注册地址 |
|---|---|---|
| 智谱 | `VISION_BRIDGE_ZHIPU_API_KEY` | [BigModel](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys) |
| Gemini | `VISION_BRIDGE_GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| Mistral | `VISION_BRIDGE_MISTRAL_API_KEY` | [Mistral Console](https://console.mistral.ai/api-keys/) |
| NVIDIA | `VISION_BRIDGE_NVIDIA_API_KEY` | [NVIDIA Build](https://build.nvidia.com) |
| Cloudflare | `VISION_BRIDGE_CLOUDFLARE_API_TOKEN` + `VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID` | [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) |

Windows CMD：

```cmd
setx VISION_BRIDGE_ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx VISION_BRIDGE_GEMINI_API_KEY "YOUR_GEMINI_API_KEY"
setx VISION_BRIDGE_MISTRAL_API_KEY "YOUR_MISTRAL_API_KEY"
setx VISION_BRIDGE_NVIDIA_API_KEY "YOUR_NVIDIA_API_KEY"
setx VISION_BRIDGE_CLOUDFLARE_API_TOKEN "YOUR_CLOUDFLARE_API_TOKEN"
setx VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID "YOUR_CLOUDFLARE_ACCOUNT_ID"
npm run doctor
```

macOS Bash/zsh：

```bash
export VISION_BRIDGE_ZHIPU_API_KEY='YOUR_ZHIPU_API_KEY'
export VISION_BRIDGE_GEMINI_API_KEY='YOUR_GEMINI_API_KEY'
export VISION_BRIDGE_MISTRAL_API_KEY='YOUR_MISTRAL_API_KEY'
export VISION_BRIDGE_NVIDIA_API_KEY='YOUR_NVIDIA_API_KEY'
export VISION_BRIDGE_CLOUDFLARE_API_TOKEN='YOUR_CLOUDFLARE_API_TOKEN'
export VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID='YOUR_CLOUDFLARE_ACCOUNT_ID'
npm run doctor
```

不要在聊天、命令参数或标准输入中发送 Key。`VISION_BRIDGE_*` 命名空间可避免 Pi、CC Switch 等工具按厂商公共变量名自动发现凭据，但它不是加密凭据库。Windows 的 `setx` 不更新已运行进程，但脚本会读取用户级持久化环境变量。

### 🖼️ 输入与图片格式

| 输入来源 | 示例 | 说明 |
|---|---|---|
| 本地路径 | `C:\images\shot.png` | 支持绝对或相对路径 |
| `file://` URL | `file:///C:/images/shot.png` | 转换为本地路径后读取 |
| 公开 HTTP(S) URL | `https://example.com/image.jpg` | 拒绝私网、回环和带凭据 URL |
| 会话附件 | Claude Code/OpenCode 图片附件 | 无真实路径时由恢复器定位 |
| 系统剪贴板 | `clipboard` | 用户明确指定，或附件恢复失败后单次回退 |

支持 JPG、JPEG、PNG、WebP、TIFF、AVIF、SVG、GIF 第一帧和 BMP。本地文件或远程下载最大 32 MB，解码后最大 100,000,000 像素。Provider 最终只接收标准化后的 JPEG 或 PNG。

用户直接提供的 Data URL、裸 Base64 和原始 SVG 文本会被拒绝。会话适配器可在内部解析客户端已保存的 Data URL；这不是公开输入能力。

### 🧠 使用方式

#### 🖼️ 单图识别

```bash
node scripts/describe_image.js "C:/images/shot.png" "Extract the visible text"
```

问题可省略，默认提示为 `Describe this image in detail.`。

#### 🗂️ 多图批次

```json
{
  "prompt": "Compare these images",
  "items": [
    "C:/images/a.jpg",
    { "input": "https://example.com/b.webp", "prompt": "Extract the text" },
    { "source": { "kind": "session_attachment", "client": "opencode", "cwd": "C:/workspace" } }
  ]
}
```

```bash
node scripts/describe_images.js path/to/manifest.json
```

单批默认最多 3 张；取得/标准化默认并发为 1；Provider 任务默认全局并发为 3。单 Provider 在进程内和整台机器上默认并发均为 1。可通过以下变量调整：

- `VISION_BRIDGE_MAX_BATCH_ITEMS`
- `VISION_BRIDGE_ACQUIRE_CONCURRENCY`
- `VISION_BRIDGE_CONCURRENCY`（1-32）
- `VISION_BRIDGE_PROVIDER_CONCURRENCY`
- `VISION_BRIDGE_BATCH_TIMEOUT_MS`（可选，默认无整批超时）

脚本按标准化图片内容和提示词去重，保留输入顺序。单项失败不阻断其他项，但会让批次退出码变为 1。

只重试失败项：

```bash
node scripts/create_retry_manifest.js original-manifest.json batch-results.json > retry-manifest.json
node scripts/describe_images.js retry-manifest.json
```

#### 📎 会话附件恢复

当 Agent 只看到 `[Image #n]`、`Unsupported Image` 或无路径错误时：

```bash
node scripts/recover_session_images.js --client auto --cwd "C:/current/workspace"
```

使用返回 JSON 中的 `images[].path` 继续识别。若返回 `SESSION_AMBIGUOUS`，使用 `--session <id>` 指定当前会话；不要猜测附件路径。

### ⚙️ 运行规则

- 固定 Provider 顺序：智谱 → NVIDIA → Gemini → Mistral → Cloudflare。
- 模型失败时先尝试同 Provider 的下一模型；Provider 级失败时切换厂商。
- 默认隐藏 Provider 加载日志。
- 排查配置时设置 `VISION_BRIDGE_VERBOSE=1`，仅显示 `[INFO] provider loaded: <provider>`，不打印模型列表。
- 单图 stdout 不追加 Provider 或模型名称；批次 JSON 不包含 `provider` 或 `model` 字段。
- 图片只在构造出站请求时编码为 Base64 或 Data URL，不写入工作流状态、日志或结果 JSON。

### 🤖 支持的模型

| Provider | 默认模型 | 网络提示 |
|---|---|---|
| 智谱 | `glm-4.1v-thinking-flash`, `glm-4.6v-flash` | 国内通常可直连 |
| NVIDIA | `meta/llama-3.2-11b-vision-instruct`, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | 国内通常可直连 |
| Gemini | `gemini-3.1-flash-lite`, `gemini-3-flash-preview` | 部分网络需要代理 |
| Mistral | `mistral-medium-3.5`, `mistral-medium-latest` | 部分网络需要代理 |
| Cloudflare | `@cf/meta/llama-3.2-11b-vision-instruct` | 部分网络需要代理 |

模型可用性、免费额度和目录会随 Provider 调整，完整限制见 [`references/provider_limits.md`](references/provider_limits.md)。

### 📚 参考资料

- [Skill 工作流](SKILL.md)
- [Provider 与图片限制](references/provider_limits.md)
- [Provider 错误码](references/provider-error-codes.md)
- [故障排查](references/troubleshooting.md)

[返回顶部](#top)

---

<a id="english"></a>

## 🇺🇸 English Guide

### ✨ Overview

`vision-bridge` is an image-understanding Skill for coding agents such as Claude Code, Codex, OpenCode, ZCode, Reasonix, and OpenClaw. It connects to vision models with free tiers: users only need to obtain an API Key from any supported Provider and configure it locally, with no paid model subscription required within that Provider's free quota. When the active model cannot access an image or does not support image input, `vision-bridge` automatically uses the configured vision models for:

- OCR and extraction of code, tables, interface text, and document structure
- Descriptions of people, objects, scenes, layouts, and UI states
- Analysis of screenshots, charts, diagrams, document images, and error messages
- Ordered multi-image comparison, deduplication, partial results, and failure recovery

Use it only when the user explicitly requests `vision-bridge` or the active model cannot read the image. Let the current Agent handle ordinary image requests when native vision is available.

### 🚀 Quick Start

#### 📦 Requirements

- Windows 10/11 or macOS
- Node.js 20.9.0+ and npm
- Outbound HTTPS access to at least one Provider
- At least one Provider API Key

#### 🛠️ Installation

Clone the repository into the Skill directory used by your client or project:

```bash
git clone https://github.com/aihaipeng/vision-bridge.git
cd vision-bridge
npm ci --omit=dev
npm run doctor
```

Update an installed copy:

```bash
git pull
npm ci --omit=dev
npm run doctor
```

#### 🔑 API Key Setup

| Provider | Environment variables | Registration page |
|---|---|---|
| Zhipu | `VISION_BRIDGE_ZHIPU_API_KEY` | [BigModel](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys) |
| Gemini | `VISION_BRIDGE_GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| Mistral | `VISION_BRIDGE_MISTRAL_API_KEY` | [Mistral Console](https://console.mistral.ai/api-keys/) |
| NVIDIA | `VISION_BRIDGE_NVIDIA_API_KEY` | [NVIDIA Build](https://build.nvidia.com) |
| Cloudflare | `VISION_BRIDGE_CLOUDFLARE_API_TOKEN` + `VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID` | [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) |

Windows CMD:

```cmd
setx VISION_BRIDGE_ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx VISION_BRIDGE_GEMINI_API_KEY "YOUR_GEMINI_API_KEY"
setx VISION_BRIDGE_MISTRAL_API_KEY "YOUR_MISTRAL_API_KEY"
setx VISION_BRIDGE_NVIDIA_API_KEY "YOUR_NVIDIA_API_KEY"
setx VISION_BRIDGE_CLOUDFLARE_API_TOKEN "YOUR_CLOUDFLARE_API_TOKEN"
setx VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID "YOUR_CLOUDFLARE_ACCOUNT_ID"
npm run doctor
```

macOS Bash/zsh:

```bash
export VISION_BRIDGE_ZHIPU_API_KEY='YOUR_ZHIPU_API_KEY'
export VISION_BRIDGE_GEMINI_API_KEY='YOUR_GEMINI_API_KEY'
export VISION_BRIDGE_MISTRAL_API_KEY='YOUR_MISTRAL_API_KEY'
export VISION_BRIDGE_NVIDIA_API_KEY='YOUR_NVIDIA_API_KEY'
export VISION_BRIDGE_CLOUDFLARE_API_TOKEN='YOUR_CLOUDFLARE_API_TOKEN'
export VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID='YOUR_CLOUDFLARE_ACCOUNT_ID'
npm run doctor
```

Never send Keys through chat, command arguments, or standard input. The `VISION_BRIDGE_*` namespace prevents tools such as Pi and CC Switch from auto-discovering credentials under vendor-standard names, but it is not an encrypted credential vault. Windows `setx` does not update running processes, but the scripts read persisted user-scoped environment variables.

### 🖼️ Inputs and Image Formats

| Input source | Example | Notes |
|---|---|---|
| Local path | `C:\images\shot.png` | Absolute and relative paths are supported |
| `file://` URL | `file:///C:/images/shot.png` | Converted to a local path before reading |
| Public HTTP(S) URL | `https://example.com/image.jpg` | Private, loopback, and credential-bearing URLs are rejected |
| Session attachment | Claude Code/OpenCode image attachment | Recovered when no real path is available |
| System clipboard | `clipboard` | Explicit input or one-time fallback after attachment recovery |

Supported formats are JPG, JPEG, PNG, WebP, TIFF, AVIF, SVG, the first GIF frame, and BMP. Local files and remote downloads are limited to 32 MB and 100,000,000 decoded pixels. Providers receive only standardized JPEG or PNG.

User-supplied Data URLs, bare Base64, and raw SVG text are rejected. Session adapters may internally decode Data URLs already stored by a supported client; this is not a public input capability.

### 🧠 Usage

#### 🖼️ Single Image

```bash
node scripts/describe_image.js "C:/images/shot.png" "Extract the visible text"
```

The question is optional. The default prompt is `Describe this image in detail.`

#### 🗂️ Image Batch

```json
{
  "prompt": "Compare these images",
  "items": [
    "C:/images/a.jpg",
    { "input": "https://example.com/b.webp", "prompt": "Extract the text" },
    { "source": { "kind": "session_attachment", "client": "opencode", "cwd": "C:/workspace" } }
  ]
}
```

```bash
node scripts/describe_images.js path/to/manifest.json
```

The default batch limit is 3 images. Acquisition and standardization concurrency defaults to 1. Global Provider-task concurrency defaults to 3. Per-Provider concurrency defaults to 1 both in-process and machine-wide. Configure these limits with:

- `VISION_BRIDGE_MAX_BATCH_ITEMS`
- `VISION_BRIDGE_ACQUIRE_CONCURRENCY`
- `VISION_BRIDGE_CONCURRENCY` (1-32)
- `VISION_BRIDGE_PROVIDER_CONCURRENCY`
- `VISION_BRIDGE_BATCH_TIMEOUT_MS` (optional; no whole-batch deadline by default)

The runner deduplicates standardized image content and prompts while preserving input order. One failed item does not block the rest, but it makes the batch exit with code 1.

Retry failed items only:

```bash
node scripts/create_retry_manifest.js original-manifest.json batch-results.json > retry-manifest.json
node scripts/describe_images.js retry-manifest.json
```

#### 📎 Session Attachment Recovery

When the Agent sees only `[Image #n]`, `Unsupported Image`, or a pathless error:

```bash
node scripts/recover_session_images.js --client auto --cwd "C:/current/workspace"
```

Continue with each `images[].path` from the returned JSON. On `SESSION_AMBIGUOUS`, select the current session with `--session <id>`; never guess an attachment path.

### ⚙️ Runtime Rules

- Fixed Provider order: Zhipu -> NVIDIA -> Gemini -> Mistral -> Cloudflare.
- A model failure advances to the next model from the same Provider; a Provider-level failure advances to the next Provider.
- Provider-load logs are hidden by default.
- For configuration diagnostics, set `VISION_BRIDGE_VERBOSE=1`. It prints only `[INFO] provider loaded: <provider>` and omits model lists.
- Single-image stdout does not append Provider or model names. Batch JSON excludes `provider` and `model` fields.
- Images become Base64 or Data URLs only while serializing outbound requests; workflow state, logs, and result JSON never store those encodings.

### 🤖 Supported Models

| Provider | Default models | Network notes |
|---|---|---|
| Zhipu | `glm-4.1v-thinking-flash`, `glm-4.6v-flash` | Usually reachable directly from mainland China |
| NVIDIA | `meta/llama-3.2-11b-vision-instruct`, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | Usually reachable directly from mainland China |
| Gemini | `gemini-3.1-flash-lite`, `gemini-3-flash-preview` | Some networks require a proxy |
| Mistral | `mistral-medium-3.5`, `mistral-medium-latest` | Some networks require a proxy |
| Cloudflare | `@cf/meta/llama-3.2-11b-vision-instruct` | Some networks require a proxy |

Provider catalogs, free tiers, and model availability can change. See [`references/provider_limits.md`](references/provider_limits.md) for complete limits.

### 📚 References

- [Skill workflow](SKILL.md)
- [Provider and image limits](references/provider_limits.md)
- [Provider error codes](references/provider-error-codes.md)
- [Troubleshooting](references/troubleshooting.md)

[Back to top](#top)
