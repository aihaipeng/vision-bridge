const { createHealthStore } = require('../model_health');
const {
  cleanupExpiredTransactions,
  createTempFileTransaction,
} = require('../storage/temp_files');
const { DEFAULT_BATCH_CONCURRENCY, parseConcurrency } = require('./batch_runner');
const { runBatchPreflight } = require('./preflight');
const { createProviderScheduler } = require('./provider_scheduler');
const { createProviderLeaseManager } = require('./provider_lease');
const { enforceBatchSize, resolveResourceLimits } = require('./resource_limits');
const { createStatusEmitter } = require('./status_events');
const { StateTracker } = require('./state_tracker');
const {
  cancellationError,
  createBatchCancellation,
  throwIfCancelled,
} = require('./cancellation');

const DEFAULT_PROVIDER_CONCURRENCY = 1;

class BatchExecutionContext {
  constructor(options) {
    Object.assign(this, options);
    this.closed = false;
  }

  close() {
    if (this.closed) return this.cleanupSummary;
    this.cleanupSummary = this.transaction.close();
    this.cancellation.dispose();
    this.closed = true;
    return this.cleanupSummary;
  }

  rollback() {
    if (!this.closed) this.transaction.rollback();
    this.cancellation.dispose();
    this.closed = true;
  }

  toJSON() {
    return {
      concurrency: this.concurrency,
      acquireConcurrency: this.acquireConcurrency,
      maxBatchItems: this.maxBatchItems,
      providerConcurrency: this.providerConcurrency,
      diagnostics: this.diagnostics,
    };
  }
}

async function createBatchExecutionContext(manifest, options = {}) {
  const resourceLimits = resolveResourceLimits(options);
  enforceBatchSize(manifest.items, resourceLimits.maxBatchItems);
  const cancellation = createBatchCancellation(options);
  let preflight;
  try {
    throwIfCancelled(cancellation.signal);
    const preflightImpl = options.preflightImpl || runBatchPreflight;
    preflight = await preflightImpl({ credentials: options.credentials, signal: cancellation.signal });
    throwIfCancelled(cancellation.signal);
  } catch (error) {
    cancellation.dispose();
    if (cancellation.signal.aborted) throw cancellationError(cancellation.signal, error);
    throw error;
  }
  const cleanupImpl = options.cleanupExpiredImpl || cleanupExpiredTransactions;
  cleanupImpl(Date.now(), undefined, options.transactionOptions);

  const concurrency = parseConcurrency(
    options.concurrency ?? manifest.concurrency ?? process.env.VISION_BRIDGE_CONCURRENCY,
    DEFAULT_BATCH_CONCURRENCY,
  );
  const providerConcurrency = parseConcurrency(
    options.providerConcurrency
      ?? manifest.providerConcurrency
      ?? process.env.VISION_BRIDGE_PROVIDER_CONCURRENCY,
    DEFAULT_PROVIDER_CONCURRENCY,
  );
  const transactionFactory = options.transactionFactory || createTempFileTransaction;
  const healthStoreFactory = options.healthStoreFactory || createHealthStore;
  const providerSchedulerFactory = options.providerSchedulerFactory || createProviderScheduler;
  const providerLeaseManagerFactory = options.providerLeaseManagerFactory || createProviderLeaseManager;
  const providerLeaseManager = options.providerLeaseManager
    || providerLeaseManagerFactory(options.providerLeaseOptions);
  const emitStatus = options.emitStatus || createStatusEmitter(options.onStatus);
  const stateTracker = options.stateTracker || new StateTracker(emitStatus);

  return new BatchExecutionContext({
    adapters: options.adapters,
    acquireConcurrency: resourceLimits.acquireConcurrency,
    cancellation,
    concurrency,
    credentials: preflight.credentials,
    describeImpl: options.describeImpl,
    diagnostics: preflight.diagnostics || Object.freeze({}),
    fetchImpl: options.fetchImpl,
    healthStore: options.healthStore || healthStoreFactory(),
    inputOptions: options.inputOptions,
    emitStatus,
    onStatus: options.onStatus,
    onBufferRelease: options.onBufferRelease,
    maxBatchItems: resourceLimits.maxBatchItems,
    providerConcurrency,
    providerScheduler: options.providerScheduler || providerSchedulerFactory({
      defaultLimit: providerConcurrency,
      leaseManager: providerLeaseManager,
      limits: options.providerConcurrencyLimits,
    }),
    providerLeaseManager,
    recoverImpl: options.recoverImpl,
    runSingleImage: options.runSingleImage,
    stateTracker,
    signal: cancellation.signal,
    transaction: options.transaction || transactionFactory(options.transactionOptions),
  });
}

module.exports = {
  BatchExecutionContext,
  DEFAULT_PROVIDER_CONCURRENCY,
  createBatchExecutionContext,
};
