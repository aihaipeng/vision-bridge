const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { parseManifest } = require('../scripts/describe_images');
const { createRetryManifest } = require('../scripts/workflow/retry_manifest');

test('retry manifest contains only failures and prefers a valid retry path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-retry-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retryPath = path.join(root, 'retry.png');
  fs.writeFileSync(retryPath, Buffer.from('image'));
  const original = {
    prompt: 'compare',
    items: [
      { inputId: 'first', input: 'first.png' },
      { inputId: 'second', input: 'second.png', prompt: 'read text' },
      { inputId: 'third', input: 'https://example.com/third.png' },
    ],
  };
  const providerCalls = { count: 0 };
  const retry = createRetryManifest(original, { results: [
    { inputId: 'first', index: 0, status: 'succeeded' },
    {
      inputId: 'second', index: 1, status: 'failed', retryPath,
      retryExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    { inputId: 'third', index: 2, status: 'failed', retryPath: null },
  ] }, { providerCalls });

  assert.equal(providerCalls.count, 0);
  assert.deepEqual(retry.items.map(({ inputId }) => inputId), ['second', 'third']);
  assert.equal(retry.items[0].input, retryPath);
  assert.equal(retry.items[0].prompt, 'read text');
  assert.equal(retry.items[0].originalIndex, 1);
  assert.equal(retry.items[1].input, 'https://example.com/third.png');
  assert.equal(retry.items[1].originalIndex, 2);
  assert.deepEqual(parseManifest(retry).items.map(({ inputId }) => inputId), ['second', 'third']);
});

test('expanded session result preserves prompt and original index metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-retry-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retryPath = path.join(root, 'session.png');
  fs.writeFileSync(retryPath, Buffer.from('image'));
  const retry = createRetryManifest({ items: [{
    inputId: 'attachment',
    prompt: 'extract labels',
    source: { kind: 'session_attachment', client: 'claude' },
  }] }, [{
    inputId: 'attachment:2', index: 1, status: 'failed', retryPath,
    retryExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  }]);

  assert.equal(retry.items[0].inputId, 'attachment:2');
  assert.equal(retry.items[0].prompt, 'extract labels');
  assert.equal(retry.items[0].originalIndex, 1);
  assert.equal(retry.items[0].input, retryPath);
});

test('expired or missing retry paths fail with RETRY_EXPIRED', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-retry-expired-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retryPath = path.join(root, 'expired.png');
  fs.writeFileSync(retryPath, Buffer.from('image'));
  const original = { items: [{ inputId: 'failed', input: 'failed.png' }] };

  assert.throws(() => createRetryManifest(original, [{
    inputId: 'failed', index: 0, status: 'failed', retryPath,
    retryExpiresAt: new Date(Date.now() - 1).toISOString(),
  }]), (error) => error.code === 'RETRY_EXPIRED');

  fs.rmSync(retryPath);
  assert.throws(() => createRetryManifest(original, [{
    inputId: 'failed', index: 0, status: 'failed', retryPath,
    retryExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  }]), (error) => error.code === 'RETRY_EXPIRED');
});

test('retry manifest CLI writes executable JSON without running Providers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-retry-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'manifest.json');
  const resultsPath = path.join(root, 'results.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ items: ['https://example.com/image.png'] }));
  fs.writeFileSync(resultsPath, JSON.stringify({
    status: 'failed',
    results: [{ inputId: 'input-1', index: 0, status: 'failed' }],
  }));

  const child = spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/create_retry_manifest.js'),
    manifestPath,
    resultsPath,
  ], { encoding: 'utf8' });

  assert.equal(child.status, 0, child.stderr);
  const retry = JSON.parse(child.stdout);
  assert.equal(retry.items.length, 1);
  assert.equal(retry.items[0].input, 'https://example.com/image.png');
});
