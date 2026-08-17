# Troubleshooting and Recovery

Read this file only after entering the vision-bridge SOP and encountering dependency, Key, proxy, exit-code, or Provider-call failures. Native Agent handling does not require doctor, SOP Provider Keys, or this file.

## Confirm the Execution Path First

- If the current model supports image input and the user did not explicitly request `vision-bridge`, use native Agent vision and label the result `[Recognition method: native Agent vision]`.
- If the user explicitly requests `vision-bridge`, or the current model does not support image input, enter the vision-bridge SOP.
- The system clipboard is only the final input fallback; it does not determine whether to enter the SOP. After the Agent obtains the image, choose the execution path using the two rules above.
- If native vision is unavailable but a real path, file URL, or public HTTP(S) URL is available, pass that input directly to the SOP without reading the clipboard. User-provided Data URLs and raw Base64 are not public inputs.

## Claude Code / OpenCode Session Attachment Recovery

The following messages indicate that the current turn contains an image but the current model did not receive its pixels:

- Claude Code: `[Image #n]`, `[Unsupported Image]`, or `Cannot read "..." (this model does not support image input)`.
- OpenCode: `Image input unsupported error`, `Image input error: model cannot read image.png`, or `Image input not supported by model`.

If the error includes a real absolute path, pass it directly to the SOP. Only when the error contains a display name, placeholder, or no path, run the following from the Skill directory:

```powershell
node scripts/recover_session_images.js --client auto --cwd 'C:\current\session\working-directory'
```

```bash
node scripts/recover_session_images.js --client auto --cwd 'C:/current/session/working-directory'
```

The recovery tool reads only user image parts within the allowed time window whose working directory matches, then writes images validated by the unified gateway to the system temporary directory. It does not output conversation text or Base64. Use `images[].path` from the returned JSON as SOP input. If it returns `SESSION_AMBIGUOUS`, retry with `--session <id>` using the current session ID listed in the error.

If the session has no recoverable image, run `node scripts/describe_image.js clipboard 'Describe the image contents'` once. Do not hand-write `powershell -Command ... Clipboard`; Claude Code's Bash expands PowerShell variables such as `$img` first, causing expression, garbled-text, or empty-variable errors. Ask the user to paste or upload the image again, or provide a real path, only after both session recovery and the built-in clipboard input fail.

## Command-Line Notes

First identify whether the command runner is CMD, PowerShell, Bash, zsh, or Git Bash/MSYS; do not mix their syntax. Use `scripts/describe_image.js` in every terminal. In Bash or zsh, write Windows local paths as `C:/...` and use single quotes so backslashes are not interpreted as escape characters.

If the tool supports `cwd` or `workdir`, set it directly to the Skill directory. When the command itself must change directories, use the appropriate form:

```cmd
cd /d "C:\path\to\vision-bridge"
```

```powershell
Set-Location -LiteralPath 'C:\path\to\vision-bridge'
```

```bash
cd 'C:/path/to/vision-bridge'
```

## Dependency Checks

The first time the session enters the SOP, or after an SOP runtime error, run the following from the Skill directory:

```cmd
npm run doctor
```

Doctor checks the Node.js version, `sharp`, `bmp-ts`, `https-proxy-agent`, actual AVIF encode/decode capability, and Key configuration for every Provider. It reports only whether each Key exists and never prints Key contents. Install locked dependencies only when doctor returns `DEPENDENCY`:

```cmd
npm ci --omit=dev
```

Do not repeat installation before every image request.

## API Keys

Supported variables:

- `VISION_BRIDGE_ZHIPU_API_KEY`
- `VISION_BRIDGE_GEMINI_API_KEY`
- `VISION_BRIDGE_MISTRAL_API_KEY`
- `VISION_BRIDGE_NVIDIA_API_KEY`
- `VISION_BRIDGE_CLOUDFLARE_API_TOKEN` + `VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID` (Cloudflare is enabled only when both are configured)

Registration pages:

- Zhipu: [https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys](https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys)
- Gemini: [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Mistral: [https://console.mistral.ai/api-keys/](https://console.mistral.ai/api-keys/)
- NVIDIA: [https://build.nvidia.com](https://build.nvidia.com)
- Cloudflare: [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) (the token requires Workers AI: Edit; the Account ID appears on the right side of the dashboard home page)

Never ask users to send Keys in chat, and never pass a Key supplied by a user through standard input or command arguments. Windows users should set user-scoped environment variables in their own terminal:

```cmd
setx VISION_BRIDGE_ZHIPU_API_KEY "YOUR_ZHIPU_API_KEY"
setx VISION_BRIDGE_GEMINI_API_KEY "YOUR_GEMINI_API_KEY"
setx VISION_BRIDGE_MISTRAL_API_KEY "YOUR_MISTRAL_API_KEY"
setx VISION_BRIDGE_NVIDIA_API_KEY "YOUR_NVIDIA_API_KEY"
setx VISION_BRIDGE_CLOUDFLARE_API_TOKEN "YOUR_CLOUDFLARE_API_TOKEN"
setx VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID "YOUR_CLOUDFLARE_ACCOUNT_ID"
```

`setx` does not modify already-running processes. The scripts directly read persisted user-scoped values, so they can be invoked again in the current session.
macOS users should configure process environment variables in the same shell environment that launches the Agent:

```bash
export VISION_BRIDGE_ZHIPU_API_KEY='YOUR_ZHIPU_API_KEY'
export VISION_BRIDGE_GEMINI_API_KEY='YOUR_GEMINI_API_KEY'
export VISION_BRIDGE_MISTRAL_API_KEY='YOUR_MISTRAL_API_KEY'
export VISION_BRIDGE_NVIDIA_API_KEY='YOUR_NVIDIA_API_KEY'
export VISION_BRIDGE_CLOUDFLARE_API_TOKEN='YOUR_CLOUDFLARE_API_TOKEN'
export VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID='YOUR_CLOUDFLARE_ACCOUNT_ID'
npm run doctor
```

After setting or updating a value on Windows, run `npm run doctor` directly. The script reads user environment variables, so the Agent does not need to restart. On macOS, the Agent process must inherit the variables above. Retry image recognition after doctor reports at least one namespaced Key as configured. The scripts ignore vendor-standard credential variables so unrelated tools cannot auto-discover vision-bridge credentials. They do not accept Keys through standard input or command arguments and do not persist them automatically.

## CLI Clipboard Compatibility

The system clipboard is the final fallback after session attachment recovery fails. On Windows, the built-in CLI `clipboard` input calls PowerShell with an argument array and does not depend on Bash string composition. On macOS, it uses the built-in `osascript`/AppKit facilities and does not require `pngpaste` or other Homebrew tools. `clipboard-fallback` remains only as a CLI compatibility argument.

When a Key is missing or a Provider fails, the CLI may return a temporary `vision_bridge_retry_*` path. After configuring a local Key and passing doctor, retry using that path.

A retryable session-attachment failure in a batch returns `retryPath` and `retryExpiresAt` on the corresponding result item. Before expiration, `retryPath` can be used directly as local image input. Successful and non-retryable failures do not retain temporary images.

To retry only failed items, run `node scripts/create_retry_manifest.js <original-manifest.json> <batch-results.json>`, save stdout as a new manifest, and explicitly invoke the batch script with it. The generator does not call a Provider, and successful items are excluded from the new manifest. If `retryPath` is expired or missing, it returns `RETRY_EXPIRED`.

### macOS Hardware Acceptance Test

Copy a screenshot, then run the following from the Skill directory:

```bash
node scripts/describe_image.js clipboard 'Describe the image contents'
```

Next, copy an image file in Finder and repeat the command. Both calls should reach a vision model, and no `vision_clip_*.png` file should remain in the temporary directory. If stderr reports that `osascript` cannot be invoked, confirm that the command exists and that the current terminal or Agent has permission to read the system clipboard.

## Progress Events

The following stderr events help the parent Agent determine progress; they are not image content:

- `[INFO] provider loaded: <provider>`: shown only when `VISION_BRIDGE_VERBOSE=1`; indicates that a Key is configured and the Provider has entered the fixed queue for this call. The model list is not printed.
- `PROVIDER_SKIPPED`: no Key is configured, so the Provider is not called.
- `MODEL_COOLDOWN`: some models in the Provider pool are cooling down after failures and move to the end of the pool. This is not a failure; they remain fallback targets.
- `PROVIDER_COOLDOWN`: the Provider is cooling down after failures and moves behind other Providers. This is not a failure; it remains a fallback target.
- `PROVIDER_SWITCH`: the current Provider had a Provider-level failure. The message includes the reason and next Provider.
- `PROVIDER_FAILED`: the current Provider had a Provider-level failure and no more Providers are available.
- `provider_batch_skipped`: the Provider already had a Provider-level failure in this batch; waiting images skip duplicate requests and continue with the next Provider.
- `MODEL_SWITCH`: the current model failed. The message includes the error code, reason, and next model or Provider.
- `MODEL_FAILED`: the current model failed and no more targets are available.

Do not report failure as soon as `MODEL_SWITCH` appears; wait for the process to exit. On success, use the recognized stdout content directly without appending a Provider or model name. Batch JSON likewise excludes `provider` and `model` fields.

## Error Handling

| Exit code | Action |
|---|---|
| `0` | Continue the user response using stdout |
| `1` | Correct the input, dependency, network, or Provider issue according to the stderr error code |
| `2` | Show registration pages and setup commands, and guide the user to configure a valid Key locally |

stderr uses a fixed format:

```text
[ERROR] <CODE>: <message>
```

Common errors:

- `IMAGE_INPUT`: confirm the path actually exists and do not guess filenames. Remote URLs must be publicly reachable. In Bash, write Windows paths as `C:/...`. Bing `/th/id/` thumbnail links automatically switch to the stable `global.bing.com` image host.
- `BATCH_MANIFEST`: confirm that the JSON is a non-empty array or an object containing a non-empty `items` array. Session attachment `client` accepts only `claude` or `opencode`.
- `BATCH_SIZE_LIMIT`: the batch exceeds `VISION_BRIDGE_MAX_BATCH_ITEMS`, which defaults to 3. Split the manifest or explicitly change the local environment variable. An oversized batch has not yet been preflighted or read.
- `BATCH_CANCELLED`: the caller cancelled the batch or `VISION_BRIDGE_BATCH_TIMEOUT_MS` fired. Queued tasks stopped, and in-flight downloads or Provider HTTP requests were aborted. Decide whether to rerun based on the user's intent.
- `RETRY_EXPIRED`: a temporary retry file referenced by the batch result has expired or does not exist. Rebuild the manifest from an original source that is still readable; do not guess a temporary path.
- `CONFIGURATION`: check that batch size, acquisition concurrency, and batch-deadline environment variables contain permitted positive integers.
- `AVIF_UNAVAILABLE`: the current sharp/libvips build does not satisfy mandatory AVIF support. Run `npm ci --omit=dev` again. If it still fails, stop Provider calls and inspect platform dependencies.
- `CONFIG`: check model lists and timeout configuration.
- `KEY_REQUIRED`: guide the user to configure or update at least one Provider Key locally and run doctor. Do not ask for the Key.
- `NETWORK_UNAVAILABLE`: check outbound connectivity, proxy settings, and `VISION_API_TIMEOUT_MS`, then retry.
- `SERVICE_UNAVAILABLE`: the Provider service is temporarily unavailable. Retry later or check the official service status.
- `RATE_LIMITED`: wait for quota recovery or configure a valid Key for another Provider.
- `PROVIDERS_FAILED`: inspect the reason for every model in the error and check model availability, input, and Provider status. Read `references/provider_limits.md` when needed.
- `UNEXPECTED`: run `npm run check` first, and do not expose a Node.js stack trace to the user.

## Proxy

Provider requests support `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`. When a proxy connection fails, verify the proxy URL, port, and `NO_PROXY` host-matching rules. Never print a proxy URL containing credentials in logs.
