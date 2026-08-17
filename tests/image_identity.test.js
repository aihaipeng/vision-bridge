const assert = require('node:assert/strict');
const test = require('node:test');
const { createImageAsset } = require('../scripts/workflow/contracts');
const { deduplicateAssets } = require('../scripts/workflow/image_identity');

function asset(inputId, index, prompt, contentHash, cleanupToken = null) {
  return createImageAsset({
    inputId, index, prompt,
    source: { kind: 'local_path', value: `C:/${inputId}.png` },
    data: Buffer.from(inputId), mime: 'image/png', width: 1, height: 1, contentHash,
    cleanupToken,
  });
}

test('deduplicateAssets merges identical content with the same prompt', () => {
  const hash = 'a'.repeat(64);
  const jobs = deduplicateAssets([
    asset('second', 1, 'describe', hash),
    asset('first', 0, 'describe', hash),
  ]);

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].aliases, ['first', 'second']);
  assert.deepEqual(jobs[0].originalIndexes, [0, 1]);
  assert.equal(jobs[0].canonicalAsset.inputId, 'first');
});

test('deduplicateAssets keeps identical content separate when prompts differ', () => {
  const hash = 'b'.repeat(64);
  const jobs = deduplicateAssets([
    asset('one', 0, 'describe', hash),
    asset('two', 1, 'extract text', hash),
  ]);

  assert.equal(jobs.length, 2);
});

test('deduplicateAssets preserves cleanup ownership by alias', () => {
  const token = { id: 1 };
  const hash = 'c'.repeat(64);
  const jobs = deduplicateAssets([
    asset('local', 0, 'describe', hash),
    asset('session', 1, 'describe', hash, token),
  ]);

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].cleanupEntries, [{ inputId: 'session', token }]);
});
