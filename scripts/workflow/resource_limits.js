const { CliError } = require('../errors');

const DEFAULT_MAX_BATCH_ITEMS = 3;
const DEFAULT_ACQUIRE_CONCURRENCY = 1;
const MAX_ACQUIRE_CONCURRENCY = 32;

function configurationError(name, value, expected) {
  return new CliError(
    'CONFIGURATION',
    `Invalid ${name} configuration: ${String(value)}; expected ${expected}`,
    2,
  );
}

function parsePositiveInteger(value, options) {
  const { name, fallback, maximum = Number.MAX_SAFE_INTEGER } = options;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    const expected = maximum === Number.MAX_SAFE_INTEGER
      ? 'a positive integer'
      : `an integer from 1 to ${maximum}`;
    throw configurationError(name, value, expected);
  }
  return parsed;
}

function resolveResourceLimits(options = {}) {
  return Object.freeze({
    maxBatchItems: parsePositiveInteger(
      options.maxBatchItems ?? process.env.VISION_BRIDGE_MAX_BATCH_ITEMS,
      {
        name: 'VISION_BRIDGE_MAX_BATCH_ITEMS',
        fallback: DEFAULT_MAX_BATCH_ITEMS,
      },
    ),
    acquireConcurrency: parsePositiveInteger(
      options.acquireConcurrency ?? process.env.VISION_BRIDGE_ACQUIRE_CONCURRENCY,
      {
        name: 'VISION_BRIDGE_ACQUIRE_CONCURRENCY',
        fallback: DEFAULT_ACQUIRE_CONCURRENCY,
        maximum: MAX_ACQUIRE_CONCURRENCY,
      },
    ),
  });
}

function enforceBatchSize(items, maxBatchItems = DEFAULT_MAX_BATCH_ITEMS) {
  if (!Array.isArray(items)) return;
  if (items.length > maxBatchItems) {
    throw new CliError(
      'BATCH_SIZE_LIMIT',
      `Batch contains ${items.length} images, exceeding the current limit of ${maxBatchItems}`,
      2,
    );
  }
}

module.exports = {
  DEFAULT_ACQUIRE_CONCURRENCY,
  DEFAULT_MAX_BATCH_ITEMS,
  MAX_ACQUIRE_CONCURRENCY,
  enforceBatchSize,
  parsePositiveInteger,
  resolveResourceLimits,
};
