const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CliError,
  ProviderError,
  formatCliError,
  providerFailureScope,
  singleLine,
} = require('../scripts/errors');

test('formatCliError preserves CLI error codes and flattens messages', () => {
  const error = new CliError('IMAGE_INPUT', 'bad\n image', 3);

  assert.equal(formatCliError(error), '[ERROR] IMAGE_INPUT: bad image');
  assert.equal(error.exitCode, 3);
  assert.equal(singleLine(' a\n b '), 'a b');
});

test('providerFailureScope classifies explicit and semantic scopes', () => {
  assert.equal(providerFailureScope(new ProviderError('x', 'HTTP', 'x', { scope: 'model' })), 'model');
  assert.equal(providerFailureScope(new ProviderError('x', 'AUTH', 'x', { auth: true })), 'provider');
  assert.equal(providerFailureScope(new ProviderError('x', 'RATE', 'x', { quotaScope: 'model' })), 'model');
  assert.equal(providerFailureScope(new ProviderError('x', 'RATE', 'x', { quotaScope: 'provider' })), 'provider');
  assert.equal(providerFailureScope(new ProviderError('x', 'HTTP', 'x', { status: 400 })), 'provider');
  assert.equal(providerFailureScope(new ProviderError('x', 'INVALID_RESPONSE', 'x')), 'model');
});
