const { prepareImage } = require('../image_preparer');
const { ProviderError, singleLine } = require('../errors');
const { fetchWithTimeout } = require('./http');

const PROVIDER = 'gemini';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const DEFAULT_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
];
const RETRIES = 3;
const RETRY_BASE_DELAY = 2000;
// Inline requests are limited to 20MB total. 14MB raw leaves room for Base64 expansion and JSON/text.
const IMAGE_PROFILE = {
  label: 'Gemini inline image',
  maxBytes: 14_000_000,
  allowedMimes: ['image/jpeg', 'image/png'],
  minJpegQuality: 68,
  qualitySearchIterations: 4,
  compressionProfiles: [[8192, 92], [6144, 90], [4096, 86], [3200, 82], [2400, 78], [1800, 72], [1400, 68], [1024, 60]],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(data, model) {
  const parts = data && data.candidates && data.candidates[0]
    && data.candidates[0].content && data.candidates[0].content.parts;
  const text = Array.isArray(parts) ? parts.map((part) => part && part.text).filter(Boolean).join('') : '';
  if (text) return text;
  const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
  throw new ProviderError(PROVIDER, 'INVALID_RESPONSE', blockReason
    ? `模型 ${model} 拒绝请求: ${blockReason}`
    : `模型 ${model} 返回了空响应`, { model });
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
    ? `，服务端建议约 ${Math.ceil(retryAfterMs / 1000)} 秒后重试该模型`
    : '';
  return `模型 ${model} 达到模型级配额${retryHint}`;
}

function providerQuotaMessage(retryAfterMs) {
  const retryHint = retryAfterMs
    ? `，服务端建议约 ${Math.ceil(retryAfterMs / 1000)} 秒后恢复`
    : '';
  return `Gemini Provider 达到配额限制${retryHint}`;
}

async function requestModel({ model, payload, key, fetchImpl, sleepImpl = sleep }) {
  const url = API_URL.replace('{model}', encodeURIComponent(model));
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (attempt < RETRIES - 1) {
        await sleepImpl(RETRY_BASE_DELAY * (2 ** attempt));
        continue;
      }
      throw new ProviderError(PROVIDER, 'NETWORK', `Gemini 网络请求失败: ${singleLine(error.message || error)}`, {
        model, retryable: true, cause: error,
      });
    }

    const raw = await response.text();
    if (response.ok) {
      let data;
      try { data = JSON.parse(raw); }
      catch (error) {
        throw new ProviderError(PROVIDER, 'INVALID_JSON', `模型 ${model} 返回了非 JSON 响应`, { model, cause: error });
      }
      return extractText(data, model);
    }

    const auth = isAuthError(response.status, raw);
    if (auth) {
      throw new ProviderError(PROVIDER, 'AUTH', `Gemini API key 无效或无权访问（HTTP ${response.status}）`, {
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
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < RETRIES - 1) {
      await sleepImpl(RETRY_BASE_DELAY * (2 ** attempt));
      continue;
    }
    throw new ProviderError(PROVIDER, 'HTTP', `模型 ${model} 调用失败（HTTP ${response.status}）: ${singleLine(raw).slice(0, 300)}`, {
      model,
      status: response.status,
      retryable,
      quotaScope: limit && limit.quotaScope,
      retryAfterMs: limit && limit.retryAfterMs,
    });
  }
}

async function describe({ image, prompt, key, models = DEFAULT_MODELS, fetchImpl, sleepImpl }) {
  const prepared = await prepareImage(image, IMAGE_PROFILE);
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: prepared.mime, data: prepared.data.toString('base64') } },
        { text: prompt },
      ],
    }],
  };
  const failures = [];
  for (const model of models) {
    try {
      const text = await requestModel({ model, payload, key, fetchImpl, sleepImpl });
      return { text, model, provider: PROVIDER };
    } catch (error) {
      if (error instanceof ProviderError && error.quotaScope === 'provider') throw error;
      if (error instanceof ProviderError && error.quotaScope === 'model') {
        failures.push(`${model}: ${singleLine(error.message || error)}`);
        continue;
      }
      if (error instanceof ProviderError && (error.auth || error.retryable || error.code === 'NETWORK')) throw error;
      failures.push(`${model}: ${singleLine(error.message || error)}`);
    }
  }
  throw new ProviderError(PROVIDER, 'MODELS_FAILED', `所有 Gemini 模型均失败: ${failures.join(' | ')}`);
}

module.exports = { API_URL, DEFAULT_MODELS, IMAGE_PROFILE, PROVIDER, describe, requestModel };
