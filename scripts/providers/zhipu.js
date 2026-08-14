const { prepareImage } = require('../image_preparer');
const { ProviderError, singleLine } = require('../errors');
const { fetchWithTimeout } = require('./http');

const PROVIDER = 'zhipu';
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODELS = ['glm-4.1v-thinking-flash', 'glm-4.6v-flash'];
const DEFAULT_MODEL = DEFAULT_MODELS[0];
const RETRIES = 3;
const RETRY_BASE_DELAY = 2000;
const IMAGE_PROFILE = {
  label: '智谱视觉模型',
  maxBytes: 5_000_000,
  maxDimension: 6000,
  allowedMimes: ['image/jpeg', 'image/png'],
  compressionProfiles: [[6000, 90], [5000, 88], [4000, 85], [3200, 82], [2400, 78], [1800, 72], [1400, 68], [1024, 60], [768, 50]],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(data, model) {
  const content = data && data.choices && data.choices[0]
    && data.choices[0].message && data.choices[0].message.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => part && part.text).filter(Boolean).join('');
    if (text) return text;
  }
  throw new ProviderError(PROVIDER, 'INVALID_RESPONSE', `模型 ${model} 返回了空响应`, { model });
}

async function requestModel({ model, payload, key, fetchImpl, sleepImpl = sleep }) {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (attempt < RETRIES - 1) {
        await sleepImpl(RETRY_BASE_DELAY * (2 ** attempt));
        continue;
      }
      throw new ProviderError(PROVIDER, 'NETWORK', `智谱网络请求失败: ${singleLine(error.message || error)}`, {
        model, retryable: true, cause: error,
      });
    }
    const raw = await response.text();
    if (response.status === 401) {
      throw new ProviderError(PROVIDER, 'AUTH', '智谱 API key 无效或已失效（401）', {
        model, status: response.status, auth: true,
      });
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < RETRIES - 1) {
      await sleepImpl(RETRY_BASE_DELAY * (2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new ProviderError(PROVIDER, 'HTTP', `智谱模型 ${model} 调用失败（HTTP ${response.status}）: ${singleLine(raw).slice(0, 300)}`, {
        model, status: response.status, retryable,
      });
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (error) {
      throw new ProviderError(PROVIDER, 'INVALID_JSON', `智谱模型 ${model} 返回了非 JSON 响应`, { model, cause: error });
    }
    return extractText(data, model);
  }
}

async function describe({ image, prompt, key, models = DEFAULT_MODELS, model, fetchImpl, sleepImpl }) {
  const modelSequence = model ? [model] : models;
  const prepared = await prepareImage(image, IMAGE_PROFILE);
  const failures = [];
  for (const currentModel of modelSequence) {
    if (currentModel.toLowerCase() === 'glm-4v-flash') {
      failures.push(`${currentModel}: 官方文档明确该模型不支持 Base64 图片`);
      continue;
    }
    const payload = {
      model: currentModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: prepared.data.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      }],
    };
    try {
      const text = await requestModel({ model: currentModel, payload, key, fetchImpl, sleepImpl });
      return { text, model: currentModel, provider: PROVIDER };
    } catch (error) {
      if (error instanceof ProviderError
        && (error.auth || error.retryable || error.code === 'NETWORK' || error.status === 400)) throw error;
      failures.push(`${currentModel}: ${singleLine(error.message || error)}`);
    }
  }
  throw new ProviderError(PROVIDER, 'MODELS_FAILED', `所有智谱模型均失败: ${failures.join(' | ')}`);
}

module.exports = { API_URL, DEFAULT_MODEL, DEFAULT_MODELS, IMAGE_PROFILE, PROVIDER, describe, requestModel };
