const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROVIDER_EXTRA_KEYS,
  PROVIDER_KEYS,
  readEnvironmentValue,
  resolveCredential,
} = require('../scripts/key_store');

test('Provider credentials use only the vision-bridge namespace', () => {
  assert.deepEqual(PROVIDER_KEYS, {
    gemini: 'VISION_BRIDGE_GEMINI_API_KEY',
    zhipu: 'VISION_BRIDGE_ZHIPU_API_KEY',
    mistral: 'VISION_BRIDGE_MISTRAL_API_KEY',
    nvidia: 'VISION_BRIDGE_NVIDIA_API_KEY',
    cloudflare: 'VISION_BRIDGE_CLOUDFLARE_API_TOKEN',
  });
  assert.deepEqual(PROVIDER_EXTRA_KEYS, {
    cloudflare: 'VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID',
  });
});

test('user-scoped namespaced credentials take precedence over process values', () => {
  const result = readEnvironmentValue('VISION_BRIDGE_GEMINI_API_KEY', {
    env: { VISION_BRIDGE_GEMINI_API_KEY: 'process-placeholder' },
    readUserEnvironmentKey: () => 'user-placeholder',
  });

  assert.equal(result.source, 'user-env');
  assert.equal(result.value, 'user-placeholder');
});

test('namespaced process credentials are available when no user value exists', () => {
  const result = readEnvironmentValue('VISION_BRIDGE_NVIDIA_API_KEY', {
    env: { VISION_BRIDGE_NVIDIA_API_KEY: 'process-placeholder' },
    readUserEnvironmentKey: () => '',
  });

  assert.equal(result.source, 'env');
  assert.equal(result.value, 'process-placeholder');
});

test('legacy Provider variables are ignored', () => {
  const result = resolveCredential('gemini', {
    env: { GEMINI_API_KEY: 'legacy-placeholder' },
    readUserEnvironmentKey: () => '',
  });

  assert.equal(result.source, 'missing');
  assert.equal(result.key, '');
});

test('Cloudflare requires both namespaced credential values', () => {
  const result = resolveCredential('cloudflare', {
    env: {
      VISION_BRIDGE_CLOUDFLARE_API_TOKEN: 'token-placeholder',
      VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID: 'account-placeholder',
    },
    readUserEnvironmentKey: () => '',
  });

  assert.equal(result.key, 'token-placeholder');
  assert.equal(result.extra.value, 'account-placeholder');
  assert.equal(result.extra.envName, 'VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID');
});
