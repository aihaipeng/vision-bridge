const fs = require('node:fs');
const path = require('node:path');
const { CliError } = require('../errors');

const DEFAULT_PROMPT = 'Describe this image in detail.';

function manifestItems(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (manifest && Array.isArray(manifest.items)) return manifest.items;
  throw new CliError('RETRY_MANIFEST', 'Original batch manifest must contain an items array', 2);
}

function resultItems(results) {
  if (Array.isArray(results)) return results;
  if (results && Array.isArray(results.results)) return results.results;
  throw new CliError('RETRY_MANIFEST', 'Batch results must be an array or an object containing a results array', 2);
}

function normalizeOriginalItems(manifest) {
  const topPrompt = manifest && !Array.isArray(manifest) && manifest.prompt;
  return manifestItems(manifest).map((item, index) => {
    if (typeof item === 'string') {
      return {
        inputId: `input-${index + 1}`,
        index,
        prompt: topPrompt || DEFAULT_PROMPT,
        input: item,
      };
    }
    return {
      inputId: item.inputId || `input-${index + 1}`,
      index,
      prompt: item.prompt || topPrompt || DEFAULT_PROMPT,
      input: item.input,
      source: item.source,
    };
  });
}

function originalForResult(originals, result) {
  const exact = originals.find(({ inputId }) => inputId === result.inputId);
  if (exact) return exact;
  const baseInputId = String(result.inputId || '').replace(/:\d+$/, '');
  return originals.find(({ inputId }) => inputId === baseInputId)
    || originals[result.index];
}

function validateRetryPath(result, now = Date.now()) {
  if (!result.retryPath) return null;
  const expiresAt = result.retryExpiresAt ? Date.parse(result.retryExpiresAt) : null;
  const retryPath = path.resolve(result.retryPath);
  let validFile = false;
  try { validFile = fs.statSync(retryPath).isFile(); } catch { validFile = false; }
  if ((expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) || !validFile) {
    throw new CliError(
      'RETRY_EXPIRED',
      `Retry file for input ${result.inputId} has expired or does not exist: ${result.retryPath}`,
      2,
    );
  }
  return retryPath;
}

function createRetryManifest(originalManifest, batchResults, options = {}) {
  const originals = normalizeOriginalItems(originalManifest);
  const failed = resultItems(batchResults).filter(({ status }) => status === 'failed');
  const items = failed.map((result) => {
    const original = originalForResult(originals, result);
    if (!original) {
      throw new CliError(
        'RETRY_MANIFEST',
        `Failed result ${result.inputId || result.index} has no corresponding input in the original manifest`,
        2,
      );
    }
    const retryPath = validateRetryPath(result, options.now ?? Date.now());
    const item = {
      inputId: result.inputId || original.inputId,
      originalIndex: Number.isInteger(result.index) ? result.index : original.index,
      prompt: original.prompt,
    };
    if (retryPath) item.input = retryPath;
    else if (original.source) item.source = { ...original.source };
    else item.input = original.input;
    return item;
  });
  return Object.freeze({
    items: Object.freeze(items.map((item) => Object.freeze(item))),
  });
}

module.exports = {
  createRetryManifest,
  normalizeOriginalItems,
  originalForResult,
  validateRetryPath,
};
