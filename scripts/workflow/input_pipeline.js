const crypto = require('crypto');
const { resolveImageInput, standardizeImageInput } = require('../image_input_resolver');
const { canonicalizeImage, readImageDimensions } = require('../image_preparer');
const { createImageAsset } = require('./contracts');
const { throwIfCancelled } = require('./cancellation');

function resolverValueForSource(source) {
  if (source.kind === 'clipboard') return 'clipboard';
  if (source.kind === 'session_attachment' && !source.value) {
    throw new TypeError('A session attachment must first be recovered to an exact file path');
  }
  return source.value;
}

function contentHash(data) {
  if (!Buffer.isBuffer(data)) throw new TypeError('contentHash accepts only a Buffer');
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function standardizeInputItem(inputItem, options = {}) {
  throwIfCancelled(options.signal);
  if (!options.standardizeImpl) {
    return standardizeAcquired(await acquireInputItem(inputItem, options), options);
  }
  const standardizeImpl = options.standardizeImpl || standardizeImageInput;
  const dimensionsImpl = options.dimensionsImpl || readImageDimensions;
  const standardized = await standardizeImpl(resolverValueForSource(inputItem.source), options.resolverOptions);
  throwIfCancelled(options.signal);
  const { width, height } = await dimensionsImpl(standardized);
  return createImageAsset({
    ...inputItem,
    data: standardized.data,
    mime: standardized.mime,
    width,
    height,
    contentHash: contentHash(standardized.data),
    cleanupToken: options.cleanupToken || null,
  });
}

async function acquireInputItem(inputItem, options = {}) {
  throwIfCancelled(options.signal);
  if (options.standardizeImpl) {
    const image = await options.standardizeImpl(
      resolverValueForSource(inputItem.source),
      options.resolverOptions,
    );
    throwIfCancelled(options.signal);
    return Object.freeze({
      inputItem,
      image,
      cleanupToken: options.cleanupToken || null,
      alreadyStandardized: true,
    });
  }
  const resolveImpl = options.resolveImpl || resolveImageInput;
  const image = await resolveImpl(resolverValueForSource(inputItem.source), options.resolverOptions);
  throwIfCancelled(options.signal);
  return Object.freeze({ inputItem, image, cleanupToken: options.cleanupToken || null });
}

async function standardizeAcquired(acquired, options = {}) {
  throwIfCancelled(options.signal);
  const canonicalizeImpl = options.canonicalizeImpl || canonicalizeImage;
  const dimensionsImpl = options.dimensionsImpl || readImageDimensions;
  const standardized = acquired.alreadyStandardized
    ? acquired.image
    : await canonicalizeImpl(acquired.image, { signal: options.signal });
  throwIfCancelled(options.signal);
  const { width, height } = await dimensionsImpl(standardized);
  return createImageAsset({
    ...acquired.inputItem,
    data: standardized.data,
    mime: standardized.mime,
    width,
    height,
    contentHash: contentHash(standardized.data),
    cleanupToken: acquired.cleanupToken,
  });
}

module.exports = {
  acquireInputItem,
  contentHash,
  resolverValueForSource,
  standardizeAcquired,
  standardizeInputItem,
};
