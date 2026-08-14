const assert = require('assert');
const test = require('node:test');
const gemini = require('../scripts/providers/gemini');
const zhipu = require('../scripts/providers/zhipu');
const { CliError, ProviderError } = require('../scripts/errors');
const { providerForBareCredential } = require('../scripts/key_store');
const {
    DEFAULT_MODEL,
    describeWithProviders,
    imageToBase64,
    keyGuidance,
    resolveRouting,
} = require('../scripts/describe_image');
const { createPngBytes } = require('./helpers');

test('resolves explicit and default routing intent', () => {
    const geminiModels = [...gemini.DEFAULT_MODELS];
    const zhipuModels = [...zhipu.DEFAULT_MODELS];
    assert.equal(DEFAULT_MODEL, 'glm-4.1v-thinking-flash');
    assert.deepEqual(resolveRouting('分析图片', 'auto', geminiModels, zhipuModels).providerOrder, ['zhipu', 'gemini']);
    assert.deepEqual(
        resolveRouting('使用glm-4.6v-flash分析图片', 'auto', geminiModels, zhipuModels).zhipuModels,
        ['glm-4.6v-flash', 'glm-4.1v-thinking-flash'],
    );
    assert.deepEqual(
        resolveRouting('使用gemini/google模型分析图片', 'auto', geminiModels, zhipuModels).providerOrder,
        ['gemini', 'zhipu'],
    );
    assert.equal(
        resolveRouting('使用gemini-3.6-flash分析图片', 'auto', geminiModels, zhipuModels).geminiModels[0],
        'gemini-3.6-flash',
    );
    assert.deepEqual(
        resolveRouting('请使用 Gemini，不要使用 glm-4.1v-thinking-flash', 'auto', geminiModels, zhipuModels).providerOrder,
        ['gemini', 'zhipu'],
    );
    assert.deepEqual(
        resolveRouting('不要使用 gemini-3.7-flash，改用 GLM', 'auto', geminiModels, zhipuModels).providerOrder,
        ['zhipu', 'gemini'],
    );
    assert.deepEqual(
        resolveRouting('请勿使用 Gemini，改用智谱', 'auto', geminiModels, zhipuModels).providerOrder,
        ['zhipu', 'gemini'],
    );
    assert.deepEqual(
        resolveRouting('请勿使用 glm-4.1v-thinking-flash，改用 gemini', 'auto', geminiModels, zhipuModels).providerOrder,
        ['gemini', 'zhipu'],
    );
    assert.equal(providerForBareCredential('auto'), 'zhipu');
    assert.equal(providerForBareCredential('gemini'), 'gemini');
});

test('falls back across Providers and skips missing credentials', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'routing-test' };
    const calls = [];
    const result = await describeWithProviders({
        image,
        prompt: '描述图片',
        mode: 'gemini',
        credentials: {
            gemini: { key: 'gemini-key', source: 'env' },
            zhipu: { key: 'zhipu-key', source: 'env' },
        },
        adapters: {
            gemini: { describe: async () => {
                calls.push('gemini');
                throw new ProviderError('gemini', 'MODELS_FAILED', 'all failed');
            } },
            zhipu: { describe: async () => {
                calls.push('zhipu');
                return { text: 'Fallback OK', model: 'zhipu-model', provider: 'zhipu' };
            } },
        },
    });
    assert.deepEqual(calls, ['gemini', 'zhipu']);
    assert.equal(result.provider, 'zhipu');

    const singleKeyCalls = [];
    const singleKeyResult = await describeWithProviders({
        image,
        prompt: '描述图片',
        mode: 'auto',
        credentials: { gemini: { key: 'gemini-key', source: 'env' }, zhipu: { key: '' } },
        adapters: {
            zhipu: { describe: async () => singleKeyCalls.push('zhipu') },
            gemini: { describe: async () => {
                singleKeyCalls.push('gemini');
                return { text: 'Only Gemini', model: 'gemini-model', provider: 'gemini' };
            } },
        },
    });
    assert.deepEqual(singleKeyCalls, ['gemini']);
    assert.equal(singleKeyResult.provider, 'gemini');
});

test('reports actionable key guidance without writing to stdout', async () => {
    const pngBytes = await createPngBytes();
    assert.equal(imageToBase64({ data: pngBytes }), pngBytes.toString('base64'));
    assert.match(keyGuidance(['zhipu']), /ZHIPU_API_KEY=<key>/);

    await assert.rejects(
        () => describeWithProviders({
            image: { data: pngBytes, mime: 'image/png', source: 'missing-key-test' },
            prompt: '描述图片',
            mode: 'auto',
            credentials: { gemini: { key: '' }, zhipu: { key: '' } },
        }),
        (error) => error instanceof CliError
            && error.code === 'KEY_REQUIRED'
            && error.exitCode === 2
            && error.message.includes('setx ZHIPU_API_KEY')
            && error.message.includes('setx GEMINI_API_KEY'),
    );
});
