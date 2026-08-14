const fs = require('fs');
const os = require('os');
const path = require('path');
const { standardizeImageInput, ImageStandardizationError } = require('./image_input_resolver');
const { prepareImage } = require('./image_preparer');
const { CliError, ProviderError, formatCliError, singleLine } = require('./errors');
const {
  PROVIDER_KEYS,
  persistUserEnvironmentKey,
  readStdinCredential,
  resolveCredential,
} = require('./key_store');
const gemini = require('./providers/gemini');
const zhipu = require('./providers/zhipu');

const RETRY_CACHE_PREFIX = 'img2txt_retry_';
const RETRY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROMPT = '请详细描述这张图片的内容';
const VALID_PROVIDER_MODES = new Set(['auto', 'gemini', 'zhipu']);
const PROVIDER_REGISTRATION_URLS = {
  zhipu: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  gemini: 'https://aistudio.google.com/apikey',
};

function retryHint(retryPath) {
  return retryPath ? ` 图片已缓存至 ${retryPath}；取得新 key 后使用该路径重试，不要再次读取 clipboard。` : '';
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

function providerModeFromEnvironment() {
  const mode = (process.env.VISION_PROVIDER || 'auto').trim().toLowerCase();
  if (!VALID_PROVIDER_MODES.has(mode)) {
    throw new CliError('CONFIG', `VISION_PROVIDER 仅支持 auto、gemini 或 zhipu，当前值为 ${mode}`);
  }
  return mode;
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

function prioritizeModel(models, preferredModel) {
  if (!preferredModel) return [...models];
  return [preferredModel, ...models.filter((model) => model.toLowerCase() !== preferredModel.toLowerCase())];
}

function isNegatedMention(text, index) {
  const prefix = text.slice(Math.max(0, index - 32), index);
  return /(?:不要(?:再)?(?:使用|用|选择|调用)?|别(?:使用|用|选|调用)?|禁止(?:使用|用|选择|调用)?|避免(?:使用|用|选择|调用)?|不(?:使用|用|选择|调用)|请?勿(?:使用|用|选择|调用)?|do\s+not\s+use|don't\s+use|avoid|instead\s+of)\s*$/i.test(prefix);
}

function firstMention(prompt, candidates) {
  const lower = String(prompt || '').toLowerCase();
  const mentions = [];
  for (const candidate of candidates) {
    let offset = 0;
    while (offset < lower.length) {
      const index = lower.indexOf(candidate.term, offset);
      if (index < 0) break;
      if (!isNegatedMention(lower, index)) mentions.push({ ...candidate, index });
      offset = index + candidate.term.length;
    }
  }
  return mentions
    .sort((left, right) => left.index - right.index)[0] || null;
}

function detectRoutingIntent(prompt) {
  const exact = firstMention(prompt, [
    { term: 'glm-4.1v-thinking-flash', provider: 'zhipu', model: 'glm-4.1v-thinking-flash' },
    { term: 'glm-4.6v-flash', provider: 'zhipu', model: 'glm-4.6v-flash' },
  ]);
  if (exact) return exact;

  const lower = String(prompt || '').toLowerCase();
  const geminiModel = [...lower.matchAll(/\bgemini-[a-z0-9._-]+\b/g)]
    .find((match) => !isNegatedMention(lower, match.index));
  if (geminiModel) return { provider: 'gemini', model: geminiModel[0] };

  return firstMention(prompt, [
    { term: 'gemini', provider: 'gemini' },
    { term: 'google', provider: 'gemini' },
    { term: '谷歌', provider: 'gemini' },
    { term: 'glm', provider: 'zhipu' },
    { term: '智谱', provider: 'zhipu' },
  ]);
}

function providerOrder(mode) {
  return mode === 'gemini' ? ['gemini', 'zhipu'] : ['zhipu', 'gemini'];
}

function resolveRouting(prompt, environmentMode, geminiModels, zhipuModels) {
  const intent = detectRoutingIntent(prompt);
  const mode = intent ? intent.provider : environmentMode;
  return {
    mode,
    providerOrder: providerOrder(mode),
    geminiModels: intent && intent.provider === 'gemini' && intent.model
      ? prioritizeModel(geminiModels, intent.model)
      : [...geminiModels],
    zhipuModels: intent && intent.provider === 'zhipu' && intent.model
      ? prioritizeModel(zhipuModels, intent.model)
      : [...zhipuModels],
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
    return `${provider}: 注册 ${PROVIDER_REGISTRATION_URLS[provider]}；设置命令 setx ${envName} "<你的Key>"；或手动提供 ${envName}=<key>`;
  }).join(' | ');
}

function keyRequiredError(providers, context = '') {
  const prefix = context ? `${context}；` : '';
  return new CliError('KEY_REQUIRED', `${prefix}未检测到可用 API key。${keyGuidance(providers)}`, 2);
}

async function describeWithProviders(options) {
  const {
    image,
    prompt,
    mode = 'auto',
    credentials,
    geminiModels = gemini.DEFAULT_MODELS,
    zhipuModels = zhipu.DEFAULT_MODELS,
    adapters = { gemini, zhipu },
    fetchImpl,
    sleepImpl,
  } = options;
  const failures = [];
  for (const provider of providerOrder(mode)) {
    const credential = credentials[provider];
    if (!credential || !credential.key) {
      failures.push({ provider, missing: true });
      continue;
    }
    try {
      const result = provider === 'gemini'
        ? await adapters.gemini.describe({ image, prompt, key: credential.key, models: geminiModels, fetchImpl, sleepImpl })
        : await adapters.zhipu.describe({ image, prompt, key: credential.key, models: zhipuModels, fetchImpl, sleepImpl });
      return { ...result, credential };
    } catch (error) {
      failures.push({ provider, error });
    }
  }

  const credentialFailures = failures.filter(({ error, missing }) =>
    missing || (error instanceof ProviderError && error.auth));
  if (credentialFailures.length) {
    const providers = credentialFailures.map(({ provider }) => provider);
    throw keyRequiredError(providers, `没有视觉模型成功完成请求：${summarizeFailures(failures)}`);
  }
  throw new CliError('PROVIDERS_FAILED', `没有视觉模型成功完成请求：${summarizeFailures(failures)}`, 1);
}

async function main() {
  if (process.argv.length < 3) {
    throw new CliError('USAGE', '用法: node img2txt/scripts/describe_image.js <图片输入|clipboard> [问题]');
  }
  cleanupRetryCaches();
  const imageInput = process.argv[2];
  const prompt = process.argv[3] || DEFAULT_PROMPT;
  const environmentMode = providerModeFromEnvironment();

  const routing = resolveRouting(
    prompt,
    environmentMode,
    parseGeminiModels(process.env.GEMINI_MODELS),
    parseZhipuModels(),
  );
  const stdinCredential = readStdinCredential(routing.mode);
  const credentials = {
    gemini: resolveCredential('gemini', stdinCredential),
    zhipu: resolveCredential('zhipu', stdinCredential),
  };

  let retryPath = existingRetryCache(imageInput);
  if (!credentials.gemini.key && !credentials.zhipu.key) {
    if (imageInput === 'clipboard') {
      try {
        const clipboardImage = await standardizeImageInput(imageInput);
        retryPath = createRetryCache(clipboardImage);
      } catch (error) {
        if (error instanceof ImageStandardizationError) throw new CliError('IMAGE_INPUT', error.message, error.code, error);
        throw error;
      }
    }
    const error = keyRequiredError(routing.providerOrder);
    throw new CliError(error.code, `${error.message}${retryHint(retryPath)}`, error.exitCode, error);
  }

  let standardized;
  try {
    standardized = await standardizeImageInput(imageInput);
  } catch (error) {
    if (error instanceof ImageStandardizationError) {
      throw new CliError('IMAGE_INPUT', error.message, error.code, error);
    }
    throw new CliError('IMAGE_INPUT', error.message || String(error), 1, error);
  }

  if (imageInput === 'clipboard') retryPath = createRetryCache(standardized);

  let result;
  try {
    result = await describeWithProviders({
      image: standardized,
      prompt,
      mode: routing.mode,
      credentials,
      geminiModels: routing.geminiModels,
      zhipuModels: routing.zhipuModels,
    });
  } catch (error) {
    const hint = retryHint(retryPath);
    if (error instanceof CliError) throw new CliError(error.code, `${error.message}${hint}`, error.exitCode, error);
    throw new CliError('PROVIDERS_FAILED', `${error.message || error}${hint}`, 1, error);
  }

  process.stdout.write(`${result.text}\n`);
  if (result.credential.source === 'stdin') {
    const persisted = persistUserEnvironmentKey(result.provider, result.credential.key);
    const envName = PROVIDER_KEYS[result.provider];
    process.stderr.write(persisted
      ? `[INFO] 已持久化 ${envName} 到当前用户环境变量\n`
      : `[WARN] 无法持久化 ${envName}，本次调用已成功但后续会话可能需要重新提供\n`);
  }
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
  ZHIPU_MAX_IMAGE_BYTES: zhipu.IMAGE_PROFILE.maxBytes,
  ZHIPU_MAX_IMAGE_DIMENSION: zhipu.IMAGE_PROFILE.maxDimension,
  RETRY_CACHE_MAX_AGE_MS,
  cleanupRetryCaches,
  createRetryCache,
  describeWithProviders,
  detectRoutingIntent,
  handleFatalError,
  imageToBase64,
  main,
  parseGeminiModels,
  parseZhipuModels,
  keyGuidance,
  keyRequiredError,
  prioritizeModel,
  prepareForZhipu,
  providerOrder,
  resolveRouting,
};
