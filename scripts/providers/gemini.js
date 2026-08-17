const { prepareImage } = require('../image_preparer');
const { ProviderError, providerFailureScope, singleLine } = require('../errors');
const { fetchWithTimeout } = require('./http');
const { encodeBase64 } = require('../image_codec');
const { isBatchCancelled } = require('../workflow/cancellation');

const PROVIDER = 'gemini';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const DEFAULT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
];
// Inline requests are limited to 20MB total. 14MB raw leaves room for Base64 expansion and JSON/text.
const IMAGE_PROFILE = {
  label: 'Gemini inline image',
  maxBytes: 14_000_000,
  allowedMimes: ['image/jpeg', 'image/png'],
  minJpegQuality: 68,
  qualitySearchIterations: 4,
  compressionProfiles: [[8192, 92], [6144, 90], [4096, 86], [3200, 82], [2400, 78], [1800, 72], [1400, 68], [1024, 60]],
};

function extractText(data, model) {
  const parts = data && data.candidates && data.candidates[0]
    && data.candidates[0].content && data.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map((part) => part && part.text).filter(Boolean).join('') : '';
  if (text) return text;
  const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
  throw new ProviderError(PROVIDER, 'INVALID_RESPONSE', blockReason
    ? `Model ${model} rejected the request: ${blockReason}`
    : `Model ${model} returned an empty response`, { model });
}

function isAuthError(status, raw) {
  return status === 401 || status === 403
    || (status === 400 && /API_KEY_INVALID|API key not valid|API_KEY/i.test(raw));
}

function parseJson(raw) {
  try { return JSON.parse(raw); }
  catch (_error) { return null; }
}

function durationToMilliseconds(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function rateLimitDetails(raw) {
  const body = parseJson(raw);
  const details = body && body.error && Array.isArray(body.error.details)
    ? body.error.details
    : [];
  const quotaFailures = details.filter((detail) => String(detail && detail['@type']).endsWith('QuotaFailure'));
  const violations = quotaFailures.flatMap((detail) => Array.isArray(detail.violations) ? detail.violations : []);
  const modelScoped = violations.some((violation) => {
    const dimensions = violation && violation.quotaDimensions;
    return Boolean(dimensions && dimensions.model)
      || /per.?model/i.test(String(violation && violation.quotaId));
  });
  const retryInfo = details.find((detail) => String(detail && detail['@type']).endsWith('RetryInfo'));
  return {
    quotaScope: modelScoped ? 'model' : 'provider',
    retryAfterMs: durationToMilliseconds(retryInfo && retryInfo.retryDelay),
  };
}

function modelQuotaMessage(model, retryAfterMs) {
  const retryHint = retryAfterMs
    ? `; the server recommends retrying this model in about ${Math.ceil(retryAfterMs / 1000)} seconds`
    : '';
  return `Model ${model} reached a model-level quota${retryHint}`;
}

function providerQuotaMessage(retryAfterMs) {
  const retryHint = retryAfterMs
    ? `; the server recommends waiting about ${Math.ceil(retryAfterMs / 1000)} seconds for recovery`
    : '';
  return `Gemini Provider reached its quota limit${retryHint}`;
}

async function requestModel({ model, payload, key, fetchImpl, signal }) {
  const url = API_URL.replace('{model}', encodeURIComponent(model));
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (isBatchCancelled(error)) throw error;
    throw new ProviderError(PROVIDER, 'NETWORK', `Gemini network request failed: ${singleLine(error.message || error)}`, {
      model, retryable: true, cause: error,
    });
  }

  const raw = await response.text();
  if (response.ok) {
    let data;
    try { data = JSON.parse(raw); }
    catch (error) {
      throw new ProviderError(PROVIDER, 'INVALID_JSON', `Model ${model} returned a non-JSON response`, { model, cause: error });
    }
    return extractText(data, model);
  }

  const auth = isAuthError(response.status, raw);
  if (auth) {
    throw new ProviderError(PROVIDER, 'AUTH', `Gemini API Key is invalid or unauthorized (HTTP ${response.status})`, {
      model, status: response.status, auth: true,
    });
  }
  const limit = response.status === 429 ? rateLimitDetails(raw) : null;
  if (limit && limit.quotaScope === 'model') {
    throw new ProviderError(PROVIDER, 'MODEL_RATE_LIMIT', modelQuotaMessage(model, limit.retryAfterMs), {
      model,
      status: response.status,
      quotaScope: limit.quotaScope,
      retryAfterMs: limit.retryAfterMs,
    });
  }
  if (limit && limit.quotaScope === 'provider' && limit.retryAfterMs) {
    throw new ProviderError(PROVIDER, 'PROVIDER_RATE_LIMIT', providerQuotaMessage(limit.retryAfterMs), {
      model,
      status: response.status,
      quotaScope: limit.quotaScope,
      retryAfterMs: limit.retryAfterMs,
    });
  }
  const modelUnavailable = response.status === 503 && /(?:this\s+model|model).*(?:high\s+demand|unavailable)/i.test(raw);
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw new ProviderError(PROVIDER, modelUnavailable ? 'MODEL_UNAVAILABLE' : 'HTTP', `Model ${model} call failed (HTTP ${response.status}): ${singleLine(raw).slice(0, 300)}`, {
      model,
      status: response.status,
      retryable,
      quotaScope: limit && limit.quotaScope,
      retryAfterMs: limit && limit.retryAfterMs,
      scope: modelUnavailable ? 'model' : undefined,
  });
}

function failureDetails(model, error) {
  return {
    provider: PROVIDER,
    model,
    code: error instanceof ProviderError ? error.code : 'UNEXPECTED',
    status: error instanceof ProviderError ? error.status : undefined,
    auth: error instanceof ProviderError && error.auth,
    quotaScope: error instanceof ProviderError ? error.quotaScope : undefined,
    scope: providerFailureScope(error),
    message: singleLine(error.message || error),
  };
}

async function describe({ image, prompt, key, models = DEFAULT_MODELS, fetchImpl, onStatus, fallbackTarget, signal }) {
  const prepared = await prepareImage(image, IMAGE_PROFILE);
  const imageBase64 = encodeBase64(prepared);
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: prepared.mime, data: imageBase64 } },
        { text: prompt },
      ],
    }],
  };
  const failures = [];
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    try {
      const text = await requestModel({ model, payload, key, fetchImpl, signal });
      return { text, model, provider: PROVIDER };
    } catch (error) {
      if (isBatchCancelled(error)) throw error;
      const failure = failureDetails(model, error);
      failures.push(failure);
      const next = failure.scope === 'provider'
        ? fallbackTarget
        : (models[index + 1] ? `${PROVIDER}/${models[index + 1]}` : fallbackTarget);
      const type = failure.scope === 'provider'
        ? (next ? 'provider_switch' : 'provider_failed')
        : (next ? 'model_switch' : 'model_failed');
      if (onStatus) onStatus({ type, ...failure, next });
      if (failure.scope === 'provider') {
        throw new ProviderError(PROVIDER, 'PROVIDER_UNAVAILABLE', `${model} had a Provider-level failure: ${failure.message}`, {
          failures,
        });
      }
    }
  }
  throw new ProviderError(PROVIDER, 'MODELS_FAILED', `All Gemini models failed: ${failures.map((item) => `${item.model}: ${item.message}`).join(' | ')}`, {
    failures,
  });
}

module.exports = { API_URL, DEFAULT_MODELS, IMAGE_PROFILE, PROVIDER, describe };
