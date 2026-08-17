const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { throwIfCancelled, cancellationError } = require('./cancellation');

const LEASE_DIRECTORY = 'vision_bridge_provider_leases';
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_LEASE_POLL_MS = 50;
const DEFAULT_LEASE_RENEW_MS = 20_000;

function providerLeaseName(provider) {
  const digest = crypto.createHash('sha256').update(String(provider)).digest('hex').slice(0, 24);
  return `provider_${digest}.lease`;
}

function abortableDelay(delayMs, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationError(signal));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readLease(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sameLease(left, right) {
  return Boolean(left && right)
    && left.pid === right.pid
    && left.acquiredAt === right.acquiredAt;
}

class ProviderLeaseManager {
  constructor(options = {}) {
    this.root = path.resolve(options.tempRoot || path.join(os.tmpdir(), LEASE_DIRECTORY));
    this.ttlMs = options.ttlMs || DEFAULT_LEASE_TTL_MS;
    this.pollMs = options.pollMs || DEFAULT_LEASE_POLL_MS;
    this.renewMs = options.renewMs || Math.min(DEFAULT_LEASE_RENEW_MS, Math.max(1, Math.floor(this.ttlMs / 3)));
    this.pid = options.pid || process.pid;
    this.now = options.now || Date.now;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  pathFor(provider) {
    return path.join(this.root, providerLeaseName(provider));
  }

  isStale(filePath) {
    try {
      return this.now() - fs.statSync(filePath).mtimeMs > this.ttlMs;
    } catch {
      return false;
    }
  }

  recoverStale(filePath) {
    if (!this.isStale(filePath)) return false;
    const quarantine = `${filePath}.stale.${this.pid}.${this.now()}`;
    try {
      fs.renameSync(filePath, quarantine);
      fs.rmSync(quarantine, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  tryAcquire(provider) {
    const filePath = this.pathFor(provider);
    const acquiredAt = this.now();
    const owner = Object.freeze({ pid: this.pid, acquiredAt, createdAt: acquiredAt });
    let descriptor;
    try {
      descriptor = fs.openSync(filePath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
      fs.closeSync(descriptor);
      descriptor = null;
    } catch (error) {
      if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
      if (error.code === 'EEXIST') return null;
      throw error;
    }

    let released = false;
    const renewTimer = setInterval(() => {
      if (released) return;
      if (!sameLease(readLease(filePath), owner)) return;
      try {
        const now = new Date(this.now());
        fs.utimesSync(filePath, now, now);
      } catch {
        // A lost or externally recovered lease cannot be renewed by this owner.
      }
    }, this.renewMs);
    renewTimer.unref();

    return Object.freeze({
      provider,
      path: filePath,
      owner,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(renewTimer);
        if (!sameLease(readLease(filePath), owner)) return;
        fs.rmSync(filePath, { force: true });
      },
    });
  }

  async acquire(provider, options = {}) {
    const { signal } = options;
    while (true) {
      throwIfCancelled(signal);
      const lease = this.tryAcquire(provider);
      if (lease) return lease;
      this.recoverStale(this.pathFor(provider));
      await abortableDelay(this.pollMs, signal);
    }
  }

  async run(provider, task, options = {}) {
    const lease = await this.acquire(provider, options);
    try {
      throwIfCancelled(options.signal);
      return await task();
    } finally {
      lease.release();
    }
  }
}

function createProviderLeaseManager(options) {
  return new ProviderLeaseManager(options);
}

module.exports = {
  DEFAULT_LEASE_POLL_MS,
  DEFAULT_LEASE_RENEW_MS,
  DEFAULT_LEASE_TTL_MS,
  LEASE_DIRECTORY,
  ProviderLeaseManager,
  abortableDelay,
  createProviderLeaseManager,
  providerLeaseName,
};
