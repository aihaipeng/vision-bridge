const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');
const cloudflare = require('../scripts/providers/cloudflare');
const gemini = require('../scripts/providers/gemini');
const mistral = require('../scripts/providers/mistral');
const nvidia = require('../scripts/providers/nvidia');
const zhipu = require('../scripts/providers/zhipu');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

async function canonicalPng() {
  const data = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 1 },
    },
  }).png().toBuffer();
  return { data, mime: 'image/png' };
}

async function captureRequest(provider, options = {}) {
  const image = await canonicalPng();
  const requests = [];
  const fetchImpl = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    if (provider === gemini) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }
    if (provider === cloudflare && requests.length === 1) return jsonResponse({ success: true });
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  };

  await provider.describe({
    image,
    prompt: 'describe',
    key: 'test-key',
    models: [provider.DEFAULT_MODELS[0]],
    fetchImpl,
    accountId: options.accountId,
  });

  return { image, payload: requests[requests.length - 1] };
}

test('Zhipu request uses raw Base64', async () => {
  const { image, payload } = await captureRequest(zhipu);

  assert.equal(
    payload.messages[0].content[0].image_url.url,
    image.data.toString('base64'),
  );
});

test('Gemini request uses raw Base64 with a separate MIME type', async () => {
  const { image, payload } = await captureRequest(gemini);
  const inlineData = payload.contents[0].parts[0].inline_data;

  assert.equal(inlineData.mime_type, image.mime);
  assert.equal(inlineData.data, image.data.toString('base64'));
});

for (const [name, provider, options] of [
  ['Mistral', mistral, {}],
  ['NVIDIA', nvidia, {}],
  ['Cloudflare', cloudflare, { accountId: 'test-account' }],
]) {
  test(`${name} request uses a Base64 data URL`, async () => {
    const { image, payload } = await captureRequest(provider, options);

    assert.equal(
      payload.messages[0].content[0].image_url.url,
      `data:${image.mime};base64,${image.data.toString('base64')}`,
    );
  });
}
