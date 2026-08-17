class ExecutionEnvelope {
  constructor({ jobId, canonicalInputId, job }) {
    this.jobId = jobId;
    this.canonicalInputId = canonicalInputId;
    this.job = job;
    this.aliases = [];
    this.cleanupEntries = [];
    this.result = null;
    this.resultPromise = null;
    this.released = false;
  }

  addAlias(asset) {
    const aliasIndex = this.aliases.length;
    this.aliases.push(asset.inputId);
    if (asset.cleanupToken) {
      this.cleanupEntries.push({ inputId: asset.inputId, token: asset.cleanupToken });
    }
    return aliasIndex;
  }

  release() {
    this.job = null;
    this.released = true;
  }

  get hasBuffer() {
    return Buffer.isBuffer(this.job && this.job.canonicalAsset && this.job.canonicalAsset.data);
  }
}

module.exports = { ExecutionEnvelope };
