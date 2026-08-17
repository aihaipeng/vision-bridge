const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveImageInput } = require('../scripts/image_input_resolver');
const { fetchWithTimeout, nativeRequest } = require('../scripts/providers/http');
const { createTempFileTransaction } = require('../scripts/storage/temp_files');
const { executeManifest, parseManifest } = require('../scripts/describe_images');
const { createBoundedTaskQueue } = require('../scripts/workflow/bounded_task_queue');
const {
  cancellationError,
  createBatchCancellation,
  parseBatchTimeoutMs,
} = require('../scripts/workflow/cancellation');

test('batch timeout is optional and invalid values are structured configuration errors', () => {
  assert.equal(parseBatchTimeoutMs(''), null);
  assert.equal(parseBatchTimeoutMs('25'), 25);
  assert.throws(() => parseBatchTimeoutMs('0'), (error) => error.code === 'CONFIGURATION');
});

test('batch deadline aborts with BATCH_CANCELLED', async () => {
  const cancellation = createBatchCancellation({ batchTimeoutMs: 5 });
  try {
    await new Promise((resolve) => cancellation.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(cancellation.signal.aborted, true);
    assert.equal(cancellationError(cancellation.signal).code, 'BATCH_CANCELLED');
  } finally {
    cancellation.dispose();
  }
});

test('bounded task queue rejects cancelled waiters without starting them', async () => {
  const controller = new AbortController();
  const queue = createBoundedTaskQueue(1, { signal: controller.signal });
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const first = queue.run(() => new Promise((resolve) => {
    releaseFirst = resolve;
    markFirstStarted();
  }));
  await firstStarted;
  let secondCalls = 0;
  const second = queue.run(async () => { secondCalls += 1; });
  controller.abort(new Error('stop'));

  await assert.rejects(second, (error) => error.code === 'BATCH_CANCELLED');
  assert.equal(secondCalls, 0);
  releaseFirst('done');
  assert.equal(await first, 'done');
});

test('Provider HTTP combines caller cancellation with its timeout signal', async () => {
  const controller = new AbortController();
  let observedSignal;
  const request = fetchWithTimeout((_url, options) => {
    observedSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  }, 'https://example.com/provider', { method: 'POST', signal: controller.signal }, 1000);

  controller.abort(new Error('user cancelled'));
  await assert.rejects(request, (error) => error.code === 'BATCH_CANCELLED');
  assert.equal(observedSignal.aborted, true);
});

test('native Provider HTTP destroys an in-flight request on cancellation', async (t) => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const server = http.createServer(() => { markStarted(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const controller = new AbortController();
  const address = server.address();
  const request = nativeRequest(
    `http://127.0.0.1:${address.port}/slow`,
    { method: 'GET', signal: controller.signal },
    1000,
  );

  await started;
  controller.abort(new Error('stop native request'));
  await assert.rejects(request, (error) => error.code === 'BATCH_CANCELLED');
});

test('public URL acquisition forwards cancellation to the download implementation', async () => {
  const controller = new AbortController();
  let started;
  const downloadStarted = new Promise((resolve) => { started = resolve; });
  const acquisition = resolveImageInput('https://example.com/image.png', {
    signal: controller.signal,
    resolveRemoteImageImpl: (_url, options) => new Promise((resolve, reject) => {
      started();
      options.signal.addEventListener('abort', () => reject(cancellationError(options.signal)), { once: true });
    }),
  });

  await downloadStarted;
  controller.abort(new Error('stop download'));
  await assert.rejects(acquisition, (error) => error.code === 'BATCH_CANCELLED');
});

test('batch cancellation stops queued Provider work and rolls back temporary files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-batch-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  const manifest = parseManifest({
    concurrency: 1,
    items: [
      { source: { kind: 'session_attachment', client: 'claude', cwd: 'C:/work' } },
      'second.png',
      'third.png',
    ],
  });
  const controller = new AbortController();
  let providerCalls = 0;
  let markProviderStarted;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });

  const execution = executeManifest(manifest, {
    signal: controller.signal,
    transaction,
    preflightImpl: async () => ({ credentials: {} }),
    recoverImpl: async ({ transaction: owner }) => {
      const image = owner.write(Buffer.from('session'), 'session.png');
      return { client: 'claude', images: [{ index: 1, ...image }] };
    },
    inputOptions: {
      standardizeImpl: async (value) => ({ data: Buffer.from(value), mime: 'image/png' }),
      dimensionsImpl: async () => ({ width: 1, height: 1 }),
    },
    runSingleImage: async (_current, options) => {
      providerCalls += 1;
      markProviderStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(cancellationError(options.signal)),
          { once: true },
        );
      });
    },
  });

  await providerStarted;
  controller.abort(new Error('user stopped task'));
  await assert.rejects(execution, (error) => error.code === 'BATCH_CANCELLED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 1);
  assert.equal(fs.existsSync(transaction.directory), false);
});
