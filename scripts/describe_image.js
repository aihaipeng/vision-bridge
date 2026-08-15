const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  clipboardSystemName,
  standardizeImageInput,
  ImageStandardizationError,
} = require('./image_input_resolver');
const { prepareImage } = require('./image_preparer');
const { CliError, ProviderError, formatCliError, singleLine } = require('./errors');
const {
  PROVIDER_KEYS,
  resolveCredential,
} = require('./key_store');
const gemini = require('./providers/gemini');
const zhipu = require('./providers/zhipu');

const RETRY_CACHE_PREFIX = 'img2txt_retry_';
const CLIPBOARD_FALLBACK_CACHE_PREFIX = `${RETRY_CACHE_PREFIX}clipboard_fallback_`;
const RETRY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROMPT = '请详细描述这张图片的内容';
const CLIPBOARD_FALLBACK_INPUT = 'clipboard-fallback';
const PROVIDER_ORDER = ['zhipu', 'gemini'];
const PROVIDER_REGISTRATION_URLS = {
  zhipu: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  gemini: 'https://aistudio.google.com/apikey',
};

function retryHint(retryPath) {
  return retryPath ? ` 图片已缓存至 ${retryPath}；完成本机 Key 配置并通过 doctor 验证后使用该路径重试，不要再次读取 clipboard。` : '';
}

function imageToBase64(image) {
  return image.data.toString('base64');
}

async function prepareForZhipu(image, options = {}) {
  const profile = {
    ...zhipu.IMAGE_PROFILE,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxDimension ? { maxDimension: options.maxDimension } : {}),
    ...(options.profiles ? { compressionProfiles: options.profiles } : {}),
  };
  return prepareImage(image, profile);
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

function createRetryCache(image, options = {}) {
  const prefix = options.clipboardFallback ? CLIPBOARD_FALLBACK_CACHE_PREFIX : RETRY_CACHE_PREFIX;
  const filePath = path.join(os.tmpdir(), `${prefix}${Date.now()}_${process.pid}${extensionForMime(image.mime)}`);
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

function parseGeminiModels(value) {
  const models = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return models.length ? models : gemini.DEFAULT_MODELS;
}

function parseZhipuModels() {
  const explicitList = String(process.env.ZHIPU_MODELS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (explicitList.length) return explicitList;
  const legacyModel = (process.env.ZHIPU_MODEL || process.env.VISION_MODEL || '').trim();
  return legacyModel ? [legacyModel] : zhipu.DEFAULT_MODELS;
}

function providerOrder() {
  return [...PROVIDER_ORDER];
}

function parseCliImageInput(value) {
  const clipboardFallbackRead = value === CLIPBOARD_FALLBACK_INPUT;
  const resolverInput = clipboardFallbackRead ? 'clipboard' : value;
  return {
    resolverInput,
    clipboardFallback: clipboardFallbackRead,
    clipboardFallbackRead,
    clipboard: resolverInput === 'clipboard',
  };
}

function isClipboardFallbackRetryCache(filePath) {
  return Boolean(filePath)
    && path.basename(filePath).startsWith(CLIPBOARD_FALLBACK_CACHE_PREFIX);
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

function modelsFor(provider, geminiModels, zhipuModels) {
  return provider === 'gemini' ? geminiModels : zhipuModels;
}

function firstTarget(provider, geminiModels, zhipuModels) {
  const models = modelsFor(provider, geminiModels, zhipuModels);
  return models.length ? `${provider}/${models[0]}` : provider;
}

function formatStatusEvent(event, platform = process.platform) {
  if (event.type === 'clipboard_fallback') {
    return `[WARN] CLIPBOARD_FALLBACK: 当前回合图片无法直接读取（模型不支持图片输入或附件路径缺失），正在读取当前 ${clipboardSystemName(platform)} 剪贴板`;
  }
  if (event.type === 'provider_available') {
    return `[INFO] PROVIDER_AVAILABLE: ${event.provider} 已配置，模型 ${event.models.join(', ')}`;
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

function formatSuccessfulOutput(result, options = {}, platform = process.platform) {
  const text = String(result.text || '')
    .replace(/<\|(?:begin|end)_of_box\|>/g, '')
    .trim();
  const source = options.clipboardFallback
    ? `\n\n[图片来源: ${clipboardSystemName(platform)} 剪贴板（图片直读失败回退）]`
    : '';
  return `${text}${source}\n\n[识别模型: ${result.provider}/${result.model}]`;
}

function imageInputCliError(error, inputMode, platform = process.platform) {
  const message = error && (error.message || error);
  const exitCode = error instanceof ImageStandardizationError ? error.code : 1;
  if (!inputMode.clipboardFallbackRead) {
    return new CliError('IMAGE_INPUT', message || String(error), exitCode, error);
  }
  return new CliError(
    'IMAGE_INPUT',
    `图片直读失败后已尝试读取当前 ${clipboardSystemName(platform)} 剪贴板，但没有取得可用图片（${singleLine(message)}）。Agent 下一步：请用户重新上传图片或提供绝对路径；不要搜索工作目录或重复读取剪贴板`,
    exitCode,
    error,
  );
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
    credentials,
    geminiModels = gemini.DEFAULT_MODELS,
    zhipuModels = zhipu.DEFAULT_MODELS,
    adapters = { gemini, zhipu },
    fetchImpl,
    onStatus,
  } = options;
  const failures = [];
  const availableProviders = [];
  for (const provider of providerOrder()) {
    const credential = credentials[provider];
    if (!credential || !credential.key) {
      failures.push({ provider, missing: true });
      if (onStatus) onStatus({ type: 'provider_skipped', provider, envName: PROVIDER_KEYS[provider] });
      continue;
    }
    availableProviders.push(provider);
    if (onStatus) onStatus({
      type: 'provider_available',
      provider,
      models: modelsFor(provider, geminiModels, zhipuModels),
    });
  }
  if (!availableProviders.length) throw keyRequiredError(providerOrder());

  for (let index = 0; index < availableProviders.length; index += 1) {
    const provider = availableProviders[index];
    const credential = credentials[provider];
    const nextProvider = availableProviders[index + 1];
    const fallbackTarget = nextProvider ? firstTarget(nextProvider, geminiModels, zhipuModels) : undefined;
    try {
      const result = provider === 'gemini'
        ? await adapters.gemini.describe({ image, prompt, key: credential.key, models: geminiModels, fetchImpl, onStatus, fallbackTarget })
        : await adapters.zhipu.describe({ image, prompt, key: credential.key, models: zhipuModels, fetchImpl, onStatus, fallbackTarget });
      return { ...result, credential };
    } catch (error) {
      failures.push({ provider, error });
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
    throw new CliError('USAGE', '用法: node img2txt/scripts/describe_image.js <图片输入|clipboard|clipboard-fallback> [问题]');
  }
  cleanupRetryCaches();
  const inputMode = parseCliImageInput(process.argv[2]);
  const imageInput = inputMode.resolverInput;
  const prompt = process.argv[3] || DEFAULT_PROMPT;
  if (inputMode.clipboardFallbackRead) {
    process.stderr.write(`${formatStatusEvent({ type: 'clipboard_fallback' })}\n`);
  }
  const geminiModels = parseGeminiModels(process.env.GEMINI_MODELS);
  const zhipuModels = parseZhipuModels();
  const credentials = {
    gemini: resolveCredential('gemini'),
    zhipu: resolveCredential('zhipu'),
  };

  let retryPath = existingRetryCache(imageInput);
  if (retryPath && isClipboardFallbackRetryCache(retryPath)) {
    inputMode.clipboardFallback = true;
  }
  if (!credentials.gemini.key && !credentials.zhipu.key) {
    if (inputMode.clipboard) {
      const clipboardImage = await standardizeCliImageInput(inputMode);
      retryPath = createRetryCache(clipboardImage, inputMode);
    }
    const error = keyRequiredError(providerOrder());
    throw new CliError(error.code, `${error.message}${retryHint(retryPath)}`, error.exitCode, error);
  }

  const standardized = await standardizeCliImageInput(inputMode);

  if (inputMode.clipboard) retryPath = createRetryCache(standardized, inputMode);

  let result;
  try {
    result = await describeWithProviders({
      image: standardized,
      prompt,
      credentials,
      geminiModels,
      zhipuModels,
      onStatus: (event) => process.stderr.write(`${formatStatusEvent(event)}\n`),
    });
  } catch (error) {
    const hint = retryHint(retryPath);
    if (error instanceof CliError) throw new CliError(error.code, `${error.message}${hint}`, error.exitCode, error);
    throw new CliError('PROVIDERS_FAILED', `${error.message || error}${hint}`, 1, error);
  }

  process.stdout.write(`${formatSuccessfulOutput(result, inputMode)}\n`);
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
  CLIPBOARD_FALLBACK_INPUT,
  ZHIPU_MAX_IMAGE_BYTES: zhipu.IMAGE_PROFILE.maxBytes,
  ZHIPU_MAX_IMAGE_DIMENSION: zhipu.IMAGE_PROFILE.maxDimension,
  RETRY_CACHE_MAX_AGE_MS,
  cleanupRetryCaches,
  createRetryCache,
  describeWithProviders,
  formatStatusEvent,
  formatSuccessfulOutput,
  handleFatalError,
  imageToBase64,
  imageInputCliError,
  isClipboardFallbackRetryCache,
  main,
  parseGeminiModels,
  parseCliImageInput,
  parseZhipuModels,
  keyGuidance,
  keyRequiredError,
  prepareForZhipu,
  providerOrder,
  standardizeCliImageInput,
};
