const crypto = require('crypto');
const { createImageJob } = require('./contracts');

function jobIdentity(asset) {
  return crypto.createHash('sha256')
    .update(asset.contentHash)
    .update('\0')
    .update(asset.prompt)
    .digest('hex');
}

function deduplicateAssets(assets) {
  const groups = new Map();
  for (const asset of [...assets].sort((left, right) => left.index - right.index)) {
    const jobId = jobIdentity(asset);
    if (!groups.has(jobId)) {
      groups.set(jobId, {
        jobId,
        canonicalAsset: asset,
        aliases: [],
        prompt: asset.prompt,
        originalIndexes: [],
        cleanupTokens: [],
        cleanupEntries: [],
      });
    }
    const group = groups.get(jobId);
    group.aliases.push(asset.inputId);
    group.originalIndexes.push(asset.index);
    if (asset.cleanupToken) {
      group.cleanupTokens.push(asset.cleanupToken);
      group.cleanupEntries.push({ inputId: asset.inputId, token: asset.cleanupToken });
    }
  }
  return [...groups.values()].map(createImageJob);
}

module.exports = { deduplicateAssets, jobIdentity };
