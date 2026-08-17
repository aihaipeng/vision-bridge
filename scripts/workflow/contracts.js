const SOURCE_KINDS = new Set([
  'local_path',
  'file_url',
  'http_url',
  'clipboard',
  'session_attachment',
]);
const CANONICAL_MIMES = new Set(['image/jpeg', 'image/png']);
const SESSION_CLIENTS = new Set(['claude', 'opencode']);
const RESULT_STATUSES = new Set(['succeeded', 'failed']);

class WorkflowContractError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'WorkflowContractError';
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowContractError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireIndex(value, field = 'index') {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowContractError(`${field} must be a non-negative integer`);
  }
  return value;
}

function createSource(source) {
  if (!source || !SOURCE_KINDS.has(source.kind)) {
    throw new WorkflowContractError(`source.kind must be one of: ${[...SOURCE_KINDS].join(', ')}`);
  }
  if (source.kind !== 'clipboard' && source.kind !== 'session_attachment') {
    requireNonEmptyString(source.value, 'source.value');
  }
  if (source.kind === 'session_attachment') {
    requireNonEmptyString(source.client, 'source.client');
    if (!SESSION_CLIENTS.has(source.client)) {
      throw new WorkflowContractError('source.client accepts only claude or opencode');
    }
  }
  return Object.freeze({
    kind: source.kind,
    value: source.value,
    client: source.client,
    cwd: source.cwd,
    sessionId: source.sessionId,
    maxAgeMinutes: source.maxAgeMinutes,
  });
}

function createInputItem({ inputId, index, prompt, source }) {
  return Object.freeze({
    inputId: requireNonEmptyString(inputId, 'inputId'),
    index: requireIndex(index),
    prompt: requireNonEmptyString(prompt, 'prompt'),
    source: createSource(source),
  });
}

function createImageAsset({
  inputId,
  index,
  prompt,
  source,
  data,
  mime,
  width,
  height,
  contentHash,
  cleanupToken = null,
}) {
  if (!Buffer.isBuffer(data)) throw new WorkflowContractError('data must be a Buffer');
  if (!CANONICAL_MIMES.has(mime)) throw new WorkflowContractError('mime must be image/jpeg or image/png');
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new WorkflowContractError('width and height must be positive integers');
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash || '')) {
    throw new WorkflowContractError('contentHash must be a SHA-256 hexadecimal string');
  }
  return Object.freeze({
    inputId: requireNonEmptyString(inputId, 'inputId'),
    index: requireIndex(index),
    prompt: requireNonEmptyString(prompt, 'prompt'),
    source: createSource(source),
    data,
    mime,
    width,
    height,
    contentHash,
    cleanupToken,
  });
}

function createImageJob({
  jobId,
  canonicalAsset,
  aliases,
  prompt,
  originalIndexes,
  cleanupTokens = [],
  cleanupEntries = [],
}) {
  if (!canonicalAsset || !Buffer.isBuffer(canonicalAsset.data)) {
    throw new WorkflowContractError('canonicalAsset must be an ImageAsset');
  }
  if (!Array.isArray(aliases) || aliases.length === 0) {
    throw new WorkflowContractError('aliases must be a non-empty array');
  }
  if (!Array.isArray(originalIndexes) || originalIndexes.length === 0) {
    throw new WorkflowContractError('originalIndexes must be a non-empty array');
  }
  const indexes = originalIndexes.map((value) => requireIndex(value, 'originalIndexes[]'));
  return Object.freeze({
    jobId: requireNonEmptyString(jobId, 'jobId'),
    canonicalAsset,
    aliases: Object.freeze([...aliases]),
    prompt: requireNonEmptyString(prompt, 'prompt'),
    originalIndexes: Object.freeze(indexes),
    cleanupTokens: Object.freeze(cleanupTokens.filter(Boolean)),
    cleanupEntries: Object.freeze(cleanupEntries
      .filter(({ token }) => Boolean(token))
      .map(({ inputId, token }) => Object.freeze({ inputId, token }))),
  });
}

function createWorkflowError({ stage, code, message, retryable = false, scope = 'image' }) {
  return Object.freeze({
    stage: requireNonEmptyString(stage, 'error.stage'),
    code: requireNonEmptyString(code, 'error.code'),
    message: requireNonEmptyString(message, 'error.message'),
    retryable: retryable === true,
    scope: requireNonEmptyString(scope, 'error.scope'),
  });
}

function createImageResult({
  jobId,
  status,
  text = '',
  provider = null,
  model = null,
  error = null,
  originalIndexes,
}) {
  if (!RESULT_STATUSES.has(status)) {
    throw new WorkflowContractError('status must be succeeded or failed');
  }
  if (!Array.isArray(originalIndexes) || originalIndexes.length === 0) {
    throw new WorkflowContractError('originalIndexes must be a non-empty array');
  }
  if (status === 'succeeded') {
    requireNonEmptyString(text, 'text');
    requireNonEmptyString(provider, 'provider');
    requireNonEmptyString(model, 'model');
    if (error !== null) throw new WorkflowContractError('A successful result cannot contain error');
  } else if (!error || typeof error.stage !== 'string') {
    throw new WorkflowContractError('A failed result must contain a structured error');
  }
  return Object.freeze({
    jobId: requireNonEmptyString(jobId, 'jobId'),
    status,
    text,
    provider,
    model,
    error,
    originalIndexes: Object.freeze(originalIndexes.map((value) => requireIndex(value, 'originalIndexes[]'))),
  });
}

module.exports = {
  CANONICAL_MIMES,
  RESULT_STATUSES,
  SESSION_CLIENTS,
  SOURCE_KINDS,
  WorkflowContractError,
  createImageAsset,
  createImageJob,
  createImageResult,
  createInputItem,
  createSource,
  createWorkflowError,
};
