# Visual Model API Error Code Guide for Five Providers

> Research date: 2026-08-16. Sources: official Provider documentation, NVIDIA developer forums, and real calls made by this project.
> Coverage: Zhipu GLM, Google Gemini, Mistral, NVIDIA NIM, and Cloudflare Workers AI.

## 1. Zhipu (bigmodel.cn)

> Two-layer structure: an outer HTTP status code and the `error.code` business error code in the response body. Source: docs.bigmodel.cn/cn/api/api-code

| Business code | HTTP | Meaning | Recommended action |
|---|---|---|---|
| 1000 | 401 | Authentication failed | Check the API Key |
| 1001 | 401 | Authentication parameter missing from the header | Check the request headers |
| 1003 | 401 | Token expired | Generate a new Key |
| 1005 | 401 | Secondary authentication protection is enabled | Complete secondary authentication in the console |
| 1113 | 429 | Account has an outstanding balance | Add funds |
| 1200 | 500 | API call failed due to an internal error | Retry now or later |
| 1210 | 400 | Invalid call parameters | Check the request body against the documentation |
| 1211 | 400 | Model does not exist | Verify the model ID |
| 1212 | 400 | The model does not support this invocation method | Change the invocation method or model |
| 1213 | 400 | `${field}` parameter was not received correctly | Add the required parameter |
| 1214 | 400 | Invalid `${field}` parameter | **Observed: `modelCode\uff1a\u4e0d\u5b58\u5728`; use model-level fallback** |
| 1215 | 400 | Two parameters cannot be set at the same time | Choose one |
| 1220 | 403 | No permission to access this API | Check account entitlements |
| 1221 | 400 | API has been retired | Stop using this API |
| 1222 | 400 | API does not exist | Verify the path |
| 1230 | 500 | Invocation flow failed | Retry |
| 1234 | 500 | Network error with an error_id | Contact support |
| 1261 | 400 | Prompt is too long | Reduce the input |
| 1301 | 400 | Content safety block due to sensitive content | Revise the prompt |
| 1302 | 429 | **Account-level** rate or concurrency limit | Reduce request rate and concurrency |
| 1305 | 429 | **Platform-level** overload because the model has excessive traffic | **Observed frequently; retry or switch Provider** |
| 1308 | 429 | Usage limit reached; resets at `${next_flush_time}` | Wait for the reset |
| 1309 | 429 | GLM Coding Plan expired | Renew the plan |
| 1310 | 429 | Weekly or monthly usage limit reached | Wait for the reset |
| 1311 | 429 | The plan does not grant access to this model | Switch models or upgrade the plan |
| 1313 | 429 | Rate-limited for violating the fair-use policy | Request removal in the personal center |
| 1314 | 429 | Enterprise plan is no longer active | Contact the enterprise administrator |
| 1315 | 429 | Key is restricted to enterprise coding-plan use | Use a different Key type |

**Key distinction**: 1302 means the account is sending too quickly, 1305 means the platform is overloaded, and 1308/1310 mean the quota is exhausted. Free-tier vision models most often encounter 1302 and 1305.

## 2. Google Gemini

> Source: ai.google.dev/gemini-api/docs/api-errors and /troubleshooting. HTTP code + gRPC status + `error.details` (QuotaFailure/RetryInfo).

| HTTP | gRPC status | Meaning | Recommended action |
|---|---|---|---|
| 400 | INVALID_ARGUMENT | Malformed request body | Check against the API reference |
| 400 | FAILED_PRECONDITION | Free tier is unavailable in the current region | Enable a paid plan |
| 400 | - (API_KEY_INVALID) | Invalid API Key | **The adapter already handles this as AUTH** |
| 403 | PERMISSION_DENIED | Key cannot access this resource, such as a tuned model | Check Key permissions |
| 404 | NOT_FOUND | Model or resource does not exist | **Observed: `models/xxx is not found`; use model-level fallback. The 2.5 family returns this for new Keys** |
| 429 | RESOURCE_EXHAUSTED | RPM, TPM, RPD, or spend limit reached | Use `QuotaFailure.violations.quotaDimensions.model` to distinguish model-level from project-level limits; back off according to `RetryInfo.retryDelay` |
| 500 | INTERNAL | Internal server error, often caused by excessive context | Reduce input, switch models, or retry |
| 503 | UNAVAILABLE | Service overloaded or unavailable | **Observed `high demand` messages use model-level fallback** |
| 504 | DEADLINE_EXCEEDED | Timeout caused by an oversized prompt | Increase the client timeout or reduce input |

New-style string `code` values coexist in the same documentation: `invalid_request`/`parameter_unknown` (400), `permission_denied` (403), `not_found` (404), `rate_limit_exceeded`/`quota_exceeded` (429), `api_error` (500), and `service_unavailable` (503).

## 3. Mistral

> Source: docs.mistral.ai/resources/error-glossary. Unified JSON: `{object:"error", message, type, param, code}`; `type` is one of invalid_request_error / authentication_error / rate_limit_error / server_error.

| HTTP | Typical type | Meaning | Recommended action |
|---|---|---|---|
| 400 | invalid_request_error | Invalid request, including `invalid_model` (code 1500, incorrect or retired model name) and excessive context | **Observed when the Pixtral family was retired; use model-level fallback** |
| 401 | authentication_error | Missing or invalid Key | Check `Authorization: Bearer` |
| 402 | - | Account has no payment method for a paid model | Add a card in the Admin Panel |
| 403 | - | No permission to access the model or endpoint | Check subscription and Key permissions |
| 404 | - | Endpoint does not exist | Verify the URL |
| 422 | invalid_request_error | Parameter validation failed; `param` identifies the field | Correct the field type |
| 429 | rate_limit_error | Rate limit; Free tier is approximately 1 RPS and counted by organization and model | Use exponential backoff; check the tier on the Limits page |
| 500/502/503/504 | server_error | Server-side failure | Retry with backoff |

**Note**: A retired model is reported as 400 + `type:"invalid_model"`, not 404. The regular expression must cover `invalid[_\s]*model`, which this project already implements.

## 4. NVIDIA NIM (integrate.api.nvidia.com)

> No official public error-code table exists. The following entries come from frequent developer-forum reports and direct observation. Response shape: `{"status","title","detail"}`.

| HTTP | Typical response | Meaning | Recommended action |
|---|---|---|---|
| 400 | `{"title":"Bad Request"}` | Invalid request body or parameters, including an oversized or unsupported image | Check the payload |
| 401 | `{"title":"Unauthorized"}` | Missing or invalid Key. **Exception**: `/v1/models` succeeds but chat returns 401 when the account lacks the "Public API Endpoints" entitlement | Regenerate the Key; open a support ticket for entitlement issues |
| 403 | `{"detail":"Authorization failed"}` | Another form of the entitlement issue above | Request access through support |
| 404 | `404 page not found` (plain text) | **Model ID does not exist** because the catalog rotated or renamed it | **Observed with an old Nemotron ID; use model-level fallback** |
| 404 | `{"detail":"Function '<uuid>': Not found for account '<id>'"}` | Account is not authorized for the model, common for personal or newly created organizations | Use an authorized model or open a support ticket |
| 429 | `{"title":"Too Many Requests"}` | Evaluation-tier limit of about 40 RPM; forum reports describe long periods without reset after triggering it | Back off; switch Providers if 429 persists |
| 500 | `{"title":"Internal Server Error"}` and similar | Server error; an empty Bearer token has also been observed to return 500 instead of 401 | Check request headers, then retry |
| 503 | - | Insufficient capacity | Retry with backoff |

**Note**: 404 has two forms: a nonexistent model, which can fall back to the next model, and `Function not found for account`, which is account-level and should trip the Provider circuit. The project currently handles both as model-level; the first behavior has been verified directly.

## 5. Cloudflare Workers AI

> Two-layer structure: general v4 API errors in the 7000/9109/10000 ranges, plus the Workers AI internal layer in `errors[].code`, documented at developers.cloudflare.com/workers-ai/platform/errors.

### 5.1 Workers AI internal error codes

| Internal code | HTTP | Name | Meaning | Recommended action |
|---|---|---|---|---|
| 3003 | 400 | Incomplete request | Missing headers or body | Complete the request |
| 3006 | 413 | Request too large | Request body is too large | Compress the image |
| 3007 | 408 | Timeout | Request timed out | Retry |
| 3008 | 408 | Aborted | Request was aborted | Retry |
| 3023 | 403 | Account blocked | Account is blocked | Contact support |
| 3030 | 400 | Model input invalid | Invalid model input, such as missing required fields | **Observed when the OpenAI-compatible endpoint drops the image** |
| 3036 | 429 | Account limited | **Daily free quota of 10,000 neurons exhausted** | Wait for the next-day reset or upgrade |
| 3040 | 429 | Out of capacity | No data center has available capacity | Retry with backoff or switch Providers |
| 3041 | 403 | Account not allowed | No permission to access a private model | Use a public model |
| 3042 | 404 | Invalid model ID | Invalid model name | Verify the model ID |
| 5016 | 403 | Model agreement | Model terms have not been accepted | **Observed: first send `{"prompt":"agree"}`. The initial acceptance response is also 403+5016 with a thank-you message and is not a failure** |
| 5018 | 403 | Account not allowed | Same as 3041 | - |
| 5019 | 405 | Deprecated SDK | SDK version is too old | Upgrade |
| 5035 | 403 | Requires Workers Paid | Model requires a paid plan | Upgrade or switch models |
| 5004 | 400 | Invalid data | Invalid base64 input type | Check the encoding |
| 5005 | 405 | LoRa unsupported | Model does not support LoRa | - |
| 5007 | 400 | No such model | Model or task does not exist | Verify the model name |

### 5.2 General v4 API error codes (observed + documented)

| Code | HTTP | Meaning | Recommended action |
|---|---|---|---|
| 10000 | - | Authentication error caused by an invalid token | Recreate the token |
| 10001 | - | Unable to authenticate due to an authentication-header or format issue | Check the Bearer header |
| 7000 | 400 | No route for that URI | **Observed when the whole model name is encoded (`/` -> `%2F`); fixed by encoding path segments separately** |
| 7001 | 400 | Method not supported, such as GET on a run endpoint | Use POST |
| 9109 | 403 | Route exists, but access to the resource is denied, such as missing Account Settings:Read | Add token permission or ignore |

## 6. Failure Decisions and Actions (Error Semantics -> Classification -> Action)

> Core principle: **failure scope determines the next step**. A model-level failure advances to the next model from the same Provider; a Provider-level failure trips that Provider and advances to the next Provider; exhaustion is aggregated into a terminal state according to the dominant error. This follows `providerFailureScope` in `scripts/errors.js` and comprehensive live-call verification from 2026-08-16.

| Error semantics | Classification signals by Provider | Scope | Action |
|---|---|---|---|
| **Authentication failure** | 401/403: Zhipu 1000 range, Gemini API_KEY_INVALID, Mistral 401, NVIDIA 401/403, CF 10000/10001 | provider | Trip circuit -> next Provider. If every Provider is AUTH or has no Key, return **KEY_REQUIRED** with exit code 2 |
| **Model does not exist** | Zhipu 1214, Gemini 404 NOT_FOUND, Mistral 400 invalid_model, NVIDIA 404 plain text, CF 5007/3042 | model | Advance to the next model from the same Provider (`MODEL_SWITCH`); when the pool is exhausted, advance to the next Provider |
| **Rate limit / quota exhausted** | 429: Zhipu 1302/1305/1308, Gemini RESOURCE_EXHAUSTED, Mistral 429, NVIDIA 429, CF 3036 neurons/3040 capacity | provider, except Gemini case 1 below | Trip circuit -> next Provider; do not wait and retry in place |
| **Platform failure / overload** | 500/503/504: Zhipu 1200/1230, Gemini INTERNAL/UNAVAILABLE, Mistral 5xx, NVIDIA 500, CF 5xx | provider, except Gemini 503 high-demand case 1 below | Trip circuit -> next Provider |
| **Network unreachable** | Request-layer failures: TLS disconnect, ECONNRESET, timeout; direct Mistral access from mainland China is a common example | provider | Trip circuit -> next Provider; if every failure is NETWORK, return **NETWORK_UNAVAILABLE** |
| **Invalid request / input** | 400/413/422: malformed payload, image limit exceeded, parameter validation, content safety block such as Zhipu 1301, CF 3030 | provider | Trip circuit -> next Provider. The unified gateway should normally prevent this; occurrence suggests Provider-side incompatibility |
| **Invalid response** | HTTP 200 with empty or non-JSON content | model | Advance to the next model from the same Provider |
| **Missing configuration** | CF lacks CLOUDFLARE_ACCOUNT_ID | provider | Skip before entering the pool with `PROVIDER_SKIPPED`; this is not counted as a failure |

### Terminal aggregation after all Providers are exhausted

| Dominant error | Terminal code | Exit code |
|---|---|---|
| All Keys missing or all AUTH | KEY_REQUIRED | 2 |
| All NETWORK | NETWORK_UNAVAILABLE | 1 |
| All 408/5xx | SERVICE_UNAVAILABLE | 1 |
| All 429/RATE_LIMIT | RATE_LIMITED | 1 |
| Mixed | PROVIDERS_FAILED | 1 |

### Three Provider-specific exceptions

1. **Gemini 429 classification**: if `QuotaFailure.violations` contains `quotaDimensions.model`, it is model-level and advances to the next model. Otherwise it is project-level and trips the Provider. A 503 message containing `high demand` is model-level.
2. **First Cloudflare agreement acceptance**: an agreement request returning 403 + "Thank you for agreeing" with internal code 5016 is a **success signal**, not an authentication failure, and must not trip the Provider. Only 401/403 without the thank-you text trips it.
3. **NVIDIA account-level 404** (`Function not found for account`): this means the account lacks permission and should trip the Provider. It is currently handled as model-level, so one additional model is attempted before the Provider naturally trips; this cost is acceptable.

### Downstream effect of failures (health cooldown)

Failures do more than trigger a switch. They are written to cross-process health state in `%TEMP%\vision_bridge_health.json`, which affects later calls:

- **Cooldown steps of 1 -> 2 -> 4 -> 8 -> 16 minutes**, capped at 16 minutes. Consecutive failures of the same model advance through the steps. A longer server-provided `retryAfterMs` takes precedence but is still capped.
- **AUTH exception**: authentication failures do not enter cooldown because switching Providers is already the optimal action.
- **Deprioritize, do not remove**: cooling models move to the end of their pool and cooling Providers move to the end of the queue. They remain available as a fallback if every target is cooling.
- **Success resets state**: a successful call clears the failure count and records `lastSuccess`; after cooldown ends, the model returns to its original speed order.
- Delete the state file to reset health state.

### Observability and operating rules

- stderr events: `MODEL_SWITCH`/`MODEL_FAILED` for model-level state, `PROVIDER_SWITCH`/`PROVIDER_FAILED` for Provider-level state, and `MODEL_COOLDOWN`/`PROVIDER_COOLDOWN` for cooldown deprioritization. All are intermediate states; the Agent must wait for process exit before concluding.
- **Request each model only once; switch immediately on failure, with no in-place retry**. This reveals actual availability faster, while waiting and backoff remain the responsibility of the parent Agent.

## Reference Links

- Zhipu error codes: <https://docs.bigmodel.cn/cn/api/api-code>
- Zhipu rate limits: <https://docs.bigmodel.cn/cn/api/rate-limit>
- Gemini API errors: <https://ai.google.dev/gemini-api/docs/api-errors>
- Gemini troubleshooting: <https://ai.google.dev/gemini-api/docs/troubleshooting>
- Mistral error glossary: <https://docs.mistral.ai/resources/error-glossary>
- Cloudflare Workers AI errors: <https://developers.cloudflare.com/workers-ai/platform/errors/>
- NVIDIA NIM (no official error-code table; based on forum reports and direct observation): <https://forums.developer.nvidia.com/c/ai-ml/nim/>
