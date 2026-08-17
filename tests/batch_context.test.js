const assert = require('node:assert/strict');
const test = require('node:test');
const { createBatchExecutionContext } = require('../scripts/workflow/batch_context');

test('batch context creates batch-scoped resources exactly once', async () => {
  const calls = { preflight: 0, cleanup: 0, transaction: 0, health: 0, scheduler: 0 };
  const transaction = { close() {}, rollback() {} };
  const healthStore = { state: {}, persist() {} };
  const context = await createBatchExecutionContext({ concurrency: 4, providerConcurrency: 2 }, {
    credentials: { zhipu: { key: 'secret' } },
    preflightImpl: async ({ credentials }) => {
      calls.preflight += 1;
      return { credentials, diagnostics: { configuredProviders: ['zhipu'] } };
    },
    cleanupExpiredImpl: () => { calls.cleanup += 1; },
    transactionFactory: () => { calls.transaction += 1; return transaction; },
    healthStoreFactory: () => { calls.health += 1; return healthStore; },
    providerSchedulerFactory: ({ defaultLimit }) => {
      calls.scheduler += 1;
      assert.equal(defaultLimit, 2);
      return { run: (_provider, task) => task() };
    },
  });

  assert.deepEqual(calls, { preflight: 1, cleanup: 1, transaction: 1, health: 1, scheduler: 1 });
  assert.equal(context.concurrency, 4);
  assert.equal(context.acquireConcurrency, 1);
  assert.equal(context.maxBatchItems, 3);
  assert.equal(context.providerConcurrency, 2);
  assert.equal(context.healthStore, healthStore);
  assert.doesNotMatch(JSON.stringify(context), /secret/);
});

test('batch context defaults Provider concurrency to one', async () => {
  const context = await createBatchExecutionContext({}, {
    preflightImpl: async () => ({ credentials: {} }),
    cleanupExpiredImpl: () => {},
    transactionFactory: () => ({ close() {}, rollback() {} }),
    healthStoreFactory: () => ({ state: {}, persist() {} }),
    providerSchedulerFactory: () => ({ run: (_provider, task) => task() }),
  });

  assert.equal(context.concurrency, 3);
  assert.equal(context.acquireConcurrency, 1);
  assert.equal(context.maxBatchItems, 3);
  assert.equal(context.providerConcurrency, 1);
});

test('batch context resolves explicit acquisition limits before preflight', async () => {
  let preflightCalls = 0;
  await assert.rejects(createBatchExecutionContext({ items: [1, 2, 3, 4] }, {
    maxBatchItems: 3,
    preflightImpl: async () => {
      preflightCalls += 1;
      return { credentials: {} };
    },
  }), (error) => error.code === 'BATCH_SIZE_LIMIT');
  assert.equal(preflightCalls, 0);
});
