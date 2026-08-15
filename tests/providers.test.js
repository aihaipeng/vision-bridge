const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const test = require('node:test');
const gemini = require('../scripts/providers/gemini');
const zhipu = require('../scripts/providers/zhipu');
const { ProviderError } = require('../scripts/errors');
const { standardizeImageInput } = require('../scripts/image_input_resolver');
const {
    createPngBytes,
    createTempDir,
    fakeResponse,
} = require('./helpers');

test('Gemini sends inline Base64 and falls back between models', async () => {
    const pngBytes = await createPngBytes();
    const calls = [];
    const result = await gemini.describe({
        image: { data: pngBytes, mime: 'image/png', source: 'provider-test' },
        prompt: '描述图片',
        key: 'test-key',
        models: ['model-one', 'model-two'],
        sleepImpl: async () => {},
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url.includes('model-one')) return fakeResponse(404, { error: { message: 'not found' } });
            return fakeResponse(200, { candidates: [{ content: { parts: [{ text: 'Gemini OK' }] } }] });
        },
    });

    assert.equal(result.text, 'Gemini OK');
    assert.equal(result.model, 'model-two');
    assert.equal(calls.length, 2);
    assert.ok(!calls[0].url.includes('test-key'));
    assert.equal(calls[0].options.headers['x-goog-api-key'], 'test-key');
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.contents[0].parts[0].inline_data.data, pngBytes.toString('base64'));
});

test('Gemini distinguishes authentication and retryable failures', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'failure-test' };
    let authCalls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'bad-key',
            models: ['one', 'two'],
            sleepImpl: async () => {},
            fetchImpl: async () => {
                authCalls += 1;
                return fakeResponse(400, { error: { status: 'API_KEY_INVALID' } });
            },
        }),
        (error) => error instanceof ProviderError && error.auth,
    );
    assert.equal(authCalls, 1);

    let retryCalls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'test-key',
            models: ['one', 'two'],
            sleepImpl: async () => {},
            fetchImpl: async () => {
                retryCalls += 1;
                return fakeResponse(503, { error: { message: 'unavailable' } });
            },
        }),
        (error) => error instanceof ProviderError && error.retryable,
    );
    assert.equal(retryCalls, 3);
});

test('Gemini immediately falls back after a model-scoped quota limit', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'quota-test' };
    const calls = [];
    const delays = [];
    const result = await gemini.describe({
        image,
        prompt: '描述图片',
        key: 'test-key',
        models: ['gemini-3.7-flash', 'gemini-3.6-flash'],
        sleepImpl: async (delay) => delays.push(delay),
        fetchImpl: async (url) => {
            calls.push(url);
            if (url.includes('gemini-3.7-flash')) {
                return fakeResponse(429, {
                    error: {
                        code: 429,
                        message: 'Quota exceeded for model gemini-3.7-flash. Please retry in 51s.',
                        status: 'RESOURCE_EXHAUSTED',
                        details: [
                            {
                                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                                violations: [{
                                    quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                                    quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                                    quotaDimensions: { location: 'global', model: 'gemini-3.7-flash' },
                                }],
                            },
                            {
                                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                                retryDelay: '51s',
                            },
                        ],
                    },
                });
            }
            return fakeResponse(200, {
                candidates: [{ content: { parts: [{ text: 'Fallback OK' }] } }],
            });
        },
    });

    assert.equal(result.text, 'Fallback OK');
    assert.equal(result.model, 'gemini-3.6-flash');
    assert.deepEqual(calls.map((url) => url.includes('gemini-3.7-flash') ? '3.7' : '3.6'), ['3.7', '3.6']);
    assert.deepEqual(delays, []);
});

test('Gemini keeps Provider-scoped rate limits on the retry path', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'provider-quota-test' };
    const delays = [];
    let calls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'test-key',
            models: ['model-one', 'model-two'],
            sleepImpl: async (delay) => delays.push(delay),
            fetchImpl: async () => {
                calls += 1;
                return fakeResponse(429, {
                    error: {
                        code: 429,
                        message: 'Project quota exceeded.',
                        status: 'RESOURCE_EXHAUSTED',
                    },
                });
            },
        }),
        (error) => error instanceof ProviderError
            && error.retryable
            && error.quotaScope === 'provider',
    );

    assert.equal(calls, 3);
    assert.deepEqual(delays, [2000, 4000]);
});

test('Gemini immediately exits the Provider when RetryInfo requires a long wait', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'provider-retry-info-test' };
    const delays = [];
    let calls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'test-key',
            models: ['model-one', 'model-two'],
            sleepImpl: async (delay) => delays.push(delay),
            fetchImpl: async () => {
                calls += 1;
                return fakeResponse(429, {
                    error: {
                        code: 429,
                        message: 'Project quota exceeded. Please retry in 51s.',
                        status: 'RESOURCE_EXHAUSTED',
                        details: [
                            {
                                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                                violations: [{
                                    quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests',
                                    quotaId: 'GenerateRequestsPerProject',
                                    quotaDimensions: { location: 'global' },
                                }],
                            },
                            {
                                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                                retryDelay: '51s',
                            },
                        ],
                    },
                });
            },
        }),
        (error) => error instanceof ProviderError
            && error.code === 'PROVIDER_RATE_LIMIT'
            && error.quotaScope === 'provider'
            && error.retryAfterMs === 51000,
    );

    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
});

test('Zhipu sends bare Base64, falls back, and stops on HTTP 400', async () => {
    const pngBytes = await createPngBytes();
    const payloads = [];
    const result = await zhipu.describe({
        image: { data: pngBytes, mime: 'image/png', source: 'zhipu-test' },
        prompt: '描述图片',
        key: 'test-key',
        models: ['unavailable-model', 'glm-4.1v-thinking-flash'],
        fetchImpl: async (_url, options) => {
            const payload = JSON.parse(options.body);
            payloads.push(payload);
            if (payload.model === 'unavailable-model') return fakeResponse(404, { error: { message: 'not found' } });
            return fakeResponse(200, { choices: [{ message: { content: 'Zhipu OK' } }] });
        },
    });

    assert.equal(result.text, 'Zhipu OK');
    assert.deepEqual(payloads.map((payload) => payload.model), ['unavailable-model', 'glm-4.1v-thinking-flash']);
    assert.equal(payloads[1].messages[0].content[0].image_url.url, pngBytes.toString('base64'));

    let badRequestCalls = 0;
    await assert.rejects(
        () => zhipu.describe({
            image: { data: pngBytes, mime: 'image/png', source: 'zhipu-400-test' },
            prompt: '描述图片',
            key: 'test-key',
            models: [...zhipu.DEFAULT_MODELS],
            fetchImpl: async () => {
                badRequestCalls += 1;
                return fakeResponse(400, { error: { message: 'bad request' } });
            },
        }),
        (error) => error instanceof ProviderError && error.status === 400,
    );
    assert.equal(badRequestCalls, 1);
});

test('local image flows through the gateway, compression, and Zhipu payload', async (t) => {
    const width = 1600;
    const height = 1200;
    const pixels = Buffer.alloc(width * height * 3, 255);
    for (let y = 20; y < height; y += 50) {
        pixels.fill(25, (y * width + 60) * 3, (y * width + width - 60) * 3);
    }
    const input = await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png({ compressionLevel: 0 })
        .toBuffer();
    assert.ok(input.length >= zhipu.IMAGE_PROFILE.maxBytes);

    const tempDir = createTempDir(t);
    const imagePath = path.join(tempDir, 'oversized-screenshot.png');
    fs.writeFileSync(imagePath, input);
    const standardized = await standardizeImageInput(imagePath);
    let uploaded;
    const result = await zhipu.describe({
        image: standardized,
        prompt: '提取截图文字',
        key: 'test-key',
        models: ['glm-4.1v-thinking-flash'],
        fetchImpl: async (_url, options) => {
            const payload = JSON.parse(options.body);
            uploaded = Buffer.from(payload.messages[0].content[0].image_url.url, 'base64');
            return fakeResponse(200, { choices: [{ message: { content: '端到端成功' } }] });
        },
    });

    const metadata = await sharp(uploaded).metadata();
    assert.equal(result.text, '端到端成功');
    assert.ok(uploaded.length < zhipu.IMAGE_PROFILE.maxBytes);
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
});
