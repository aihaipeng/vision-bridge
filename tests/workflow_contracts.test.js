const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WorkflowContractError,
  createImageAsset,
  createImageJob,
  createImageResult,
  createInputItem,
  createWorkflowError,
} = require('../scripts/workflow/contracts');

const source = { kind: 'local_path', value: 'C:/images/example.png' };
const hash = 'a'.repeat(64);

test('createInputItem accepts the confirmed public source kinds', () => {
  const item = createInputItem({ inputId: 'input-1', index: 0, prompt: 'describe', source });

  assert.equal(item.source.kind, 'local_path');
  assert.equal(Object.isFrozen(item), true);
});

test('session attachment sources require an explicit client', () => {
  assert.throws(() => createInputItem({
    inputId: 'input-1', index: 0, prompt: 'describe', source: { kind: 'session_attachment' },
  }), WorkflowContractError);
  assert.throws(() => createInputItem({
    inputId: 'input-2', index: 1, prompt: 'describe', source: { kind: 'session_attachment', client: 'codex' },
  }), /accepts only claude or opencode/);
});

test('createImageAsset requires canonical MIME, dimensions, Buffer and hash', () => {
  const asset = createImageAsset({
    inputId: 'input-1', index: 0, prompt: 'describe', source,
    data: Buffer.from('image'), mime: 'image/png', width: 1, height: 1, contentHash: hash,
  });

  assert.equal(asset.contentHash, hash);
  assert.throws(() => createImageAsset({ ...asset, mime: 'image/webp' }), WorkflowContractError);
});

test('createImageJob preserves aliases and original indexes', () => {
  const asset = createImageAsset({
    inputId: 'input-1', index: 0, prompt: 'describe', source,
    data: Buffer.from('image'), mime: 'image/png', width: 1, height: 1, contentHash: hash,
  });
  const job = createImageJob({
    jobId: hash, canonicalAsset: asset, aliases: ['input-1', 'input-2'],
    prompt: 'describe', originalIndexes: [0, 1],
  });

  assert.deepEqual(job.originalIndexes, [0, 1]);
  assert.equal(Object.isFrozen(job.aliases), true);
});

test('createImageResult enforces success and failure invariants', () => {
  const success = createImageResult({
    jobId: hash, status: 'succeeded', text: 'ok', provider: 'zhipu', model: 'glm', originalIndexes: [0],
  });
  const error = createWorkflowError({ stage: 'provider', code: 'HTTP', message: 'failed', retryable: true });
  const failure = createImageResult({ jobId: hash, status: 'failed', error, originalIndexes: [0] });

  assert.equal(success.error, null);
  assert.equal(failure.error.retryable, true);
  assert.throws(() => createImageResult({ jobId: hash, status: 'failed', originalIndexes: [0] }), WorkflowContractError);
});
