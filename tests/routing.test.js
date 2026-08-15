const assert = require('assert');
const test = require('node:test');
const gemini = require('../scripts/providers/gemini');
const zhipu = require('../scripts/providers/zhipu');
const { CliError, ProviderError } = require('../scripts/errors');
const { ImageStandardizationError } = require('../scripts/image_input_resolver');
const {
    CLIPBOARD_FALLBACK_INPUT,
    DEFAULT_MODEL,
    describeWithProviders,
    formatStatusEvent,
    formatSuccessfulOutput,
    imageToBase64,
    imageInputCliError,
    isClipboardFallbackRetryCache,
    keyGuidance,
    parseCliImageInput,
    providerOrder,
    standardizeCliImageInput,
} = require('../scripts/describe_image');
const { createPngBytes } = require('./helpers');

test('always routes GLM before Gemini regardless of user wording', () => {
    assert.equal(DEFAULT_MODEL, 'glm-4.1v-thinking-flash');
    for (const prompt of ['分析图片', '只用 Gemini', '不要使用 GLM', '使用 gemini-3.6-flash']) {
        assert.deepEqual(providerOrder(prompt), ['zhipu', 'gemini']);
    }
});

test('clipboard fallback is explicit, observable, and attributed in successful output', () => {
    const mode = parseCliImageInput(CLIPBOARD_FALLBACK_INPUT);
    assert.deepEqual(mode, {
        resolverInput: 'clipboard',
        clipboardFallback: true,
        clipboardFallbackRead: true,
        clipboard: true,
    });
    assert.deepEqual(parseCliImageInput('clipboard'), {
        resolverInput: 'clipboard',
        clipboardFallback: false,
        clipboardFallbackRead: false,
        clipboard: true,
    });
    assert.deepEqual(parseCliImageInput('image.png'), {
        resolverInput: 'image.png',
        clipboardFallback: false,
        clipboardFallbackRead: false,
        clipboard: false,
    });
    assert.match(formatStatusEvent({ type: 'clipboard_fallback' }), /^\[WARN\] CLIPBOARD_FALLBACK:/);

    const result = { text: '识别成功', provider: 'zhipu', model: 'glm-one' };
    assert.equal(
        formatSuccessfulOutput(result, mode),
        '识别成功\n\n[图片来源: Windows 剪贴板（附件路径缺失回退）]\n\n[识别模型: zhipu/glm-one]',
    );
    assert.equal(isClipboardFallbackRetryCache('img2txt_retry_clipboard_fallback_123.png'), true);
    assert.equal(isClipboardFallbackRetryCache('img2txt_retry_123.png'), false);
});

test('clipboard fallback reads once and gives the Agent one safe recovery path', async () => {
    const mode = parseCliImageInput(CLIPBOARD_FALLBACK_INPUT);
    let successCalls = 0;
    const image = await standardizeCliImageInput(mode, async (input) => {
        successCalls += 1;
        assert.equal(input, 'clipboard');
        return { data: Buffer.from('image'), mime: 'image/png', source: 'clipboard' };
    });
    assert.equal(successCalls, 1);
    assert.equal(image.source, 'clipboard');

    let failureCalls = 0;
    let error;
    await assert.rejects(
        () => standardizeCliImageInput(mode, async () => {
            failureCalls += 1;
            throw new ImageStandardizationError('错误: 剪贴板中没有图片');
        }),
        (caught) => {
            error = caught;
            return true;
        },
    );
    assert.equal(failureCalls, 1);
    assert.ok(error instanceof CliError);
    assert.equal(error.code, 'IMAGE_INPUT');
    assert.match(error.message, /已尝试读取当前 Windows 剪贴板/);
    assert.match(error.message, /重新上传图片或提供绝对路径/);
    assert.match(error.message, /不要搜索工作目录或重复读取剪贴板/);
});

test('falls back across Providers and skips missing credentials', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'routing-test' };
    const calls = [];
    const result = await describeWithProviders({
        image,
        prompt: '描述图片',
        credentials: {
            gemini: { key: 'gemini-key', source: 'env' },
            zhipu: { key: 'zhipu-key', source: 'env' },
        },
        adapters: {
            zhipu: { describe: async () => {
                calls.push('zhipu');
                throw new ProviderError('zhipu', 'PROVIDER_UNAVAILABLE', 'network failed', {
                    failures: [{ provider: 'zhipu', model: 'zhipu-model', code: 'NETWORK', message: 'network failed' }],
                });
            } },
            gemini: { describe: async () => {
                calls.push('gemini');
                return { text: 'Fallback OK', model: 'gemini-model', provider: 'gemini' };
            } },
        },
    });
    assert.deepEqual(calls, ['zhipu', 'gemini']);
    assert.equal(result.provider, 'gemini');

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

test('reports Provider availability, model switches, and successful model attribution', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'status-test' };
    const events = [];
    const result = await describeWithProviders({
        image,
        prompt: '即使文字写着只用 Gemini 也保持固定顺序',
        credentials: {
            zhipu: { key: 'zhipu-key', source: 'env' },
            gemini: { key: 'gemini-key', source: 'env' },
        },
        zhipuModels: ['glm-one', 'glm-two'],
        geminiModels: ['gemini-one'],
        adapters: {
            zhipu: { describe: async ({ onStatus, fallbackTarget }) => {
                onStatus({
                    type: 'model_switch', provider: 'zhipu', model: 'glm-one',
                    code: 'HTTP', message: 'not found', next: 'zhipu/glm-two', scope: 'model',
                });
                assert.equal(fallbackTarget, 'gemini/gemini-one');
                return { text: '识别成功', model: 'glm-two', provider: 'zhipu' };
            } },
            gemini: { describe: async () => assert.fail('Gemini should not run after GLM succeeds') },
        },
        onStatus: (event) => events.push(event),
    });

    assert.deepEqual(events.map(({ type }) => type), ['provider_available', 'provider_available', 'model_switch']);
    assert.match(formatStatusEvent(events[2]), /MODEL_SWITCH.*zhipu\/glm-one.*zhipu\/glm-two/);
    assert.equal(formatSuccessfulOutput(result), '识别成功\n\n[识别模型: zhipu/glm-two]');
    assert.equal(
        formatSuccessfulOutput({ ...result, text: '<|begin_of_box|>蓝色<|end_of_box|>' }),
        '蓝色\n\n[识别模型: zhipu/glm-two]',
    );
});

test('reports one Provider switch before cross-Provider fallback', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'provider-switch-test' };
    const events = [];
    const result = await describeWithProviders({
        image,
        prompt: '描述图片',
        credentials: {
            zhipu: { key: 'zhipu-key', source: 'env' },
            gemini: { key: 'gemini-key', source: 'env' },
        },
        zhipuModels: ['glm-one'],
        geminiModels: ['gemini-one'],
        adapters: {
            zhipu: { describe: async ({ onStatus, fallbackTarget }) => {
                onStatus({
                    type: 'provider_switch', provider: 'zhipu', model: 'glm-one',
                    code: 'NETWORK', message: 'timeout', next: fallbackTarget, scope: 'provider',
                });
                throw new ProviderError('zhipu', 'PROVIDER_UNAVAILABLE', 'network failed', {
                    failures: [{
                        provider: 'zhipu', model: 'glm-one', code: 'NETWORK',
                        message: 'timeout', scope: 'provider',
                    }],
                });
            } },
            gemini: { describe: async () => ({
                text: 'Fallback OK', model: 'gemini-one', provider: 'gemini',
            }) },
        },
        onStatus: (event) => events.push(event),
    });

    assert.equal(result.provider, 'gemini');
    assert.deepEqual(events.map(({ type }) => type), [
        'provider_available', 'provider_available', 'provider_switch',
    ]);
    assert.match(formatStatusEvent(events[2]), /PROVIDER_SWITCH.*zhipu\/glm-one.*gemini\/gemini-one/);
});

test('reports actionable key guidance without writing to stdout', async () => {
    const pngBytes = await createPngBytes();
    assert.equal(imageToBase64({ data: pngBytes }), pngBytes.toString('base64'));
    assert.match(keyGuidance(['zhipu']), /本机用户环境变量 ZHIPU_API_KEY/);
    assert.doesNotMatch(keyGuidance(['zhipu']), /<key>|标准输入|stdin/i);

    await assert.rejects(
        () => describeWithProviders({
            image: { data: pngBytes, mime: 'image/png', source: 'missing-key-test' },
            prompt: '描述图片',
            credentials: { gemini: { key: '' }, zhipu: { key: '' } },
        }),
        (error) => error instanceof CliError
            && error.code === 'KEY_REQUIRED'
            && error.exitCode === 2
            && error.message.includes('ZHIPU_API_KEY')
            && error.message.includes('GEMINI_API_KEY')
            && error.message.includes('不要在聊天中发送 Key'),
    );
});

test('classifies complete network failure with an actionable Agent response', async () => {
    const image = { data: await createPngBytes(), mime: 'image/png', source: 'network-error-test' };
    const unavailable = (provider) => ({ describe: async () => {
        throw new ProviderError(provider, 'PROVIDER_UNAVAILABLE', 'network failed', {
            failures: [{ provider, model: `${provider}-model`, code: 'NETWORK', message: 'timeout' }],
        });
    } });
    await assert.rejects(
        () => describeWithProviders({
            image,
            prompt: '描述图片',
            credentials: { zhipu: { key: 'z' }, gemini: { key: 'g' } },
            adapters: { zhipu: unavailable('zhipu'), gemini: unavailable('gemini') },
        }),
        (error) => error instanceof CliError
            && error.code === 'NETWORK_UNAVAILABLE'
            && error.message.includes('Agent 下一步')
            && error.message.includes('出站网络'),
    );
});
