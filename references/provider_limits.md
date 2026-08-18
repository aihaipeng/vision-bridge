# Provider and image limits

Read this file only after entering the vision-bridge workflow and when changing Providers, model lists, image conversion, routing rules, or diagnosing rejected requests. Native agent vision does not use this input gateway, compression policy, or Provider loop.

## Component boundaries

- `scripts/image_input_resolver.js`: acquires bytes from local paths, file URLs, public HTTP(S) URLs, and the clipboard; always passes them through the unified standardization gateway; rejects user Data URLs and bare Base64.
- `scripts/workflow/input_pipeline.js`: converts a source into an in-process `ImageAsset` and hashes canonical bytes.
- `scripts/workflow/image_identity.js`: creates stable identities from canonical content plus the prompt and deduplicates jobs.
- `scripts/workflow/batch_runner.js`: executes unique jobs with global concurrency 3 by default, isolates failures, and restores order.
- `scripts/workflow/provider_scheduler.js`: limits each Provider to one concurrent request by default and skips same-batch waiters after a Provider-level failure.
- `scripts/image_codec.js`: creates raw Base64 or Data URLs only during outbound Provider serialization.
- `scripts/recover_session_images.js`: recovers image parts from the current Claude Code/OpenCode session, then uses the unified gateway; it does not read Provider data or conversation text.
- `scripts/image_preparer.js`: standardizes decodable input to JPEG/PNG, then resizes and compresses it for a Provider profile.
- `scripts/providers/*.js`: build vendor requests and perform model fallback. They do not acquire public inputs.
- `scripts/describe_image.js`: backward-compatible single-image CLI.
- `scripts/describe_images.js`: batch manifest, one-time preflight, session expansion, standardization, deduplication, scheduling, aggregation, and transactional cleanup entry point.

Providers must not parse paths, read the clipboard, or perform first-stage format validation.

## Input gateway limits

- File extensions, URL suffixes, and Content-Type are not trusted as the real format.
- Public formats: JPG/JPEG, PNG, WebP, TIFF, AVIF, SVG, first GIF frame, and BMP. Doctor enforces AVIF with a real encode/decode probe. HEIC/HEIF are outside the supported scope.
- JPEG/PNG use decoded metadata and pixel-limit checks and apply EXIF orientation. SVG and BMP become PNG. WebP, TIFF, GIF, and other accepted formats become PNG when transparent and JPEG otherwise.
- Transparency is preserved in PNG; transparent foregrounds are not flattened onto white.
- Successful gateway output is always `image/jpeg` or `image/png`. HTML, corrupt bytes, and unsupported decoders return `IMAGE_INPUT` before Provider calls.
- Local reads and remote downloads are limited to 32 MB.
- Remote URLs may follow at most 5 redirects, with public-address validation on each hop.
- Private, loopback, link-local, credential-bearing URLs and UNC shares are rejected.
- Decoded images are limited to 100 MP. BMP headers are checked before allocating a decode buffer.

## Health and cooldown ranking

The router maintains cross-process model health in `%TEMP%\vision_bridge_health.json`; override the location with `VISION_HEALTH_FILE`.

- **Semantic cooldown:** failures are recorded by code. Cooldown grows 1 -> 2 -> 4 -> 8 -> 16 minutes and is capped at 16 minutes. Authentication failures are not recorded because switching Providers is sufficient. A longer server `retryAfterMs` wins, subject to the same cap.
- **Rank, do not remove:** cooling models move to the end of their pool and cooling Providers move behind healthy Providers, but remain fallback candidates.
- **Speed remains primary:** healthy models retain their configured fast-to-slow order. Success clears the failure count and records `lastSuccess` for diagnostics; it does not permanently reorder models.
- `MODEL_COOLDOWN` and `PROVIDER_COOLDOWN` make cooldown state observable on stderr.
- Concurrent processes merge health files by rereading disk, choosing the newest `updatedAt` for each key, and atomically replacing the file. A millisecond race may lose one advisory health update but never affects recognition correctness. Group failures caused by a concurrent burst count as one Provider failure, preventing self-induced escalation to a long cooldown.
- Health state expires after 7 days without updates. Delete the file to reset it.

## Fixed order and circuit breaking

The script checks all namespaced credentials first. Cloudflare also requires `VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID`. Only configured Providers enter the queue. Vendor-standard credential names are deliberately ignored to prevent unrelated tools from auto-discovering vision-bridge credentials. The Provider order favors direct regional access; each pool uses measured fast-to-slow order. User prompts cannot change this order.

1. `glm-4.1v-thinking-flash` (measured average 2.34s)
2. `glm-4.6v-flash` (9.88s; free-tier concurrency slows peak periods)
3. `meta/llama-3.2-11b-vision-instruct` (6.71s; 1.81s measured off-peak)
4. `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` (20.08s; 3.07s off-peak)
5. `gemini-3.1-flash-lite` (1.83s)
6. `gemini-3-flash-preview` (5.23s)
7. `mistral-medium-3.5` (3.48s; requires `HTTPS_PROXY` in restricted networks)
8. `mistral-medium-latest` (4.11s; requires `HTTPS_PROXY` in restricted networks)
9. `@cf/meta/llama-3.2-11b-vision-instruct` (17.58s)

All nine models were verified with real API calls on 2026-08-16; timings are that day's benchmark averages. Corrections from testing: Mistral retired `pixtral-large-2411` and `pixtral-12b`; vision is provided by the `mistral-medium` family. Gemini 2.5 models returned 404 for new API keys and are excluded. NVIDIA renamed the old Nemotron ID with the `-v1` suffix.

Each model is called once with no in-place retry or wait. Failure scope determines the next action:

- Model scope: model-not-found, model-specific quota, empty response, or response parsing error. Try the next model from the same Provider.
- Provider scope: authentication, network, timeout, Provider-level quota, or HTTP 400/408/429/5xx. Stop using that Provider and switch immediately.
- Gemini `QuotaFailure` is model-scoped when `quotaDimensions.model` or a model-specific `quotaId` is present; other 429 responses are Provider-scoped.
- stderr emits `MODEL_SWITCH`, `MODEL_FAILED`, `PROVIDER_SWITCH`, or `PROVIDER_FAILED`. Switch events identify the next target.

Model names mentioned in a user's question are task text, not routing instructions.

## Provider image profiles

| Provider | Accepted outbound MIME | Maximum payload target | Maximum dimension | Encoding |
|---|---|---:|---:|---|
| Zhipu | JPEG, PNG | 5 MB | 6000 px | Raw Base64 in `image_url.url` |
| NVIDIA | JPEG, PNG | 5 MB | 4096 px | Data URL |
| Gemini | JPEG, PNG | 14 MB raw image budget | 8192 px profile | Raw Base64 plus separate MIME |
| Mistral | JPEG, PNG | 5 MB | 4096 px | Data URL |
| Cloudflare | JPEG, PNG | 3.5 MB | 4096 px | Data URL |

Images are recompressed and, when needed, resized until the active profile accepts them. Input paths and source URLs never leave the gateway.

Cloudflare sends an idempotent `{"prompt":"agree"}` request to the run endpoint before first model use. Its OpenAI-compatible `/ai/v1/chat/completions` endpoint discards image content and returns AiError 3030, so image requests use `/ai/run/{model}` with each model-path segment encoded separately.

## Configuration

| Environment variable | Meaning |
|---|---|
| `GEMINI_MODELS` | Comma-separated Gemini fallback order |
| `ZHIPU_MODELS` | Comma-separated Zhipu fallback order |
| `MISTRAL_MODELS` | Comma-separated Mistral fallback order |
| `NVIDIA_MODELS` | Comma-separated NVIDIA fallback order |
| `CLOUDFLARE_MODELS` | Comma-separated Cloudflare fallback order |
| `VISION_BRIDGE_ZHIPU_API_KEY` | Zhipu credential used only by vision-bridge |
| `VISION_BRIDGE_GEMINI_API_KEY` | Gemini credential used only by vision-bridge |
| `VISION_BRIDGE_MISTRAL_API_KEY` | Mistral credential used only by vision-bridge |
| `VISION_BRIDGE_NVIDIA_API_KEY` | NVIDIA credential used only by vision-bridge |
| `VISION_BRIDGE_CLOUDFLARE_API_TOKEN` | Cloudflare token used only by vision-bridge |
| `VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID` | Required with `VISION_BRIDGE_CLOUDFLARE_API_TOKEN` |
| `VISION_API_TIMEOUT_MS` | Per-Provider request timeout; default 30000 ms |
| `VISION_BRIDGE_MAX_BATCH_ITEMS` | Maximum batch size; default 3; checked before preflight and reads |
| `VISION_BRIDGE_ACQUIRE_CONCURRENCY` | Acquisition and standardization concurrency; default 1; range 1-32 |
| `VISION_BRIDGE_CONCURRENCY` | Global batch Provider-task concurrency; default 3; range 1-32 |
| `VISION_BRIDGE_PROVIDER_CONCURRENCY` | In-process per-Provider concurrency; default 1; range 1-32 |
| `VISION_BRIDGE_BATCH_TIMEOUT_MS` | Optional positive whole-batch deadline in milliseconds; unset by default |
| `VISION_BRIDGE_VERBOSE` | Set to `1` to emit `[INFO] provider loaded: <provider>`; hidden by default and never prints model lists |

Provider requests and remote image downloads honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`. Machine-wide per-Provider concurrency defaults to 1 and uses atomic leases in the system temp directory. Lease data contains only PID and timestamps, is renewed by heartbeat, and supports stale recovery.

## Official references

- Gemini: <https://ai.google.dev/gemini-api/docs/image-understanding>
- Zhipu: <https://docs.bigmodel.cn/cn/guide/models/vlm>
- Mistral: <https://docs.mistral.ai/capabilities/vision/>
- NVIDIA: <https://docs.api.nvidia.com/>
- Cloudflare Workers AI: <https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/>
