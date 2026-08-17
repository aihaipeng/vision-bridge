const { describeWithProviders } = require('../providers/router');
const { createImageResult, createWorkflowError } = require('./contracts');
const { cleanResultText } = require('./result_formatter');

const RETRYABLE_CODES = new Set(['NETWORK_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED']);

function providerWorkflowError(error) {
  const code = error && error.code ? error.code : 'PROVIDERS_FAILED';
  return createWorkflowError({
    stage: 'provider',
    code,
    message: String(error && (error.message || error) || 'Vision Provider call failed'),
    retryable: error && error.retryable === true || RETRYABLE_CODES.has(code),
    scope: 'image',
  });
}

function failedImageResult(job, error, stage = 'provider') {
  const workflowError = stage === 'provider'
    ? providerWorkflowError(error)
    : createWorkflowError({
      stage,
      code: error && error.code ? error.code : 'UNEXPECTED',
      message: String(error && (error.message || error) || 'Image task execution failed'),
      retryable: error && error.retryable === true,
      scope: 'image',
    });
  return createImageResult({
    jobId: job.jobId,
    status: 'failed',
    error: workflowError,
    originalIndexes: job.originalIndexes,
  });
}

async function runSingleImage(job, options = {}) {
  const describeImpl = options.describeImpl || describeWithProviders;
  try {
    const result = await describeImpl({
      image: job.canonicalAsset,
      prompt: job.prompt,
      credentials: options.credentials,
      adapters: options.adapters,
      fetchImpl: options.fetchImpl,
      healthStore: options.healthStore,
      onStatus: options.onStatus,
      providerScheduler: options.providerScheduler,
      signal: options.signal,
    });
    return createImageResult({
      jobId: job.jobId,
      status: 'succeeded',
      text: cleanResultText(result.text),
      provider: result.provider,
      model: result.model,
      originalIndexes: job.originalIndexes,
    });
  } catch (error) {
    return failedImageResult(job, error);
  }
}

module.exports = { RETRYABLE_CODES, failedImageResult, providerWorkflowError, runSingleImage };
