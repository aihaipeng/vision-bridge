const assert = require('node:assert/strict');
const test = require('node:test');
const { CliError } = require('../scripts/errors');
const {
  DEFAULT_ACQUIRE_CONCURRENCY,
  DEFAULT_MAX_BATCH_ITEMS,
  enforceBatchSize,
  resolveResourceLimits,
} = require('../scripts/workflow/resource_limits');

test('resource limits default to three batch items and one acquisition', () => {
  const limits = resolveResourceLimits({ maxBatchItems: '', acquireConcurrency: '' });
  assert.equal(limits.maxBatchItems, DEFAULT_MAX_BATCH_ITEMS);
  assert.equal(limits.acquireConcurrency, DEFAULT_ACQUIRE_CONCURRENCY);
  assert.doesNotThrow(() => enforceBatchSize([1, 2, 3], limits.maxBatchItems));
});

test('batch size limit returns a structured error', () => {
  assert.throws(() => enforceBatchSize([1, 2, 3, 4], 3), (error) => (
    error instanceof CliError
      && error.code === 'BATCH_SIZE_LIMIT'
      && error.exitCode === 2
  ));
});

test('invalid resource environment values return structured configuration errors', () => {
  const previousMax = process.env.VISION_BRIDGE_MAX_BATCH_ITEMS;
  const previousAcquire = process.env.VISION_BRIDGE_ACQUIRE_CONCURRENCY;
  try {
    process.env.VISION_BRIDGE_MAX_BATCH_ITEMS = '0';
    assert.throws(() => resolveResourceLimits(), (error) => (
      error instanceof CliError
        && error.code === 'CONFIGURATION'
        && /VISION_BRIDGE_MAX_BATCH_ITEMS/.test(error.message)
    ));

    process.env.VISION_BRIDGE_MAX_BATCH_ITEMS = '3';
    process.env.VISION_BRIDGE_ACQUIRE_CONCURRENCY = '33';
    assert.throws(() => resolveResourceLimits(), (error) => (
      error instanceof CliError
        && error.code === 'CONFIGURATION'
        && /VISION_BRIDGE_ACQUIRE_CONCURRENCY/.test(error.message)
    ));
  } finally {
    if (previousMax === undefined) delete process.env.VISION_BRIDGE_MAX_BATCH_ITEMS;
    else process.env.VISION_BRIDGE_MAX_BATCH_ITEMS = previousMax;
    if (previousAcquire === undefined) delete process.env.VISION_BRIDGE_ACQUIRE_CONCURRENCY;
    else process.env.VISION_BRIDGE_ACQUIRE_CONCURRENCY = previousAcquire;
  }
});
