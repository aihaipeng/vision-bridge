const assert = require('node:assert/strict');
const test = require('node:test');
const { CliError } = require('../scripts/errors');
const { runBatchPreflight } = require('../scripts/workflow/preflight');

test('runBatchPreflight returns a credential-free diagnostic summary', async () => {
  const credentials = { zhipu: { key: 'secret' } };
  const result = await runBatchPreflight({
    credentials,
    dependencyCheck: () => [],
    avifCheck: async () => ({ supported: true }),
  });

  assert.equal(result.credentials, credentials);
  assert.deepEqual(result.diagnostics.configuredProviders, ['zhipu']);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /secret/);
});

test('runBatchPreflight blocks when AVIF is unavailable', async () => {
  await assert.rejects(runBatchPreflight({
    credentials: { zhipu: { key: 'configured' } },
    dependencyCheck: () => [],
    avifCheck: async () => ({ supported: false, message: 'decoder missing' }),
  }), (error) => error instanceof CliError && error.code === 'AVIF_UNAVAILABLE');
});
