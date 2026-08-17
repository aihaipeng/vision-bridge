const { ProviderError } = require('../errors');
const { parseConcurrency } = require('./batch_runner');
const { cancellationError, throwIfCancelled } = require('./cancellation');

function providerLevelFailure(error) {
  if (!(error instanceof ProviderError)) return false;
  if (error.scope === 'provider' || error.code === 'PROVIDER_UNAVAILABLE') return true;
  return error.failures.some(({ scope }) => scope === 'provider');
}

class ProviderScheduler {
  constructor(options = {}) {
    this.defaultLimit = parseConcurrency(options.defaultLimit, 1);
    this.limits = options.limits || {};
    this.active = new Map();
    this.queues = new Map();
    this.blocked = new Map();
    this.leaseManager = options.leaseManager || null;
  }

  limitFor(provider) {
    return parseConcurrency(this.limits[provider], this.defaultLimit);
  }

  async acquire(provider, signal) {
    throwIfCancelled(signal);
    const active = this.active.get(provider) || 0;
    if (active < this.limitFor(provider)) {
      this.active.set(provider, active + 1);
      return;
    }
    await new Promise((resolve, reject) => {
      if (!this.queues.has(provider)) this.queues.set(provider, []);
      const queue = this.queues.get(provider);
      const entry = { resolve, reject, signal, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(cancellationError(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      queue.push(entry);
    });
  }

  release(provider) {
    const queue = this.queues.get(provider);
    if (queue && queue.length) {
      const entry = queue.shift();
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      entry.resolve();
      return;
    }
    this.active.set(provider, Math.max(0, (this.active.get(provider) || 1) - 1));
  }

  blockedError(provider) {
    const reason = this.blocked.get(provider);
    return new ProviderError(
      provider,
      'BATCH_PROVIDER_SKIPPED',
      `${provider} already had a Provider-level failure in this batch; skipping duplicate waiting requests: ${reason.message}`,
      { scope: 'provider' },
    );
  }

  async run(provider, task, options = {}) {
    throwIfCancelled(options.signal);
    if (this.blocked.has(provider)) {
      if (options.onStatus) options.onStatus({
        type: 'provider_batch_skipped',
        provider,
        code: this.blocked.get(provider).code,
        message: this.blocked.get(provider).message,
      });
      throw this.blockedError(provider);
    }
    await this.acquire(provider, options.signal);
    try {
      throwIfCancelled(options.signal);
      if (this.blocked.has(provider)) {
        if (options.onStatus) options.onStatus({
          type: 'provider_batch_skipped',
          provider,
          code: this.blocked.get(provider).code,
          message: this.blocked.get(provider).message,
        });
        throw this.blockedError(provider);
      }
      try {
        const invoke = () => task(options.signal);
        return this.leaseManager
          ? await this.leaseManager.run(provider, invoke, { signal: options.signal })
          : await invoke();
      } catch (error) {
        if (providerLevelFailure(error)) {
          this.blocked.set(provider, Object.freeze({
            code: error.code || 'PROVIDER_UNAVAILABLE',
            message: error.message || String(error),
          }));
        }
        throw error;
      }
    } finally {
      this.release(provider);
    }
  }
}

function createProviderScheduler(options) {
  return new ProviderScheduler(options);
}

module.exports = { ProviderScheduler, createProviderScheduler, providerLevelFailure };
