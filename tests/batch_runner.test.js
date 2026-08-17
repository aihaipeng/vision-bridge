const assert = require('node:assert/strict');
const test = require('node:test');
const { createImageResult } = require('../scripts/workflow/contracts');
const { mapSettledBounded, parseConcurrency, runBatch } = require('../scripts/workflow/batch_runner');

function job(id, indexes) {
  return { jobId: id, canonicalAsset: {}, prompt: 'describe', originalIndexes: indexes };
}

test('runBatch limits peak concurrency and restores input order', async () => {
  const jobs = [job('third', [2]), job('first', [0]), job('second', [1])];
  let active = 0;
  let peak = 0;
  const calls = [];
  const results = await runBatch(jobs, {
    concurrency: 2,
    runSingleImage: async (current) => {
      calls.push(current.jobId);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, current.jobId === 'third' ? 20 : 1));
      active -= 1;
      return createImageResult({
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        originalIndexes: current.originalIndexes,
      });
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(calls.sort(), ['first', 'second', 'third']);
  assert.deepEqual(results.map(({ jobId }) => jobId), ['first', 'second', 'third']);
});

test('runBatch waits for remaining jobs after one throws', async () => {
  const calls = [];
  const results = await runBatch([job('bad', [0]), job('good', [1])], {
    concurrency: 1,
    runSingleImage: async (current) => {
      calls.push(current.jobId);
      if (current.jobId === 'bad') throw new Error('boom');
      return createImageResult({
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock', originalIndexes: [1],
      });
    },
  });

  assert.deepEqual(calls, ['bad', 'good']);
  assert.deepEqual(results.map(({ status }) => status), ['failed', 'succeeded']);
  assert.equal(results[0].error.stage, 'runner');
});

test('parseConcurrency defaults to 3 and rejects unsafe values', () => {
  assert.equal(parseConcurrency(), 3);
  assert.equal(parseConcurrency('4'), 4);
  assert.throws(() => parseConcurrency(0), /1-32/);
  assert.throws(() => parseConcurrency(33), /1-32/);
});

test('mapSettledBounded limits acquisition work and preserves rejection positions', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapSettledBounded([0, 1, 2, 3], async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (value === 1) throw new Error('bad input');
    return value * 2;
  }, 2);

  assert.equal(peak, 2);
  assert.deepEqual(results.map(({ status }) => status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[2].value, 4);
});
