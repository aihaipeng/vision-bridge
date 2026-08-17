const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CliError, ProviderError } = require('../scripts/errors');
const {
  cleanupRetryCaches,
  describeWithProviders,
  formatStatusEvent,
  formatSuccessfulOutput,
  keyRequiredError,
  providerOrder,
  writeStatusEvent,
} = require('../scripts/describe_image');

function healthStore() {
  return { state: {}, persistCalls: 0, persist() { this.persistCalls += 1; } };
}

test('successful output contains only cleaned recognition text', () => {
  assert.deepEqual(providerOrder(), ['zhipu', 'nvidia', 'gemini', 'mistral', 'cloudflare']);
  assert.equal(
    formatSuccessfulOutput({ text: '<|begin_of_box|>ok<|end_of_box|>', provider: 'zhipu', model: 'glm' }),
    'ok',
  );
});

test('Provider availability is hidden by default and visible in verbose mode', () => {
  const writes = [];
  const stream = { write: (value) => writes.push(value) };
  const event = { type: 'provider_available', provider: 'zhipu', models: ['glm'] };

  writeStatusEvent(event, stream, {});
  assert.deepEqual(writes, []);
  writeStatusEvent(event, stream, { VISION_BRIDGE_VERBOSE: '1' });
  assert.deepEqual(writes, ['[INFO] provider loaded: zhipu\n']);
  assert.doesNotMatch(writes[0], /glm|模型/);
});

test('status events preserve switch and cooldown protocols', () => {
  assert.match(formatStatusEvent({
    type: 'model_switch', provider: 'zhipu', model: 'a', code: 'HTTP', message: 'failed', next: 'zhipu/b',
  }), /^\[WARN\] MODEL_SWITCH:/);
  assert.match(formatStatusEvent({
    type: 'provider_cooldown', provider: 'zhipu', remainingMs: 1200, lastError: 'provider/NETWORK',
  }), /^\[INFO\] PROVIDER_COOLDOWN:/);
});

test('keyRequiredError retains exit code and local configuration guidance', () => {
  const error = keyRequiredError(['zhipu']);

  assert.equal(error.code, 'KEY_REQUIRED');
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /VISION_BRIDGE_ZHIPU_API_KEY/);
  assert.match(error.message, /Do not send Keys in chat/);
});

test('describeWithProviders switches providers and records success', async () => {
  const calls = [];
  const events = [];
  const health = healthStore();
  const credentials = {
    zhipu: { key: 'z' },
    nvidia: { key: 'n' },
  };
  const adapters = {
    zhipu: {
      DEFAULT_MODELS: ['z-model'],
      async describe() {
        calls.push('zhipu');
        throw new ProviderError('zhipu', 'PROVIDER_UNAVAILABLE', 'network', {
          failures: [{ provider: 'zhipu', model: 'z-model', code: 'NETWORK', scope: 'provider', message: 'network' }],
        });
      },
    },
    nvidia: {
      DEFAULT_MODELS: ['n-model'],
      async describe() {
        calls.push('nvidia');
        return { text: 'ok', provider: 'nvidia', model: 'n-model' };
      },
    },
  };

  const result = await describeWithProviders({
    image: { data: Buffer.from('x'), mime: 'image/png' },
    prompt: 'describe', credentials, adapters, healthStore: health, onStatus: (event) => events.push(event),
  });

  assert.deepEqual(calls, ['zhipu', 'nvidia']);
  assert.equal(result.text, 'ok');
  assert.equal(result.provider, 'nvidia');
  assert.ok(events.some(({ type, provider }) => type === 'provider_skipped' && provider === 'gemini'));
  assert.equal(health.state['nvidia/n-model'].failures, 0);
  assert.ok(health.persistCalls >= 2);
});

test('describeWithProviders rejects a completely unconfigured pool', async () => {
  await assert.rejects(
    describeWithProviders({ image: {}, prompt: 'x', credentials: {}, healthStore: healthStore() }),
    (error) => error instanceof CliError && error.code === 'KEY_REQUIRED' && error.exitCode === 2,
  );
});

test('describeWithProviders aggregates network-only terminal failures', async () => {
  const adapter = {
    DEFAULT_MODELS: ['model-a'],
    async describe() {
      throw new ProviderError('zhipu', 'MODELS_FAILED', 'network', {
        failures: [{ provider: 'zhipu', model: 'model-a', code: 'NETWORK', scope: 'provider', message: 'network' }],
      });
    },
  };

  await assert.rejects(
    describeWithProviders({
      image: {}, prompt: 'x', credentials: { zhipu: { key: 'z' } },
      adapters: { zhipu: adapter }, healthStore: healthStore(),
    }),
    (error) => error instanceof CliError && error.code === 'NETWORK_UNAVAILABLE',
  );
});

test('cleanupRetryCaches removes only expired files with the requested prefix', (t) => {
  const prefix = `vision_bridge_test_${process.pid}_`;
  const expired = path.join(os.tmpdir(), `${prefix}expired.png`);
  const fresh = path.join(os.tmpdir(), `${prefix}fresh.png`);
  fs.writeFileSync(expired, 'old');
  fs.writeFileSync(fresh, 'new');
  fs.utimesSync(expired, new Date(0), new Date(0));
  t.after(() => {
    fs.rmSync(expired, { force: true });
    fs.rmSync(fresh, { force: true });
  });

  const removed = cleanupRetryCaches(Date.now(), 60_000, prefix);

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(fresh), true);
});
