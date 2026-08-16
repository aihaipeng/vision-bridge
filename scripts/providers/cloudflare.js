const { prepareImage } = require('../image_preparer');
const { ProviderError, providerFailureScope, singleLine } = require('../errors');
const { fetchWithTimeout } = require('./http');

const PROVIDER = 'cloudflare';
const DEFAULT_MODELS = ['@cf/meta/llama-3.2-11b-vision-instruct'];
const DEFAULT_MODEL = DEFAULT_MODELS[0];
const IMAGE_PROFILE = {
  label: 'Cloudflare 视觉模型',
  maxBytes: 3_500_000,
  maxDimension: 4096,
  allowedMimes: ['image/jpeg', 'image/png'],
  minJpegQuality: 68,
  qualitySearchIterations: 4,
  compressionProfiles: [[4096, 90], [3200, 86], [2400, 82], [1800, 76], [1400, 70], [1024, 62], [768, 54]],
};

function runUrl(accountId, model) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.split('/').map(encodeURIComponent).join('/')}`;
}

async function agreeTerms({ accountId, model, key, fetchImpl }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, runUrl(accountId, model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt: 'agree' }),
    });
  } catch (error) {
    throw new ProviderError(PROVIDER, 'NETWORK', `Cloudflare 条款同意请求失败: ${singleLine(error.message || error)}`, {
      model, retryable: true, cause: error,
    });
  }
  const raw = await response.text();
  if (response.status === 401 || response.status === 403) {
    if (/thank you for agreeing|you may now use/i.test(raw)) return;
    throw new ProviderError(PROVIDER, 'AUTH', `Cloudflare API token 无效、已失效或无权访问（HTTP ${response.status}）`, {
      model, status: response.status, auth: true,
    });
  }
}

function extractText(data, model) {
  if (data && data.success === false && Array.isArray(data.errors)) {
    throw new ProviderError(PROVIDER, 'HTTP', `Cloudflare 模型 ${model} 调用失败: ${singleLine(data.errors[0] && data.errors[0].message)}`, { model });
  }
  const content = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => part && part.text).filter(Boolean).join('');
    if (text) return text;
  }
  const response = data && data.result && data.result.response;
  if (typeof response === 'string' && response) return response;
  throw new ProviderError(PROVIDER, 'INVALID_RESPONSE', `Cloudflare 模型 ${model} 返回了空响应`, { model });
}

async function requestModel({ model, payload, key, accountId, fetchImpl }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, runUrl(accountId, model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new ProviderError(PROVIDER, 'NETWORK', `Cloudflare 网络请求失败: ${singleLine(error.message || error)}`, {
      model, retryable: true, cause: error,
    });
  }
  const raw = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(PROVIDER, 'AUTH', `Cloudflare API token 无效、已失效或无权访问（HTTP ${response.status}）`, {
      model, status: response.status, auth: true,
    });
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.ok) {
    const modelNotFound = response.status === 404
      || /model.*not\s*found|no\s+such\s+model|unknown\s+model/i.test(raw);
    throw new ProviderError(PROVIDER, modelNotFound ? 'MODEL_NOT_FOUND' : 'HTTP', `Cloudflare 模型 ${model} 调用失败（HTTP ${response.status}）: ${singleLine(raw).slice(0, 300)}`, {
      model, status: response.status, retryable, scope: modelNotFound ? 'model' : undefined,
    });
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (error) {
    throw new ProviderError(PROVIDER, 'INVALID_JSON', `Cloudflare 模型 ${model} 返回了非 JSON 响应`, { model, cause: error });
  }
  return extractText(data, model);
}

function failureDetails(model, error) {
  return {
    provider: PROVIDER,
    model,
    code: error instanceof ProviderError ? error.code : 'UNEXPECTED',
    status: error instanceof ProviderError ? error.status : undefined,
    auth: error instanceof ProviderError && error.auth,
    scope: providerFailureScope(error),
    message: singleLine(error.message || error),
  };
}

async function describe({ image, prompt, key, accountId, models = DEFAULT_MODELS, model, fetchImpl, onStatus, fallbackTarget }) {
  if (!accountId) {
    throw new ProviderError(PROVIDER, 'CONFIG', 'Cloudflare 缺少 CLOUDFLARE_ACCOUNT_ID,无法构造 API URL', { scope: 'provider' });
  }
  const modelSequence = model ? [model] : models;
  const prepared = await prepareImage(image, IMAGE_PROFILE);
  const failures = [];
  for (let index = 0; index < modelSequence.length; index += 1) {
    const currentModel = modelSequence[index];
    const payload = {
      model: currentModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${prepared.mime};base64,${prepared.data.toString('base64')}` } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: 1024,
    };
    try {
      await agreeTerms({ accountId, model: currentModel, key, fetchImpl });
      const text = await requestModel({ model: currentModel, payload, key, accountId, fetchImpl });
      return { text, model: currentModel, provider: PROVIDER };
    } catch (error) {
      const failure = failureDetails(currentModel, error);
      failures.push(failure);
      const next = failure.scope === 'provider'
        ? fallbackTarget
        : (modelSequence[index + 1] ? `${PROVIDER}/${modelSequence[index + 1]}` : fallbackTarget);
      const type = failure.scope === 'provider'
        ? (next ? 'provider_switch' : 'provider_failed')
        : (next ? 'model_switch' : 'model_failed');
      if (onStatus) onStatus({ type, ...failure, next });
      if (failure.scope === 'provider') {
        throw new ProviderError(PROVIDER, 'PROVIDER_UNAVAILABLE', `${currentModel} 发生 Provider 级故障: ${failure.message}`, {
          failures,
        });
      }
    }
  }
  throw new ProviderError(PROVIDER, 'MODELS_FAILED', `所有 Cloudflare 模型均失败: ${failures.map((item) => `${item.model}: ${item.message}`).join(' | ')}`, {
    failures,
  });
}

module.exports = { DEFAULT_MODEL, DEFAULT_MODELS, IMAGE_PROFILE, PROVIDER, agreeTerms, describe, runUrl };
