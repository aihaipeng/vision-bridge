const { prepareImage } = require('../image_preparer');
const { ProviderError, providerFailureScope, singleLine } = require('../errors');
const { fetchWithTimeout } = require('./http');
const { encodeDataUrl } = require('../image_codec');
const { isBatchCancelled } = require('../workflow/cancellation');

const PROVIDER = 'mistral';
const API_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODELS = ['mistral-medium-3.5', 'mistral-medium-latest'];
const DEFAULT_MODEL = DEFAULT_MODELS[0];
const IMAGE_PROFILE = {
  label: 'Mistral vision model',
  maxBytes: 10_000_000,
  maxDimension: 4096,
  allowedMimes: ['image/jpeg', 'image/png'],
  minJpegQuality: 68,
  qualitySearchIterations: 4,
  compressionProfiles: [[4096, 90], [3200, 86], [2400, 82], [1800, 76], [1400, 70], [1024, 62], [768, 54]],
};

function extractText(data, model) {
  const content = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => part && part.text).filter(Boolean).join('');
    if (text) return text;
  }
  throw new ProviderError(PROVIDER, 'INVALID_RESPONSE', `Model ${model} returned an empty response`, { model });
}

async function requestModel({ model, payload, key, fetchImpl, signal }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (isBatchCancelled(error)) throw error;
    throw new ProviderError(PROVIDER, 'NETWORK', `Mistral network request failed: ${singleLine(error.message || error)}`, {
      model, retryable: true, cause: error,
    });
  }
  const raw = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError(PROVIDER, 'AUTH', `Mistral API Key is invalid, expired, or unauthorized (HTTP ${response.status})`, {
      model, status: response.status, auth: true,
    });
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.ok) {
    const modelNotFound = response.status === 404
      || /model.*not\s*found|no\s+such\s+model|unknown\s+model|invalid[_\s]*model/i.test(raw);
    throw new ProviderError(PROVIDER, modelNotFound ? 'MODEL_NOT_FOUND' : 'HTTP', `Mistral model ${model} call failed (HTTP ${response.status}): ${singleLine(raw).slice(0, 300)}`, {
      model, status: response.status, retryable, scope: modelNotFound ? 'model' : undefined,
    });
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (error) {
    throw new ProviderError(PROVIDER, 'INVALID_JSON', `Mistral model ${model} returned a non-JSON response`, { model, cause: error });
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

async function describe({ image, prompt, key, models = DEFAULT_MODELS, model, fetchImpl, onStatus, fallbackTarget, signal }) {
  const modelSequence = model ? [model] : models;
  const prepared = await prepareImage(image, IMAGE_PROFILE);
  const imageUrl = encodeDataUrl(prepared);
  const failures = [];
  for (let index = 0; index < modelSequence.length; index += 1) {
    const currentModel = modelSequence[index];
    const payload = {
      model: currentModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: prompt },
        ],
      }],
    };
    try {
      const text = await requestModel({ model: currentModel, payload, key, fetchImpl, signal });
      return { text, model: currentModel, provider: PROVIDER };
    } catch (error) {
      if (isBatchCancelled(error)) throw error;
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
        throw new ProviderError(PROVIDER, 'PROVIDER_UNAVAILABLE', `${currentModel} had a Provider-level failure: ${failure.message}`, {
          failures,
        });
      }
    }
  }
  throw new ProviderError(PROVIDER, 'MODELS_FAILED', `All Mistral models failed: ${failures.map((item) => `${item.model}: ${item.message}`).join(' | ')}`, {
    failures,
  });
}

module.exports = { API_URL, DEFAULT_MODEL, DEFAULT_MODELS, IMAGE_PROFILE, PROVIDER, describe };
