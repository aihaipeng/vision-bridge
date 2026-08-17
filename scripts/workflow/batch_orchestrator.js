const { recoverSessionImages, DEFAULT_MAX_AGE_MINUTES } = require('../recover_session_images');
const {
  createImageResult,
  createImageJob,
  createInputItem,
  createWorkflowError,
} = require('./contracts');
const { createBatchExecutionContext } = require('./batch_context');
const { createBoundedTaskQueue } = require('./bounded_task_queue');
const { mapSettledBounded, runBatch } = require('./batch_runner');
const { ExecutionEnvelope } = require('./execution_envelope');
const { deduplicateAssets, jobIdentity } = require('./image_identity');
const { acquireInputItem, standardizeAcquired } = require('./input_pipeline');
const {
  failedImageResult,
  runSingleImage: defaultRunSingleImage,
} = require('./single_image_runner');
const { enforceBatchSize, resolveResourceLimits } = require('./resource_limits');
const {
  cancellationError,
  isBatchCancelled,
  throwIfCancelled,
} = require('./cancellation');

function inputFailure(item, error, stage = 'standardize') {
  return createImageResult({
    jobId: `input:${item.inputId}`,
    status: 'failed',
    error: createWorkflowError({
      stage,
      code: error && error.code ? String(error.code) : 'IMAGE_INPUT',
      message: String(error && (error.message || error) || 'Image input processing failed'),
      retryable: false,
      scope: 'image',
    }),
    originalIndexes: [item.index],
  });
}

async function discoverInputs(context, items) {
  const recoverImpl = context.recoverImpl || recoverSessionImages;
  const expanded = [];
  const failures = [];
  const cleanupTokens = new Map();
  const recoveryCache = new Map();
  const allItems = [];
  let nextIndex = 0;

  for (const item of items) {
    throwIfCancelled(context.signal);
    if (item.source.kind !== 'session_attachment' || item.source.value) {
      const discoveredItem = createInputItem({ ...item, index: nextIndex });
      expanded.push(discoveredItem);
      allItems.push(discoveredItem);
      context.stateTracker.start(discoveredItem.inputId, {
        inputId: discoveredItem.inputId, index: discoveredItem.index,
      });
      nextIndex += 1;
      continue;
    }
    const recoveryOptions = {
      client: item.source.client,
      cwd: item.source.cwd || process.cwd(),
      sessionId: item.source.sessionId,
      maxAgeMinutes: item.source.maxAgeMinutes || DEFAULT_MAX_AGE_MINUTES,
      signal: context.signal,
      transaction: context.transaction,
    };
    const recoveryKey = JSON.stringify({
      client: recoveryOptions.client,
      cwd: recoveryOptions.cwd,
      sessionId: recoveryOptions.sessionId,
      maxAgeMinutes: recoveryOptions.maxAgeMinutes,
    });
    if (!recoveryCache.has(recoveryKey)) {
      try {
        recoveryCache.set(recoveryKey, { value: await recoverImpl(recoveryOptions) });
      } catch (error) {
        recoveryCache.set(recoveryKey, { error });
      }
    }
    const recovered = recoveryCache.get(recoveryKey);
    try {
      if (recovered.error) throw recovered.error;
      const recovery = recovered.value;
      for (const image of recovery.images) {
        const inputId = recovery.images.length === 1 ? item.inputId : `${item.inputId}:${image.index}`;
        const discoveredItem = createInputItem({
          inputId,
          index: nextIndex,
          prompt: item.prompt,
          source: { kind: 'session_attachment', client: recovery.client, value: image.path },
        });
        expanded.push(discoveredItem);
        allItems.push(discoveredItem);
        context.stateTracker.start(discoveredItem.inputId, {
          inputId: discoveredItem.inputId, index: discoveredItem.index,
        });
        if (image.cleanupToken) cleanupTokens.set(inputId, image.cleanupToken);
        nextIndex += 1;
      }
    } catch (error) {
      const failedItem = createInputItem({ ...item, index: nextIndex });
      if (error && error.code === 'SESSION_IMAGE_NOT_FOUND') {
        const clipboardItem = createInputItem({
          inputId: item.inputId,
          index: nextIndex,
          prompt: item.prompt,
          source: { kind: 'clipboard' },
        });
        expanded.push(clipboardItem);
        allItems.push(clipboardItem);
        context.stateTracker.start(clipboardItem.inputId, {
          inputId: clipboardItem.inputId, index: clipboardItem.index,
        });
      } else {
        allItems.push(failedItem);
        context.stateTracker.start(failedItem.inputId, {
          inputId: failedItem.inputId, index: failedItem.index,
        });
        context.stateTracker.transition(failedItem.inputId, 'failed');
        failures.push(inputFailure(failedItem, error, 'discovery'));
      }
      nextIndex += 1;
    }
  }
  return { items: expanded, allItems, failures, cleanupTokens };
}

function acquisitionKey(item) {
  const { source } = item;
  if (source.kind === 'clipboard') return 'clipboard';
  return JSON.stringify({ kind: source.kind, value: source.value, client: source.client });
}

function cloneAcquiredForInput(acquired, item, cleanupToken) {
  return Object.freeze({
    inputItem: item,
    image: acquired.image,
    cleanupToken: cleanupToken || acquired.cleanupToken,
    alreadyStandardized: acquired.alreadyStandardized,
  });
}

async function acquireDiscovered(context, discovered) {
  const acquisitions = new Map();
  const settled = await mapSettledBounded(discovered.items, async (item) => {
    const key = acquisitionKey(item);
    if (!acquisitions.has(key)) {
      acquisitions.set(key, acquireInputItem(item, {
        ...context.inputOptions,
        cleanupToken: discovered.cleanupTokens.get(item.inputId),
      }));
    }
    const acquired = await acquisitions.get(key);
    return acquired.inputItem.inputId === item.inputId
      ? acquired
      : cloneAcquiredForInput(acquired, item, discovered.cleanupTokens.get(item.inputId));
  }, context.acquireConcurrency);
  const acquired = [];
  const failures = [...discovered.failures];
  settled.forEach((entry, index) => {
    const item = discovered.items[index];
    if (entry.status === 'fulfilled') {
      acquired.push(entry.value);
      context.stateTracker.transition(item.inputId, 'acquired');
    } else {
      context.stateTracker.transition(item.inputId, 'failed');
      failures.push(inputFailure(
        item,
        entry.reason,
        context.inputOptions && context.inputOptions.standardizeImpl ? 'standardize' : 'acquire',
      ));
    }
  });
  return { acquired, failures };
}

async function standardizeAcquiredInputs(context, acquisition) {
  const settled = await mapSettledBounded(acquisition.acquired, (acquired) => (
    standardizeAcquired(acquired, context.inputOptions)
  ), context.acquireConcurrency);
  const assets = [];
  const failures = [...acquisition.failures];
  settled.forEach((entry, index) => {
    const item = acquisition.acquired[index].inputItem;
    if (entry.status === 'fulfilled') {
      assets.push(entry.value);
      context.stateTracker.transition(item.inputId, 'standardized');
    } else {
      context.stateTracker.transition(item.inputId, 'failed');
      failures.push(inputFailure(item, entry.reason, 'standardize'));
    }
  });
  return { assets, failures };
}

async function executeJobs(context, jobs, itemsByIndex) {
  const baseRunSingleImage = context.runSingleImage || defaultRunSingleImage;
  for (const job of jobs) {
    for (const index of job.originalIndexes) {
      context.stateTracker.transition(itemsByIndex.get(index).inputId, 'queued');
    }
  }
  return runBatch(jobs, {
    concurrency: context.concurrency,
    runSingleImage: async (job, options) => {
      const inputIds = job.originalIndexes.map((index) => itemsByIndex.get(index).inputId);
      for (const inputId of inputIds) context.stateTracker.transition(inputId, 'running');
      try {
        const result = await baseRunSingleImage(job, {
          ...options,
          onStatus: (event) => context.emitStatus({ ...event, jobId: job.jobId, inputIds }),
        });
        for (const inputId of inputIds) context.stateTracker.transition(inputId, result.status);
        return result;
      } catch (error) {
        for (const inputId of inputIds) context.stateTracker.transition(inputId, 'failed');
        throw error;
      }
    },
    singleImageOptions: {
      credentials: context.credentials,
      adapters: context.adapters,
      fetchImpl: context.fetchImpl,
      healthStore: context.healthStore,
      onStatus: context.emitStatus,
      providerScheduler: context.providerScheduler,
      describeImpl: context.describeImpl,
    },
  });
}

function acquisitionUseCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const key = acquisitionKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function createCanonicalJob(asset, jobId) {
  return createImageJob({
    jobId,
    canonicalAsset: asset,
    aliases: [asset.inputId],
    prompt: asset.prompt,
    originalIndexes: [asset.index],
    cleanupTokens: asset.cleanupToken ? [asset.cleanupToken] : [],
    cleanupEntries: asset.cleanupToken
      ? [{ inputId: asset.inputId, token: asset.cleanupToken }]
      : [],
  });
}

function scheduleEnvelope(context, envelope, taskQueue) {
  const baseRunSingleImage = context.runSingleImage || defaultRunSingleImage;
  let markStarted;
  envelope.started = new Promise((resolve) => { markStarted = resolve; });
  envelope.resultPromise = taskQueue.run(async () => {
    const job = envelope.job;
    markStarted();
    try {
      return await baseRunSingleImage(job, {
        credentials: context.credentials,
        adapters: context.adapters,
        fetchImpl: context.fetchImpl,
        healthStore: context.healthStore,
        onStatus: (event) => context.emitStatus({
          ...event,
          jobId: envelope.jobId,
          inputIds: [...envelope.aliases],
        }),
        providerScheduler: context.providerScheduler,
        describeImpl: context.describeImpl,
        signal: context.signal,
      });
    } catch (error) {
      if (isBatchCancelled(error) || context.signal.aborted) throw cancellationError(context.signal, error);
      return failedImageResult(job, error, 'runner');
    }
  }).then((result) => {
    envelope.result = result;
    return result;
  }).finally(() => {
    envelope.release();
    if (context.onBufferRelease) context.onBufferRelease(envelope);
  });
}

function trackAliasLifecycle(context, item, envelope) {
  context.stateTracker.transition(item.inputId, 'queued');
  return (async () => {
    await envelope.started;
    context.stateTracker.transition(item.inputId, 'running');
    const result = await envelope.resultPromise;
    context.stateTracker.transition(item.inputId, result.status);
    return result;
  })();
}

async function executeStreamingWindow(context, discovered) {
  throwIfCancelled(context.signal);
  enforceBatchSize(discovered.items, context.maxBatchItems);
  const taskQueue = createBoundedTaskQueue(context.concurrency, { signal: context.signal });
  const acquisitions = new Map();
  const remainingUses = acquisitionUseCounts(discovered.items);
  const envelopes = new Map();
  const mappings = new Map();
  const failures = [...discovered.failures];
  const aliasLifecycles = [];

  const settled = await mapSettledBounded(discovered.items, async (item) => {
    throwIfCancelled(context.signal);
    const key = acquisitionKey(item);
    let acquisition = acquisitions.get(key);
    if (!acquisition) {
      acquisition = {
        promise: acquireInputItem(item, {
          ...context.inputOptions,
          signal: context.signal,
          resolverOptions: {
            ...(context.inputOptions && context.inputOptions.resolverOptions),
            signal: context.signal,
          },
          cleanupToken: discovered.cleanupTokens.get(item.inputId),
        }),
      };
      acquisitions.set(key, acquisition);
    }

    let acquired;
    const releaseAcquisition = () => {
      const remaining = remainingUses.get(key) - 1;
      remainingUses.set(key, remaining);
      if (remaining === 0) {
        acquisition.promise = null;
        acquisitions.delete(key);
      }
    };
    try {
      const shared = await acquisition.promise;
      acquired = shared.inputItem.inputId === item.inputId
        ? shared
        : cloneAcquiredForInput(shared, item, discovered.cleanupTokens.get(item.inputId));
      context.stateTracker.transition(item.inputId, 'acquired');
    } catch (error) {
      if (isBatchCancelled(error) || context.signal.aborted) throw cancellationError(context.signal, error);
      context.stateTracker.transition(item.inputId, 'failed');
      releaseAcquisition();
      return { failure: inputFailure(
        item,
        error,
        context.inputOptions && context.inputOptions.standardizeImpl ? 'standardize' : 'acquire',
      ) };
    }

    try {
      const asset = await standardizeAcquired(acquired, context.inputOptions);
      context.stateTracker.transition(item.inputId, 'standardized');
      const jobId = jobIdentity(asset);
      let envelope = envelopes.get(jobId);
      if (!envelope) {
        envelope = new ExecutionEnvelope({
          jobId,
          canonicalInputId: asset.inputId,
          job: createCanonicalJob(asset, jobId),
        });
        envelopes.set(jobId, envelope);
      }
      const aliasIndex = envelope.addAlias(asset);
      context.stateTracker.transition(item.inputId, 'deduplicated');
      mappings.set(item.index, { aliasIndex, envelope });
      if (!envelope.resultPromise) scheduleEnvelope(context, envelope, taskQueue);
      const lifecycle = trackAliasLifecycle(context, item, envelope);
      lifecycle.catch(() => {});
      aliasLifecycles.push(lifecycle);
      return { mapping: mappings.get(item.index) };
    } catch (error) {
      if (isBatchCancelled(error) || context.signal.aborted) throw cancellationError(context.signal, error);
      context.stateTracker.transition(item.inputId, 'failed');
      return { failure: inputFailure(item, error, 'standardize') };
    } finally {
      releaseAcquisition();
    }
  }, context.acquireConcurrency, { signal: context.signal });

  for (const entry of settled) {
    if (entry.status === 'rejected') throw entry.reason;
    if (entry.value.failure) failures.push(entry.value.failure);
  }
  await Promise.all(aliasLifecycles);
  return { envelopes: [...envelopes.values()], failures, mappings };
}

function retainStreamingRetryableFiles(context, envelopes) {
  const retainedInputIds = new Set();
  const retryReferences = new Map();
  for (const envelope of envelopes) {
    if (!envelope.result || envelope.result.status !== 'failed' || !envelope.result.error.retryable) continue;
    for (const { inputId, token } of envelope.cleanupEntries) {
      context.transaction.retain(token);
      const reference = context.transaction.retryReference(token);
      retainedInputIds.add(inputId);
      if (reference) retryReferences.set(inputId, reference);
    }
  }
  return { retainedInputIds, retryReferences };
}

function mapStreamingResults(allItems, execution, retryReferences = new Map()) {
  const failureByIndex = new Map();
  for (const failure of execution.failures) {
    for (const index of failure.originalIndexes) failureByIndex.set(index, failure);
  }
  return [...allItems]
    .sort((left, right) => left.index - right.index)
    .map((item) => {
      const failure = failureByIndex.get(item.index);
      if (failure) return publicResult(item, failure);
      const mapping = execution.mappings.get(item.index);
      if (!mapping || !mapping.envelope.result) {
        return publicResult(item, inputFailure(item, new Error('No execution result corresponds to this input'), 'mapping'));
      }
      return publicResult(item, mapping.envelope.result, {
        canonicalJobId: mapping.envelope.jobId,
        canonicalInputId: mapping.envelope.canonicalInputId,
        deduplicated: mapping.aliasIndex > 0,
        retry: retryReferences.get(item.inputId),
      });
    });
}

function retainRetryableFiles(context, jobs, results) {
  const retainedInputIds = new Set();
  const retryReferences = new Map();
  for (const result of results) {
    if (result.status !== 'failed' || !result.error.retryable) continue;
    const job = jobs.find(({ jobId }) => jobId === result.jobId);
    const tokens = [...new Set(job ? job.cleanupTokens : [])];
    for (const token of tokens) context.transaction.retain(token);
    if (job && job.cleanupEntries.length) {
      for (const { inputId, token } of job.cleanupEntries) {
        const reference = context.transaction.retryReference(token);
        retainedInputIds.add(inputId);
        if (reference) retryReferences.set(inputId, reference);
      }
    }
  }
  return { retainedInputIds, retryReferences };
}

function publicResult(item, result, details = {}) {
  const retry = details.retry || null;
  return Object.freeze({
    inputId: item.inputId,
    index: item.index,
    canonicalJobId: details.canonicalJobId || result.jobId,
    canonicalInputId: details.canonicalInputId || item.inputId,
    deduplicated: details.deduplicated === true,
    status: result.status,
    text: result.text,
    error: result.error,
    retryPath: retry && retry.retryPath,
    retryExpiresAt: retry && retry.retryExpiresAt,
    originalIndexes: Object.freeze([item.index]),
  });
}

function mapResultsToInputs(allItems, jobs, results, failures, retryReferences = new Map()) {
  const resultByJob = new Map(results.map((result) => [result.jobId, result]));
  const failureByIndex = new Map();
  for (const failure of failures) {
    for (const index of failure.originalIndexes) failureByIndex.set(index, failure);
  }
  const jobByIndex = new Map();
  for (const job of jobs) {
    job.originalIndexes.forEach((index, aliasIndex) => {
      jobByIndex.set(index, { job, aliasIndex });
    });
  }

  return [...allItems]
    .sort((left, right) => left.index - right.index)
    .map((item) => {
      const failure = failureByIndex.get(item.index);
      if (failure) return publicResult(item, failure);
      const mapping = jobByIndex.get(item.index);
      if (!mapping) {
        return publicResult(item, inputFailure(item, new Error('No execution result corresponds to this input'), 'mapping'));
      }
      const result = resultByJob.get(mapping.job.jobId);
      return publicResult(item, result, {
        canonicalJobId: mapping.job.jobId,
        canonicalInputId: mapping.job.aliases[0],
        deduplicated: mapping.aliasIndex > 0,
        retry: retryReferences.get(item.inputId),
      });
    });
}

async function executeBatch(manifest, options = {}) {
  const maxBatchItems = options.context && options.context.maxBatchItems
    ? options.context.maxBatchItems
    : resolveResourceLimits(options).maxBatchItems;
  enforceBatchSize(manifest.items, maxBatchItems);
  const context = options.context || await createBatchExecutionContext(manifest, options);
  let completed = false;
  try {
    throwIfCancelled(context.signal);
    const discovered = await discoverInputs(context, manifest.items);
    const execution = await executeStreamingWindow(context, discovered);
    const retention = retainStreamingRetryableFiles(context, execution.envelopes);
    const publicResults = mapStreamingResults(discovered.allItems, execution, retention.retryReferences);
    for (const item of discovered.allItems) {
      const state = context.stateTracker.stateOf(item.inputId);
      if (state === 'succeeded') context.stateTracker.transition(item.inputId, 'cleaned');
      else if (state === 'failed') {
        context.stateTracker.transition(
          item.inputId,
          retention.retainedInputIds.has(item.inputId) ? 'retained' : 'cleaned',
        );
      }
    }
    context.close();
    completed = true;
    return publicResults;
  } catch (error) {
    if (context.signal && context.signal.aborted) throw cancellationError(context.signal, error);
    throw error;
  } finally {
    if (!completed) context.rollback();
  }
}

module.exports = {
  discoverInputs,
  acquireDiscovered,
  acquisitionKey,
  cloneAcquiredForInput,
  executeBatch,
  executeJobs,
  executeStreamingWindow,
  inputFailure,
  mapResultsToInputs,
  mapStreamingResults,
  publicResult,
  retainRetryableFiles,
  retainStreamingRetryableFiles,
  standardizeAcquiredInputs,
};
