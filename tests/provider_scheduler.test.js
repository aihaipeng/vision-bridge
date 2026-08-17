const assert = require('node:assert/strict');
const test = require('node:test');
const { ProviderError } = require('../scripts/errors');
const { ProviderScheduler, providerLevelFailure } = require('../scripts/workflow/provider_scheduler');
const { ProviderLeaseManager } = require('../scripts/workflow/provider_lease');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('ProviderScheduler limits each Provider independently', async () => {
  const scheduler = new ProviderScheduler({ defaultLimit: 1 });
  const active = new Map();
  const peaks = new Map();
  const task = (provider) => scheduler.run(provider, async () => {
    active.set(provider, (active.get(provider) || 0) + 1);
    peaks.set(provider, Math.max(peaks.get(provider) || 0, active.get(provider)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.set(provider, active.get(provider) - 1);
    return provider;
  });

  const results = await Promise.all([task('zhipu'), task('zhipu'), task('gemini'), task('gemini')]);

  assert.deepEqual(results, ['zhipu', 'zhipu', 'gemini', 'gemini']);
  assert.equal(peaks.get('zhipu'), 1);
  assert.equal(peaks.get('gemini'), 1);
});

test('ProviderScheduler skips queued calls after a Provider-level failure', async () => {
  const scheduler = new ProviderScheduler({ defaultLimit: 1 });
  let calls = 0;
  const failing = scheduler.run('zhipu', async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new ProviderError('zhipu', 'PROVIDER_UNAVAILABLE', 'rate limited', { scope: 'provider' });
  });
  const queued = scheduler.run('zhipu', async () => { calls += 1; return 'unexpected'; });

  const results = await Promise.allSettled([failing, queued]);

  assert.equal(calls, 1);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'BATCH_PROVIDER_SKIPPED');
});

test('model-only failures do not block the Provider', () => {
  assert.equal(providerLevelFailure(new ProviderError('zhipu', 'MODEL_NOT_FOUND', 'missing', { scope: 'model' })), false);
});

test('ProviderScheduler removes an aborted waiter without running it', async () => {
  const scheduler = new ProviderScheduler({ defaultLimit: 1 });
  let releaseFirst;
  const first = scheduler.run('zhipu', () => new Promise((resolve) => { releaseFirst = resolve; }));
  const controller = new AbortController();
  let queuedCalls = 0;
  const queued = scheduler.run('zhipu', async () => { queuedCalls += 1; }, { signal: controller.signal });

  controller.abort(new Error('stop'));
  await assert.rejects(queued, (error) => error.code === 'BATCH_CANCELLED');
  assert.equal(queuedCalls, 0);
  releaseFirst('done');
  assert.equal(await first, 'done');
});

test('ProviderScheduler composes in-process limits with a shared cross-process lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-scheduler-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new ProviderScheduler({
    defaultLimit: 1,
    leaseManager: new ProviderLeaseManager({ tempRoot: root, pollMs: 2 }),
  });
  const second = new ProviderScheduler({
    defaultLimit: 1,
    leaseManager: new ProviderLeaseManager({ tempRoot: root, pollMs: 2 }),
  });
  let active = 0;
  let peak = 0;
  const run = (scheduler) => scheduler.run('zhipu', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  await Promise.all([run(first), run(second)]);
  assert.equal(peak, 1);
});
