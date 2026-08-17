const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COOLDOWN_BASE_MS,
  PROVIDER_SENTINEL,
  cooldownDuration,
  orderModels,
  orderProviders,
  recordFailure,
  recordProviderFailure,
  recordSuccess,
} = require('../scripts/model_health');

test('cooldownDuration escalates exponentially and honors retry hints', () => {
  assert.equal(cooldownDuration(1), COOLDOWN_BASE_MS);
  assert.equal(cooldownDuration(3), COOLDOWN_BASE_MS * 4);
  assert.equal(cooldownDuration(1, COOLDOWN_BASE_MS * 3), COOLDOWN_BASE_MS * 3);
});

test('authentication failures do not enter health cooldown', () => {
  const state = {};

  assert.equal(recordFailure(state, 'zhipu', 'model-a', { code: 'AUTH' }, 1000), null);
  assert.deepEqual(state, {});
});

test('cooling models and providers move behind healthy entries', () => {
  const now = 10_000;
  const state = {};
  recordFailure(state, 'zhipu', 'fast', { code: 'HTTP' }, now);
  recordProviderFailure(state, 'zhipu', { code: 'NETWORK' }, now);

  assert.deepEqual(orderModels(['fast', 'slow'], 'zhipu', state, now), ['slow', 'fast']);
  assert.deepEqual(orderProviders(['zhipu', 'gemini'], state, now), ['gemini', 'zhipu']);
  assert.ok(state[`zhipu/${PROVIDER_SENTINEL}`]);
});

test('success resets model failures and clears provider cooldown', () => {
  const state = {};
  recordFailure(state, 'zhipu', 'model-a', { code: 'HTTP' }, 1000);
  recordProviderFailure(state, 'zhipu', { code: 'NETWORK' }, 1000);

  recordSuccess(state, 'zhipu', 'model-a', 2000);

  assert.equal(state['zhipu/model-a'].failures, 0);
  assert.equal(state['zhipu/model-a'].lastSuccess, 2000);
  assert.equal(state[`zhipu/${PROVIDER_SENTINEL}`], undefined);
});
