const { CliError, ProviderError, singleLine } = require('../errors');
const { isBatchCancelled, throwIfCancelled } = require('../workflow/cancellation');
const { PROVIDER_EXTRA_KEYS, PROVIDER_KEYS } = require('../key_store');
const {
  cooledModels,
  createHealthStore,
  orderModels,
  orderProviders,
  providerCooldown,
  recordFailure,
  recordProviderFailure,
  recordSuccess,
} = require('../model_health');
const cloudflare = require('./cloudflare');
const gemini = require('./gemini');
const mistral = require('./mistral');
const nvidia = require('./nvidia');
const zhipu = require('./zhipu');

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

function parseModelsValue(value, fallback) {
  const models = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return models.length ? models : fallback;
}

function providerOrder() {
  return [...PROVIDER_ORDER];
}

function credentialReady(provider, credential) {
  if (!credential || !credential.key) return false;
  const extraEnvName = PROVIDER_EXTRA_KEYS[provider];
  return !extraEnvName || Boolean(credential.extra && credential.extra.value);
}

function modelsForProvider(provider) {
  return parseModelsValue(process.env[PROVIDER_MODEL_ENVS[provider]], PROVIDER_MODULES[provider].DEFAULT_MODELS);
}

function summarizeFailures(failures) {
  return failures.map(({ provider, error, missing }) => {
    if (missing) return `${provider}: missing ${PROVIDER_KEYS[provider]}`;
    return `${provider}: ${singleLine(error.message || error)}`;
  }).join(' | ');
}

function keyGuidance(providers) {
  return [...new Set(providers)].map((provider) => {
    const envName = PROVIDER_KEYS[provider];
    return `${provider}: configure local user environment variable ${envName}; registration page ${PROVIDER_REGISTRATION_URLS[provider]}`;
  }).join(' | ');
}

function keyRequiredError(providers, context = '') {
  const prefix = context ? `${context}. ` : '';
  return new CliError('KEY_REQUIRED', `${prefix}No usable API Key was detected. ${keyGuidance(providers)}. After configuration, run npm run doctor in the Skill directory; the Agent does not need to restart. Do not send Keys in chat`, 2);
}

function modelFailures(failures) {
  return failures.flatMap(({ error }) => error instanceof ProviderError ? error.failures : []);
}

function recoveryGuidance(failures) {
  const attempts = modelFailures(failures);
  const actions = [];
  if (failures.some(({ missing }) => missing) || attempts.some(({ auth }) => auth)) {
    actions.push('Check that the corresponding API Key is correctly configured in a local user environment variable');
  }
  if (attempts.some(({ code }) => code === 'NETWORK')) {
    actions.push('Check outbound connectivity, HTTPS_PROXY/HTTP_PROXY, and VISION_API_TIMEOUT_MS');
  }
  if (attempts.some(({ status }) => status === 408 || status >= 500)) {
    actions.push('The Provider service is temporarily unavailable; retry later or check its official service status');
  }
  if (attempts.some(({ status, code }) => status === 429 || /RATE_LIMIT/.test(code || ''))) {
    actions.push('Wait for quota recovery or configure a valid Key for another Provider');
  }
  if (attempts.some(({ status }) => status === 400 || status === 404)) {
    actions.push('Check model configuration and current model availability for the Provider');
  }
  if (!actions.length) actions.push('Check the input, Provider status, and configuration according to each model failure');
  return `Agent next step: ${[...new Set(actions)].join('; ')}`;
}

async function describeWithProviders(options) {
  const {
    image,
    prompt,
    credentials = {},
    adapters = {},
    fetchImpl,
    onStatus,
    providerScheduler,
    signal,
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
    throwIfCancelled(signal);
    const provider = orderedProviders[index];
    const credential = credentials[provider];
    const nextProvider = orderedProviders[index + 1];
    const fallbackTarget = nextProvider
      ? (sortedModels[nextProvider].length ? `${nextProvider}/${sortedModels[nextProvider][0]}` : nextProvider)
      : undefined;
    try {
      const invokeProvider = () => resolvedAdapters[provider].describe({
        image,
        prompt,
        key: credential.key,
        models: sortedModels[provider],
        accountId: credential.extra && credential.extra.value,
        fetchImpl,
        onStatus,
        fallbackTarget,
        signal,
      });
      const result = providerScheduler
        ? await providerScheduler.run(provider, invokeProvider, { onStatus, signal })
        : await invokeProvider();
      recordSuccess(health.state, result.provider, result.model, now);
      health.persist();
      return { ...result, credential };
    } catch (error) {
      if (isBatchCancelled(error) || signal && signal.aborted) throw error;
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
    throw keyRequiredError(providers, `No vision model completed the request successfully: ${summarizeFailures(failures)}`);
  }
  const attempts = modelFailures(failures);
  const code = attempts.length > 0 && attempts.every(({ code: failureCode }) => failureCode === 'NETWORK')
    ? 'NETWORK_UNAVAILABLE'
    : (attempts.length > 0 && attempts.every(({ status }) => status === 408 || status >= 500)
      ? 'SERVICE_UNAVAILABLE'
    : (attempts.length > 0 && attempts.every(({ status, code: failureCode }) => status === 429 || /RATE_LIMIT/.test(failureCode || ''))
      ? 'RATE_LIMITED'
      : 'PROVIDERS_FAILED'));
  throw new CliError(code, `No vision model completed the request successfully: ${summarizeFailures(failures)}. ${recoveryGuidance(failures)}`, 1);
}

module.exports = {
  DEFAULT_MODEL: zhipu.DEFAULT_MODEL,
  credentialReady,
  describeWithProviders,
  keyGuidance,
  keyRequiredError,
  modelsForProvider,
  parseModelsValue,
  providerOrder,
};
