const { CliError } = require('../errors');

class BatchCancelledError extends CliError {
  constructor(message = 'Batch cancelled', cause) {
    super('BATCH_CANCELLED', message, 1, cause);
    this.name = 'BatchCancelledError';
  }
}

function cancellationError(signal, cause) {
  if (cause instanceof BatchCancelledError) return cause;
  const reason = signal && signal.reason;
  const detail = reason && (reason.message || reason);
  return new BatchCancelledError(detail ? `Batch cancelled: ${detail}` : 'Batch cancelled', cause);
}

function isBatchCancelled(error) {
  return error instanceof BatchCancelledError || error && error.code === 'BATCH_CANCELLED';
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) throw cancellationError(signal);
}

function parseBatchTimeoutMs(value = process.env.VISION_BRIDGE_BATCH_TIMEOUT_MS) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliError(
      'CONFIGURATION',
      `Invalid VISION_BRIDGE_BATCH_TIMEOUT_MS configuration: ${String(value)}; expected a positive integer number of milliseconds`,
      2,
    );
  }
  return parsed;
}

function createBatchCancellation(options = {}) {
  const externalSignal = options.signal;
  const timeoutMs = parseBatchTimeoutMs(options.batchTimeoutMs);
  const controller = new AbortController();
  let timer = null;
  let externalListener = null;

  if (externalSignal) {
    externalListener = () => controller.abort(externalSignal.reason);
    if (externalSignal.aborted) externalListener();
    else externalSignal.addEventListener('abort', externalListener, { once: true });
  }
  if (timeoutMs !== null) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Batch deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  function dispose() {
    if (timer) clearTimeout(timer);
    if (externalSignal && externalListener) {
      externalSignal.removeEventListener('abort', externalListener);
    }
  }

  return Object.freeze({ signal: controller.signal, timeoutMs, dispose });
}

module.exports = {
  BatchCancelledError,
  cancellationError,
  createBatchCancellation,
  isBatchCancelled,
  parseBatchTimeoutMs,
  throwIfCancelled,
};
