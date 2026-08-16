const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  standardizeImageInput,
  ImageStandardizationError,
} = require('./image_input_resolver');
const { CliError, ProviderError, formatCliError, singleLine } = require('./errors');
const {
  PROVIDER_EXTRA_KEYS,
  PROVIDER_KEYS,
  resolveCredential,
} = require('./key_store');
const {
  cooledModels,
  createHealthStore,
  orderModels,
  orderProviders,
  providerCooldown,
  recordFailure,
  recordProviderFailure,
  recordSuccess,
} = require('./model_health');
const gemini = require('./providers/gemini');
const zhipu = require('./providers/zhipu');
const mistral = require('./providers/mistral');
const nvidia = require('./providers/nvidia');
const cloudflare = require('./providers/cloudflare');

const RETRY_CACHE_PREFIX = 'vision_bridge_retry_';
const RETRY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROMPT = '请详细描述这张图片的内容';
const PROVIDER_ORDER = ['zhipu', 'nvidia', 'gemini', 'mistral', 'cloudflare'];
const PROVIDER_MODULES = { zhipu, gemini, mistral, nvidia, cloudflare };
const PROVIDER_MODEL_ENVS = {
  zhipu: 'ZHIPU_MODELS',
  gemini: 'GEMINI_MODELS',
  mistral: 'MISTRAL_MODELS',
  nvidia: 'NVIDIA_MODELS',
  cloudflare: 'CLOUDFLARE_MODELS',
};
const PROVIDER_REGISTRATION_URLS = {
  zhipu: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  gemini: 'https://aistudio.google.com/apikey',
  mistral: 'https://console.mistral.ai/api-keys/',
  nvidia: 'https://build.nvidia.com',
  cloudflare: 'https://dash.cloudflare.com/profile/api-tokens',
};

function retryHint(retryPath) {
  return retryPath ? ` 图片已缓存至 ${retryPath}；完成本机 Key 配置并通过 doctor 验证后使用该路径重试，不要再次读取 clipboard。` : '';
}

function extensionForMime(mime) {
  return {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
    'image/svg+xml': '.svg',
  }[mime] || '.img';
}

function createRetryCache(image) {
  const filePath = path.join(os.tmpdir(), `${RETRY_CACHE_PREFIX}${Date.now()}_${process.pid}${extensionForMime(image.mime)}`);
  fs.writeFileSync(filePath, image.data);
  return filePath;
}

function cleanupRetryCaches(now = Date.now(), maxAgeMs = RETRY_CACHE_MAX_AGE_MS, prefix = RETRY_CACHE_PREFIX) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const filePath = path.join(os.tmpdir(), entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // Cache cleanup is best-effort and must not block image recognition.
    }
  }
  return removed;
}

function existingRetryCache(input) {
  if (!input || input.length > 1024) return null;
  const resolved = path.resolve(input);
  return path.dirname(resolved) === path.resolve(os.tmpdir())
    && path.basename(resolved).startsWith(RETRY_CACHE_PREFIX)
    && fs.existsSync(resolved) ? resolved : null;
}

function parseModelsValue(value, fallback) {
  const models = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return models.length ? models : fallback;
}

function parseProviderModels(provider) {
  return parseModelsValue(process.env[PROVIDER_MODEL_ENVS[provider]], PROVIDER_MODULES[provider].DEFAULT_MODELS);
}

function providerOrder() {
  return [...PROVIDER_ORDER];
}

function credentialReady(provider, credential) {
  if (!credential || !credential.key) return false;
  const extraEnvName = PROVIDER_EXTRA_KEYS[provider];
  return !extraEnvName || Boolean(credential.extra && credential.extra.value);
}

function parseCliImageInput(value) {
  return {
    resolverInput: value,
    clipboard: value === 'clipboard',
  };
}

function summarizeFailures(failures) {
  return failures.map(({ provider, error, missing }) => {
    if (missing) return `${provider}: 缺少 ${PROVIDER_KEYS[provider]}`;
    return `${provider}: ${singleLine(error.message || error)}`;
  }).join(' | ');
}

function keyGuidance(providers) {
  return [...new Set(providers)].map((provider) => {
    const envName = PROVIDER_KEYS[provider];
    return `${provider}: 配置本机用户环境变量 ${envName}，注册地址 ${PROVIDER_REGISTRATION_URLS[provider]}`;
  }).join(' | ');
}

function keyRequiredError(providers, context = '') {
  const prefix = context ? `${context}；` : '';
  return new CliError('KEY_REQUIRED', `${prefix}未检测到可用 API key。${keyGuidance(providers)}；配置后在 Skill 目录运行 npm run doctor 验证，无需重启 Agent。不要在聊天中发送 Key`, 2);
}

function modelsForProvider(provider) {
  return parseProviderModels(provider);
}

function formatStatusEvent(event, platform = process.platform) {
  if (event.type === 'provider_available') {
    return `[INFO] PROVIDER_AVAILABLE: ${event.provider} 已配置，模型 ${event.models.join(', ')}`;
  }
  if (event.type === 'provider_cooldown') {
    return `[INFO] PROVIDER_COOLDOWN: ${event.provider} 处于 Provider 级冷却（剩 ${Math.ceil(event.remainingMs / 1000)}s，${event.lastError}），排到其他厂商之后`;
  }
  if (event.type === 'model_cooldown') {
    const items = event.entries
      .map(({ model, remainingMs, lastError }) => `${model}（剩 ${Math.ceil(remainingMs / 1000)}s，${lastError}）`)
      .join('、');
    return `[INFO] MODEL_COOLDOWN: ${event.provider} 池内冷却模型排到池尾: ${items}`;
  }
  if (event.type === 'provider_skipped') {
    return `[INFO] PROVIDER_SKIPPED: ${event.provider} 缺少 ${event.envName}，不加入本次轮询`;
  }
  if (event.type === 'provider_switch') {
    const target = event.model ? `${event.provider}/${event.model}` : event.provider;
    return `[WARN] PROVIDER_SWITCH: ${target} 发生 Provider 级故障（${event.code || 'UNEXPECTED'}: ${singleLine(event.message)}），切换到 ${event.next}`;
  }
  if (event.type === 'provider_failed') {
    const target = event.model ? `${event.provider}/${event.model}` : event.provider;
    return `[WARN] PROVIDER_FAILED: ${target} 发生 Provider 级故障（${event.code || 'UNEXPECTED'}: ${singleLine(event.message)}），没有更多可用 Provider`;
  }
  const reason = `${event.code || 'UNKNOWN'}: ${singleLine(event.message)}`;
  if (event.type === 'model_switch') {
    return `[WARN] MODEL_SWITCH: ${event.provider}/${event.model} 失败（${reason}），切换到 ${event.next}`;
  }
  return `[WARN] MODEL_FAILED: ${event.provider}/${event.model} 失败（${reason}），没有更多可用模型`;
}

function formatSuccessfulOutput(result) {
  const text = String(result.text || '')
    .replace(/<\|(?:begin|end)_of_box\|>/g, '')
    .trim();
  return `${text}\n\n[识别模型: ${result.provider}/${result.model}]`;
}

function imageInputCliError(error) {
  const message = error && (error.message || error);
  const exitCode = error instanceof ImageStandardizationError ? error.code : 1;
  return new CliError('IMAGE_INPUT', message || String(error), exitCode, error);
}

async function standardizeCliImageInput(inputMode, standardizeImpl = standardizeImageInput) {
  try {
    return await standardizeImpl(inputMode.resolverInput);
  } catch (error) {
    throw imageInputCliError(error, inputMode);
  }
}

function modelFailures(failures) {
  return failures.flatMap(({ error }) => error instanceof ProviderError ? error.failures : []);
}

function recoveryGuidance(failures) {
  const attempts = modelFailures(failures);
  const actions = [];
  if (failures.some(({ missing }) => missing) || attempts.some(({ auth }) => auth)) {
    actions.push('检查对应 API Key 是否已在本机用户环境变量中正确配置');
  }
  if (attempts.some(({ code }) => code === 'NETWORK')) {
    actions.push('检查出站网络、HTTPS_PROXY/HTTP_PROXY 和 VISION_API_TIMEOUT_MS');
  }
  if (attempts.some(({ status }) => status === 408 || status >= 500)) {
    actions.push('Provider 服务暂不可用，稍后重试或检查官方服务状态');
  }
  if (attempts.some(({ status, code }) => status === 429 || /RATE_LIMIT/.test(code || ''))) {
    actions.push('等待配额恢复，或配置另一 Provider 的有效 Key');
  }
  if (attempts.some(({ status }) => status === 400 || status === 404)) {
    actions.push('检查模型配置及 Provider 当前模型可用性');
  }
  if (!actions.length) actions.push('根据各模型失败原因检查输入、Provider 状态和配置');
  return `Agent 下一步：${[...new Set(actions)].join('；')}`;
}

async function describeWithProviders(options) {
  const {
    image,
    prompt,
    credentials = {},
    adapters = {},
    fetchImpl,
    onStatus,
    healthStore = null,
  } = options;
  const health = healthStore || createHealthStore();
  const resolvedAdapters = { ...PROVIDER_MODULES, ...adapters };
  const failures = [];
  const availableProviders = [];
  for (const provider of providerOrder()) {
    const credential = credentials[provider];
    if (!credentialReady(provider, credential)) {
      const missingEnvName = !credential || !credential.key
        ? PROVIDER_KEYS[provider]
        : PROVIDER_EXTRA_KEYS[provider];
      failures.push({ provider, missing: true });
      if (onStatus) onStatus({ type: 'provider_skipped', provider, envName: missingEnvName });
      continue;
    }
    availableProviders.push(provider);
  }
  if (!availableProviders.length) throw keyRequiredError(providerOrder());

  const now = Date.now();
  const sortedModels = {};
  for (const provider of availableProviders) {
    const baseModels = modelsForProvider(provider);
    sortedModels[provider] = orderModels(baseModels, provider, health.state, now);
    if (onStatus) {
      const cooling = cooledModels(baseModels, provider, health.state, now)
        .map((model) => {
          const entry = health.state[`${provider}/${model}`];
          return { model, remainingMs: entry.cooldownUntil - now, lastError: entry.lastError || '' };
        });
      if (cooling.length) onStatus({ type: 'model_cooldown', provider, entries: cooling });
    }
  }
  const orderedProviders = orderProviders(availableProviders, health.state, now);
  for (const provider of orderedProviders) {
    const cooldown = providerCooldown(health.state, provider, now);
    if (cooldown && onStatus) onStatus({ type: 'provider_cooldown', ...cooldown });
  }
  for (const provider of availableProviders) {
    if (onStatus) onStatus({ type: 'provider_available', provider, models: sortedModels[provider] });
  }

  for (let index = 0; index < orderedProviders.length; index += 1) {
    const provider = orderedProviders[index];
    const credential = credentials[provider];
    const nextProvider = orderedProviders[index + 1];
    const fallbackTarget = nextProvider
      ? (sortedModels[nextProvider].length ? `${nextProvider}/${sortedModels[nextProvider][0]}` : nextProvider)
      : undefined;
    try {
      const result = await resolvedAdapters[provider].describe({
        image,
        prompt,
        key: credential.key,
        models: sortedModels[provider],
        accountId: credential.extra && credential.extra.value,
        fetchImpl,
        onStatus,
        fallbackTarget,
      });
      recordSuccess(health.state, result.provider, result.model, now);
      health.persist();
      return { ...result, credential };
    } catch (error) {
      failures.push({ provider, error });
      const modelFailuresCaught = error instanceof ProviderError ? error.failures : [];
      for (const failure of modelFailuresCaught) {
        recordFailure(health.state, failure.provider || provider, failure.model, {
          scope: failure.scope,
          code: failure.code,
          retryAfterMs: failure.retryAfterMs,
        }, now);
      }
      if (!modelFailuresCaught.length || error.code === 'PROVIDER_UNAVAILABLE') {
        recordProviderFailure(health.state, provider, { code: error.code || 'UNEXPECTED' }, now);
      }
      health.persist();
      if (onStatus && (!(error instanceof ProviderError) || error.failures.length === 0)) {
        onStatus({
          type: fallbackTarget ? 'provider_switch' : 'provider_failed',
          provider,
          code: error.code || 'UNEXPECTED',
          message: error.message || String(error),
          next: fallbackTarget,
        });
      }
    }
  }

  const providerCredentialsFailed = failures.filter(({ error, missing }) => missing
    || (error instanceof ProviderError && error.failures.length > 0 && error.failures.every(({ auth }) => auth)));
  if (providerCredentialsFailed.length === providerOrder().length) {
    const providers = providerCredentialsFailed.map(({ provider }) => provider);
    throw keyRequiredError(providers, `没有视觉模型成功完成请求：${summarizeFailures(failures)}`);
  }
  const attempts = modelFailures(failures);
  const code = attempts.length > 0 && attempts.every(({ code: failureCode }) => failureCode === 'NETWORK')
    ? 'NETWORK_UNAVAILABLE'
    : (attempts.length > 0 && attempts.every(({ status }) => status === 408 || status >= 500)
      ? 'SERVICE_UNAVAILABLE'
    : (attempts.length > 0 && attempts.every(({ status, code: failureCode }) => status === 429 || /RATE_LIMIT/.test(failureCode || ''))
      ? 'RATE_LIMITED'
      : 'PROVIDERS_FAILED'));
  throw new CliError(code, `没有视觉模型成功完成请求：${summarizeFailures(failures)}；${recoveryGuidance(failures)}`, 1);
}

async function main() {
  if (process.argv.length < 3) {
    throw new CliError('USAGE', '用法: node vision-bridge/scripts/describe_image.js <图片输入|clipboard> [问题]');
  }
  cleanupRetryCaches();
  const inputMode = parseCliImageInput(process.argv[2]);
  const imageInput = inputMode.resolverInput;
  const prompt = process.argv[3] || DEFAULT_PROMPT;
  const credentials = {};
  for (const provider of providerOrder()) {
    credentials[provider] = resolveCredential(provider);
  }

  let retryPath = existingRetryCache(imageInput);
  if (!providerOrder().some((provider) => credentialReady(provider, credentials[provider]))) {
    if (inputMode.clipboard) {
      const clipboardImage = await standardizeCliImageInput(inputMode);
      retryPath = createRetryCache(clipboardImage);
    }
    const error = keyRequiredError(providerOrder());
    throw new CliError(error.code, `${error.message}${retryHint(retryPath)}`, error.exitCode, error);
  }

  const standardized = await standardizeCliImageInput(inputMode);

  if (inputMode.clipboard) retryPath = createRetryCache(standardized);

  let result;
  try {
    result = await describeWithProviders({
      image: standardized,
      prompt,
      credentials,
      onStatus: (event) => process.stderr.write(`${formatStatusEvent(event)}\n`),
    });
  } catch (error) {
    const hint = retryHint(retryPath);
    if (error instanceof CliError) throw new CliError(error.code, `${error.message}${hint}`, error.exitCode, error);
    throw new CliError('PROVIDERS_FAILED', `${error.message || error}${hint}`, 1, error);
  }

  process.stdout.write(`${formatSuccessfulOutput(result)}\n`);
  if (retryPath && fs.existsSync(retryPath)) fs.rmSync(retryPath, { force: true });
  return result;
}

function handleFatalError(error) {
  const cliError = error instanceof CliError
    ? error
    : new CliError('UNEXPECTED', error && (error.message || error), 1, error);
  process.stderr.write(`${formatCliError(cliError)}\n`);
  process.exitCode = cliError.exitCode;
}

if (require.main === module) main().catch(handleFatalError);

module.exports = {
  DEFAULT_MODEL: zhipu.DEFAULT_MODEL,
  DEFAULT_PROMPT,
  RETRY_CACHE_MAX_AGE_MS,
  cleanupRetryCaches,
  createRetryCache,
  describeWithProviders,
  formatStatusEvent,
  formatSuccessfulOutput,
  handleFatalError,
  imageInputCliError,
  main,
  parseCliImageInput,
  keyGuidance,
  keyRequiredError,
  providerOrder,
  standardizeCliImageInput,
};
