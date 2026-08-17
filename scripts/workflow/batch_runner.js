const { failedImageResult, runSingleImage: defaultRunSingleImage } = require('./single_image_runner');
const { throwIfCancelled } = require('./cancellation');

const DEFAULT_BATCH_CONCURRENCY = 3;
const MAX_BATCH_CONCURRENCY = 32;

function parseConcurrency(value, fallback = DEFAULT_BATCH_CONCURRENCY) {
  if (value === undefined || value === null || value === '') return fallback;
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_BATCH_CONCURRENCY) {
    throw new TypeError(`Concurrency must be a 1-${MAX_BATCH_CONCURRENCY} integer`);
  }
  return concurrency;
}

function firstOriginalIndex(result) {
  return Math.min(...result.originalIndexes);
}

async function mapSettledBounded(items, mapper, concurrency = DEFAULT_BATCH_CONCURRENCY, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const limit = parseConcurrency(concurrency);
  const settled = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      throwIfCancelled(options.signal);
      const current = cursor;
      cursor += 1;
      try {
        settled[current] = { status: 'fulfilled', value: await mapper(items[current], current) };
      } catch (reason) {
        settled[current] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return settled;
}

async function runBatch(jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('jobs must be an array');
  if (jobs.length === 0) return [];
  const concurrency = parseConcurrency(options.concurrency);
  const runSingleImage = options.runSingleImage || defaultRunSingleImage;
  const results = new Array(jobs.length);
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      throwIfCancelled(options.signal);
      const current = cursor;
      cursor += 1;
      try {
        results[current] = await runSingleImage(jobs[current], options.singleImageOptions || {});
      } catch (error) {
        results[current] = failedImageResult(jobs[current], error, 'runner');
      }
    }
  }

  const workerCount = Math.min(concurrency, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.sort((left, right) => firstOriginalIndex(left) - firstOriginalIndex(right));
}

module.exports = {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  mapSettledBounded,
  parseConcurrency,
  runBatch,
};
