const fs = require('fs');
const os = require('os');
const path = require('path');

const RETRY_CACHE_PREFIX = 'vision_bridge_retry_';
const TRANSACTION_PREFIX = 'vision_bridge_txn_';
const RETRY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function retryHint(retryPath) {
  return retryPath ? ` The image is cached at ${retryPath}. After configuring a local Key and passing doctor, retry with this path; do not read the clipboard again.` : '';
}

function extensionForMime(mime) {
  return {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
    'image/svg+xml': '.svg',
  }[mime] || '.img';
}

function createRetryCache(image) {
  const filePath = path.join(os.tmpdir(), `${RETRY_CACHE_PREFIX}${Date.now()}_${process.pid}${extensionForMime(image.mime)}`);
  fs.writeFileSync(filePath, image.data);
  return filePath;
}

function cleanupRetryCaches(now = Date.now(), maxAgeMs = RETRY_CACHE_MAX_AGE_MS, prefix = RETRY_CACHE_PREFIX) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const filePath = path.join(os.tmpdir(), entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      // Cache cleanup is best-effort and must not block image recognition.
    }
  }
  return removed;
}

function existingRetryCache(input) {
  if (!input || input.length > 1024) return null;
  const resolved = path.resolve(input);
  return path.dirname(resolved) === path.resolve(os.tmpdir())
    && path.basename(resolved).startsWith(RETRY_CACHE_PREFIX)
    && fs.existsSync(resolved) ? resolved : null;
}

function safeFileName(value) {
  const name = path.basename(String(value || 'image.img')).replace(/[^A-Za-z0-9._-]/g, '_');
  return name || 'image.img';
}

function createTempFileTransaction(options = {}) {
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const prefix = options.prefix || TRANSACTION_PREFIX;
  const directory = fs.mkdtempSync(path.join(tempRoot, prefix));
  const files = new Map();
  const retained = new Set();
  let sequence = 0;
  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error('Temporary-file transaction is closed');
  }

  function write(data, fileName = 'image.img') {
    ensureOpen();
    if (!Buffer.isBuffer(data)) throw new TypeError('Temporary-file content must be a Buffer');
    sequence += 1;
    const outputPath = path.join(directory, `${sequence}_${safeFileName(fileName)}`);
    fs.writeFileSync(outputPath, data, { mode: 0o600 });
    const token = Object.freeze({ transaction: path.basename(directory), id: sequence });
    files.set(token, outputPath);
    return Object.freeze({ path: outputPath, cleanupToken: token });
  }

  function retain(token) {
    ensureOpen();
    if (files.has(token)) retained.add(token);
  }

  function retryReference(token, now = Date.now(), maxAgeMs = RETRY_CACHE_MAX_AGE_MS) {
    ensureOpen();
    if (!retained.has(token) || !files.has(token)) return null;
    return Object.freeze({
      retryPath: files.get(token),
      retryExpiresAt: new Date(now + maxAgeMs).toISOString(),
    });
  }

  function close() {
    if (closed) return { removed: 0, retained: retained.size };
    let removed = 0;
    for (const [token, filePath] of files) {
      if (retained.has(token)) continue;
      try {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      } catch {
        // Final cleanup is best-effort; stale transaction cleanup handles leftovers.
      }
    }
    try {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      // A retained or externally locked file keeps the transaction directory alive.
    }
    closed = true;
    return { removed, retained: retained.size };
  }

  function rollback() {
    if (!closed) fs.rmSync(directory, { recursive: true, force: true });
    closed = true;
  }

  return Object.freeze({ directory, close, retain, retryReference, rollback, write });
}

function cleanupExpiredTransactions(now = Date.now(), maxAgeMs = RETRY_CACHE_MAX_AGE_MS, options = {}) {
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const prefix = options.prefix || TRANSACTION_PREFIX;
  let removed = 0;
  if (!fs.existsSync(tempRoot)) return removed;
  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const directory = path.resolve(tempRoot, entry.name);
    if (path.dirname(directory) !== tempRoot) continue;
    try {
      if (fs.statSync(directory).mtimeMs > now - maxAgeMs) continue;
      fs.rmSync(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Expiry cleanup must not block recognition.
    }
  }
  return removed;
}

module.exports = {
  RETRY_CACHE_MAX_AGE_MS,
  RETRY_CACHE_PREFIX,
  TRANSACTION_PREFIX,
  cleanupExpiredTransactions,
  cleanupRetryCaches,
  createTempFileTransaction,
  createRetryCache,
  existingRetryCache,
  extensionForMime,
  retryHint,
};
