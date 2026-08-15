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

test('Gemini circuit-breaks Provider-scoped failures without retrying', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'failure-test' };
    let authCalls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'bad-key',
            models: ['one', 'two'],
            fetchImpl: async () => {
                authCalls += 1;
                return fakeResponse(400, { error: { status: 'API_KEY_INVALID' } });
            },
        }),
        (error) => error instanceof ProviderError
            && error.code === 'PROVIDER_UNAVAILABLE'
            && error.failures[0].auth,
    );
    assert.equal(authCalls, 1);

    let retryCalls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'test-key',
            models: ['one', 'two'],
            fetchImpl: async () => {
                retryCalls += 1;
                return fakeResponse(503, { error: { message: 'unavailable' } });
            },
        }),
        (error) => error instanceof ProviderError
            && error.code === 'PROVIDER_UNAVAILABLE'
            && error.failures[0].code === 'HTTP',
    );
    assert.equal(retryCalls, 1);
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
        onStatus: (event) => delays.push(event),
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
    assert.equal(delays.length, 1);
    assert.equal(delays[0].type, 'model_switch');
    assert.equal(delays[0].next, 'gemini/gemini-3.6-flash');
});

test('Gemini circuit-breaks Provider-scoped rate limits without waiting', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'provider-quota-test' };
    const events = [];
    let calls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'test-key',
            models: ['model-one', 'model-two'],
            onStatus: (event) => events.push(event),
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
            && error.code === 'PROVIDER_UNAVAILABLE'
            && error.failures[0].status === 429,
    );

    assert.equal(calls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'provider_failed');
});

test('Gemini immediately exits the Provider when RetryInfo requires a long wait', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'provider-retry-info-test' };
    const events = [];
    let calls = 0;
    await assert.rejects(
        () => gemini.describe({
            image,
            prompt: '描述图片',
            key: 'test-key',
            models: ['model-one', 'model-two'],
            onStatus: (event) => events.push(event),
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
            && error.code === 'PROVIDER_UNAVAILABLE'
            && error.failures[0].quotaScope === 'provider',
    );

    assert.equal(calls, 1);
    assert.equal(events.length, 1);
});

test('Gemini treats model-specific 503 high demand as a model switch', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'model-demand-test' };
    const calls = [];
    const events = [];
    const result = await gemini.describe({
        image,
        prompt: '描述图片',
        key: 'test-key',
        models: ['busy-model', 'ready-model'],
        onStatus: (event) => events.push(event),
        fetchImpl: async (url) => {
            calls.push(url);
            if (url.includes('busy-model')) {
                return fakeResponse(503, { error: { message: 'This model is currently experiencing high demand.' } });
            }
            return fakeResponse(200, { candidates: [{ content: { parts: [{ text: 'Ready' }] } }] });
        },
    });
    assert.equal(result.model, 'ready-model');
    assert.equal(calls.length, 2);
    assert.equal(events[0].type, 'model_switch');
    assert.equal(events[0].code, 'MODEL_UNAVAILABLE');
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
    const events = [];
    await assert.rejects(
        () => zhipu.describe({
            image: { data: pngBytes, mime: 'image/png', source: 'zhipu-400-test' },
            prompt: '描述图片',
            key: 'test-key',
            models: [...zhipu.DEFAULT_MODELS],
            fallbackTarget: 'gemini/gemini-one',
            onStatus: (event) => events.push(event),
            fetchImpl: async () => {
                badRequestCalls += 1;
                return fakeResponse(400, { error: { message: 'bad request' } });
            },
        }),
        (error) => error instanceof ProviderError
            && error.code === 'PROVIDER_UNAVAILABLE'
            && error.failures[0].status === 400,
    );
    assert.equal(badRequestCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'provider_switch');
    assert.equal(events[0].next, 'gemini/gemini-one');
});

test('Zhipu treats a model-not-found 400 as a model switch', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'zhipu-model-missing-test' };
    const calls = [];
    const events = [];
    const result = await zhipu.describe({
        image,
        prompt: '描述图片',
        key: 'test-key',
        models: ['missing-model', 'ready-model'],
        onStatus: (event) => events.push(event),
        fetchImpl: async (_url, options) => {
            const model = JSON.parse(options.body).model;
            calls.push(model);
            if (model === 'missing-model') return fakeResponse(400, { error: { code: '1214', message: 'modelCode：不存在' } });
            return fakeResponse(200, { choices: [{ message: { content: 'Ready' } }] });
        },
    });
    assert.equal(result.model, 'ready-model');
    assert.deepEqual(calls, ['missing-model', 'ready-model']);
    assert.equal(events[0].type, 'model_switch');
    assert.equal(events[0].code, 'MODEL_NOT_FOUND');
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
