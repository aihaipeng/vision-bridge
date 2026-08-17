const assert = require('node:assert/strict');
const test = require('node:test');
const { CliError } = require('../scripts/errors');
const { runSingleImage } = require('../scripts/workflow/single_image_runner');

const job = {
  jobId: 'job-1',
  canonicalAsset: { data: Buffer.from('image'), mime: 'image/png' },
  prompt: 'describe',
  originalIndexes: [0, 2],
};

test('runSingleImage converts Provider success into an ImageResult', async () => {
  const result = await runSingleImage(job, {
    describeImpl: async ({ image, prompt }) => {
      assert.equal(image, job.canonicalAsset);
      assert.equal(prompt, 'describe');
      return { text: '<|begin_of_box|>ok<|end_of_box|>', provider: 'zhipu', model: 'glm' };
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, 'ok');
  assert.deepEqual(result.originalIndexes, [0, 2]);
});

test('runSingleImage converts retryable Provider failures into structured results', async () => {
  const result = await runSingleImage(job, {
    describeImpl: async () => { throw new CliError('RATE_LIMITED', 'slow down'); },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.stage, 'provider');
  assert.equal(result.error.retryable, true);
});
