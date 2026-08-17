const assert = require('node:assert/strict');
const test = require('node:test');
const { CliError } = require('../scripts/errors');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTempFileTransaction } = require('../scripts/storage/temp_files');
const {
  executeManifest,
  parseManifest,
  serializableBatchResult,
  writeBatchStatusEvent,
} = require('../scripts/describe_images');

test('parseManifest accepts strings and explicit sources in stable order', () => {
  const manifest = parseManifest({
    prompt: 'compare',
    items: ['C:/a.png', { inputId: 'web', input: 'https://example.com/b.webp' }],
  });

  assert.deepEqual(manifest.items.map(({ index }) => index), [0, 1]);
  assert.equal(manifest.items[0].source.kind, 'local_path');
  assert.equal(manifest.items[0].prompt, 'compare');
  assert.equal(manifest.items[1].source.kind, 'http_url');
  assert.equal(manifest.items[1].prompt, 'compare');
});

test('parseManifest carries both global and per-Provider concurrency', () => {
  const manifest = parseManifest({ items: ['a.png'], concurrency: 3, providerConcurrency: 1 });
  assert.equal(manifest.concurrency, 3);
  assert.equal(manifest.providerConcurrency, 1);
});

test('parseManifest rejects duplicate input IDs before execution', () => {
  assert.throws(() => parseManifest({ items: [
    { inputId: 'same', input: 'a.png' },
    { inputId: 'same', input: 'b.png' },
  ] }), (error) => error instanceof CliError && error.code === 'BATCH_MANIFEST');
});

test('batch Provider availability is hidden unless verbose mode is enabled', () => {
  const writes = [];
  const stream = { write: (value) => writes.push(value) };
  const event = { type: 'provider_available', provider: 'zhipu', models: ['glm'] };

  writeBatchStatusEvent(event, stream, {});
  assert.deepEqual(writes, []);
  writeBatchStatusEvent(event, stream, { VISION_BRIDGE_VERBOSE: '1' });
  assert.deepEqual(writes, ['[INFO] provider loaded: zhipu\n']);
  assert.doesNotMatch(writes[0], /glm|模型/);
});

test('executeManifest rejects item four before preflight, reads, or Provider calls', async () => {
  const items = ['a.png', 'b.png', 'c.png', 'd.png'].map((input, index) => ({
    inputId: `input-${index + 1}`,
    index,
    prompt: 'describe',
    source: { kind: 'local_path', value: input },
  }));
  const calls = { preflight: 0, read: 0, provider: 0 };

  await assert.rejects(executeManifest({ items }, {
    preflightImpl: async () => { calls.preflight += 1; return { credentials: {} }; },
    inputOptions: {
      resolveImpl: async () => { calls.read += 1; },
    },
    runSingleImage: async () => { calls.provider += 1; },
  }), (error) => error.code === 'BATCH_SIZE_LIMIT');

  assert.deepEqual(calls, { preflight: 0, read: 0, provider: 0 });
});

test('three items use acquisition and standardization concurrency one by default', async () => {
  const manifest = parseManifest(['a.png', 'b.png', 'c.png']);
  let acquireActive = 0;
  let acquirePeak = 0;
  let standardizeActive = 0;
  let standardizePeak = 0;

  const results = await executeManifest(manifest, {
    preflightImpl: async () => ({ credentials: {} }),
    inputOptions: {
      resolveImpl: async (value) => {
        acquireActive += 1;
        acquirePeak = Math.max(acquirePeak, acquireActive);
        await new Promise((resolve) => setTimeout(resolve, 3));
        acquireActive -= 1;
        return { data: Buffer.from(value), mime: 'image/png' };
      },
      canonicalizeImpl: async (image) => {
        standardizeActive += 1;
        standardizePeak = Math.max(standardizePeak, standardizeActive);
        await new Promise((resolve) => setTimeout(resolve, 3));
        standardizeActive -= 1;
        return image;
      },
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => ({
      jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
      error: null, originalIndexes: current.originalIndexes,
    }),
  });

  assert.equal(results.length, 3);
  assert.equal(acquirePeak, 1);
  assert.equal(standardizePeak, 1);
});

test('streaming execution starts Provider work before later acquisitions finish', async () => {
  const manifest = parseManifest(['a.png', 'b.png', 'c.png']);
  let acquired = 0;
  let resolveAllAcquired;
  const allAcquired = new Promise((resolve) => { resolveAllAcquired = resolve; });
  let releaseProviders;
  const providerGate = new Promise((resolve) => { releaseProviders = resolve; });
  let providerStarted = 0;

  const execution = executeManifest(manifest, {
    preflightImpl: async () => ({ credentials: {} }),
    inputOptions: {
      resolveImpl: async (value) => {
        acquired += 1;
        if (acquired === 3) resolveAllAcquired();
        return { data: Buffer.from(value), mime: 'image/png' };
      },
      canonicalizeImpl: async (image) => image,
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => {
      providerStarted += 1;
      await providerGate;
      return {
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        error: null, originalIndexes: current.originalIndexes,
      };
    },
  });

  await Promise.race([
    allAcquired,
    new Promise((_, reject) => setTimeout(() => reject(new Error('acquisition stalled behind Provider')), 1000)),
  ]);
  assert.ok(providerStarted >= 1);
  releaseProviders();
  const results = await execution;
  assert.deepEqual(results.map(({ index }) => index), [0, 1, 2]);
});

test('streaming envelopes release success and failure Buffers before returning', async () => {
  const manifest = parseManifest(['good.png', 'bad.png']);
  const released = [];
  const results = await executeManifest(manifest, {
    preflightImpl: async () => ({ credentials: {} }),
    onBufferRelease: (envelope) => released.push({
      jobId: envelope.jobId,
      hasBuffer: envelope.hasBuffer,
      released: envelope.released,
    }),
    inputOptions: {
      resolveImpl: async (value) => ({ data: Buffer.from(value), mime: 'image/png' }),
      canonicalizeImpl: async (image) => image,
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => {
      if (current.canonicalAsset.inputId === 'input-2') throw new Error('provider failed');
      return {
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        error: null, originalIndexes: current.originalIndexes,
      };
    },
  });

  assert.deepEqual(results.map(({ status }) => status), ['succeeded', 'failed']);
  assert.equal(released.length, 2);
  assert.ok(released.every(({ hasBuffer, released: wasReleased }) => !hasBuffer && wasReleased));
});

test('executeManifest deduplicates before invoking the batch runner', async () => {
  const manifest = parseManifest(['a.png', 'copy.png']);
  let calls = 0;
  const results = await executeManifest(manifest, {
    credentials: {},
    preflightImpl: async ({ credentials }) => ({ credentials }),
    inputOptions: {
      standardizeImpl: async () => ({ data: Buffer.from('same'), mime: 'image/png' }),
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => {
      calls += 1;
      return {
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        error: null, originalIndexes: current.originalIndexes,
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(({ inputId }) => inputId), ['input-1', 'input-2']);
  assert.deepEqual(results.map(({ deduplicated }) => deduplicated), [false, true]);
  assert.equal(results[0].canonicalJobId, results[1].canonicalJobId);
  const serialized = JSON.stringify(serializableBatchResult(results));
  assert.doesNotMatch(serialized, /same/);
  assert.doesNotMatch(serialized, /"provider"|"model"/);
});

test('executeManifest preserves input failures beside successful items', async () => {
  const manifest = parseManifest(['bad.png', 'good.png']);
  const results = await executeManifest(manifest, {
    credentials: {},
    preflightImpl: async ({ credentials }) => ({ credentials }),
    inputOptions: {
      standardizeImpl: async (value) => {
        if (value === 'bad.png') throw new Error('invalid image');
        return { data: Buffer.from('good'), mime: 'image/png' };
      },
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => ({
      jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
      error: null, originalIndexes: current.originalIndexes,
    }),
  });

  assert.deepEqual(results.map(({ status }) => status), ['failed', 'succeeded']);
  assert.equal(results[0].error.stage, 'standardize');
});

test('executeManifest runs preflight once and blocks Provider calls on failure', async () => {
  const manifest = parseManifest(['image.png']);
  let preflightCalls = 0;
  let providerCalls = 0;

  await assert.rejects(executeManifest(manifest, {
    preflightImpl: async () => {
      preflightCalls += 1;
      throw new CliError('PREFLIGHT', 'blocked');
    },
    runSingleImage: async () => { providerCalls += 1; },
  }), /blocked/);

  assert.equal(preflightCalls, 1);
  assert.equal(providerCalls, 0);
});

test('session attachments expand through the selected adapter and clean on success', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-batch-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  const manifest = parseManifest({ items: [{ source: { kind: 'session_attachment', client: 'claude', cwd: 'C:/work' } }] });
  let providerCalls = 0;

  const results = await executeManifest(manifest, {
    transaction,
    preflightImpl: async () => ({ credentials: {} }),
    recoverImpl: async ({ client, transaction: owner }) => {
      assert.equal(client, 'claude');
      const first = owner.write(Buffer.from('first'), 'first.png');
      const second = owner.write(Buffer.from('second'), 'second.png');
      return { client, images: [
        { index: 1, ...first },
        { index: 2, ...second },
      ] };
    },
    inputOptions: {
      standardizeImpl: async (value) => ({ data: Buffer.from(path.basename(value)), mime: 'image/png' }),
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => {
      providerCalls += 1;
      return {
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        error: null, originalIndexes: current.originalIndexes,
      };
    },
  });

  assert.equal(providerCalls, 2);
  assert.deepEqual(results.map(({ originalIndexes }) => originalIndexes), [[0], [1]]);
  assert.equal(fs.existsSync(transaction.directory), false);
});

test('retryable session failures retain transaction files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-batch-retain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  const manifest = parseManifest({ items: [{ source: { kind: 'session_attachment', client: 'opencode', cwd: 'C:/work' } }] });

  const results = await executeManifest(manifest, {
    transaction,
    preflightImpl: async () => ({ credentials: {} }),
    recoverImpl: async ({ client, transaction: owner }) => {
      const image = owner.write(Buffer.from('image'), 'image.png');
      return { client, images: [{ index: 1, ...image }] };
    },
    inputOptions: {
      standardizeImpl: async () => ({ data: Buffer.from('image'), mime: 'image/png' }),
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => ({
      jobId: current.jobId,
      status: 'failed',
      text: '', provider: null, model: null,
      error: { stage: 'provider', code: 'RATE_LIMITED', message: 'retry', retryable: true, scope: 'image' },
      originalIndexes: current.originalIndexes,
    }),
  });

  assert.equal(results[0].error.retryable, true);
  assert.match(results[0].retryPath, /image\.png$/);
  assert.match(results[0].retryExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(results), /cleanupToken|transaction/);
  assert.equal(fs.existsSync(transaction.directory), true);
  assert.equal(fs.readdirSync(transaction.directory).length, 1);
});

test('retry references are returned only to aliases that own temporary files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-batch-owned-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  const manifest = parseManifest({ items: [
    { inputId: 'local', input: 'local.png' },
    { inputId: 'session', source: { kind: 'session_attachment', client: 'claude', cwd: 'C:/work' } },
  ] });

  const results = await executeManifest(manifest, {
    transaction,
    preflightImpl: async () => ({ credentials: {} }),
    recoverImpl: async ({ client, transaction: owner }) => {
      const image = owner.write(Buffer.from('same'), 'session.png');
      return { client, images: [{ index: 1, ...image }] };
    },
    inputOptions: {
      standardizeImpl: async () => ({ data: Buffer.from('same'), mime: 'image/png' }),
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => ({
      jobId: current.jobId,
      status: 'failed',
      text: '', provider: null, model: null,
      error: { stage: 'provider', code: 'RATE_LIMITED', message: 'retry', retryable: true, scope: 'image' },
      originalIndexes: current.originalIndexes,
    }),
  });

  assert.equal(results[0].inputId, 'local');
  assert.equal(results[0].retryPath, null);
  assert.equal(results[1].inputId, 'session');
  assert.match(results[1].retryPath, /session\.png$/);
});

test('duplicate missing sessions recover once and read clipboard once', async () => {
  const manifest = parseManifest({ items: [
    { source: { kind: 'session_attachment', client: 'claude', cwd: 'C:/work' } },
    { source: { kind: 'session_attachment', client: 'claude', cwd: 'C:/work' } },
  ] });
  let recoveryCalls = 0;
  let clipboardCalls = 0;
  let providerCalls = 0;

  const results = await executeManifest(manifest, {
    preflightImpl: async () => ({ credentials: {} }),
    recoverImpl: async () => {
      recoveryCalls += 1;
      throw new CliError('SESSION_IMAGE_NOT_FOUND', 'no session image');
    },
    inputOptions: {
      standardizeImpl: async (value) => {
        assert.equal(value, 'clipboard');
        clipboardCalls += 1;
        return { data: Buffer.from('clipboard-image'), mime: 'image/png' };
      },
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current) => {
      providerCalls += 1;
      return {
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        error: null, originalIndexes: current.originalIndexes,
      };
    },
  });

  assert.equal(recoveryCalls, 1);
  assert.equal(clipboardCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(({ originalIndexes }) => originalIndexes), [[0], [1]]);
  assert.deepEqual(results.map(({ deduplicated }) => deduplicated), [false, true]);
});

test('ambiguous sessions do not fall back to clipboard', async () => {
  const manifest = parseManifest({ items: [
    { source: { kind: 'session_attachment', client: 'opencode', cwd: 'C:/work' } },
    { source: { kind: 'session_attachment', client: 'opencode', cwd: 'C:/work' } },
  ] });
  let recoveryCalls = 0;
  let inputCalls = 0;

  const results = await executeManifest(manifest, {
    preflightImpl: async () => ({ credentials: {} }),
    recoverImpl: async () => {
      recoveryCalls += 1;
      throw new CliError('SESSION_AMBIGUOUS', 'choose a session');
    },
    inputOptions: {
      standardizeImpl: async () => { inputCalls += 1; },
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
  });

  assert.equal(recoveryCalls, 1);
  assert.equal(inputCalls, 0);
  assert.deepEqual(results.map(({ error }) => error.code), ['SESSION_AMBIGUOUS', 'SESSION_AMBIGUOUS']);
});

test('batch events deduplicate Provider state and correlate image transitions', async () => {
  const manifest = parseManifest(['first.png', 'second.png']);
  const events = [];
  const results = await executeManifest(manifest, {
    preflightImpl: async () => ({ credentials: {} }),
    onStatus: (event) => events.push(event),
    inputOptions: {
      standardizeImpl: async (value) => ({ data: Buffer.from(value), mime: 'image/png' }),
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (current, options) => {
      options.onStatus({ type: 'provider_available', provider: 'zhipu', models: ['mock'] });
      options.onStatus({ type: 'model_switch', provider: 'zhipu', model: 'a', next: 'b' });
      return {
        jobId: current.jobId, status: 'succeeded', text: 'ok', provider: 'mock', model: 'mock',
        error: null, originalIndexes: current.originalIndexes,
      };
    },
  });

  assert.equal(results.length, 2);
  assert.equal(events.filter(({ type }) => type === 'provider_available').length, 1);
  const switches = events.filter(({ type }) => type === 'model_switch');
  assert.equal(switches.length, 2);
  assert.ok(switches.every(({ jobId, inputIds }) => jobId && inputIds.length === 1));
  const terminal = events.filter(({ type, state }) => type === 'workflow_state' && state === 'cleaned');
  assert.deepEqual(terminal.map(({ inputId }) => inputId).sort(), ['input-1', 'input-2']);
});
