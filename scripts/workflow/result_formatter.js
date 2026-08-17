const { singleLine } = require('../errors');

function verboseStatusEnabled(env = process.env) {
  return env.VISION_BRIDGE_VERBOSE === '1';
}

function statusEventVisible(event, env = process.env) {
  return event.type !== 'provider_available' || verboseStatusEnabled(env);
}

function formatStatusEvent(event, options = {}) {
  if (!statusEventVisible(event, options.env || process.env)) return '';
  if (event.type === 'provider_available') {
    return `[INFO] provider loaded: ${event.provider}`;
  }
  if (event.type === 'provider_cooldown') {
    return `[INFO] PROVIDER_COOLDOWN: ${event.provider} is in Provider-level cooldown (${Math.ceil(event.remainingMs / 1000)}s remaining, ${event.lastError}) and moves behind other Providers`;
  }
  if (event.type === 'model_cooldown') {
    const items = event.entries
      .map(({ model, remainingMs, lastError }) => `${model} (${Math.ceil(remainingMs / 1000)}s remaining, ${lastError})`)
      .join(', ');
    return `[INFO] MODEL_COOLDOWN: cooling models in the ${event.provider} pool move to the end: ${items}`;
  }
  if (event.type === 'provider_skipped') {
    return `[INFO] PROVIDER_SKIPPED: ${event.provider} is missing ${event.envName} and will not enter this polling cycle`;
  }
  if (event.type === 'provider_switch') {
    const target = event.model ? `${event.provider}/${event.model}` : event.provider;
    return `[WARN] PROVIDER_SWITCH: ${target} had a Provider-level failure (${event.code || 'UNEXPECTED'}: ${singleLine(event.message)}); switching to ${event.next}`;
  }
  if (event.type === 'provider_failed') {
    const target = event.model ? `${event.provider}/${event.model}` : event.provider;
    return `[WARN] PROVIDER_FAILED: ${target} had a Provider-level failure (${event.code || 'UNEXPECTED'}: ${singleLine(event.message)}); no more Providers are available`;
  }
  const reason = `${event.code || 'UNKNOWN'}: ${singleLine(event.message)}`;
  if (event.type === 'model_switch') {
    return `[WARN] MODEL_SWITCH: ${event.provider}/${event.model} failed (${reason}); switching to ${event.next}`;
  }
  return `[WARN] MODEL_FAILED: ${event.provider}/${event.model} failed (${reason}); no more models are available`;
}

function cleanResultText(value) {
  return String(value || '')
    .replace(/<\|(?:begin|end)_of_box\|>/g, '')
    .trim();
}

function formatSuccessfulOutput(result) {
  return cleanResultText(result.text);
}

function serializableBatchResult(results) {
  return {
    status: results.every(({ status }) => status === 'succeeded') ? 'succeeded' : 'failed',
    results: results.map((result) => ({
      inputId: result.inputId,
      index: result.index,
      canonicalJobId: result.canonicalJobId,
      canonicalInputId: result.canonicalInputId,
      deduplicated: result.deduplicated,
      status: result.status,
      text: result.text,
      error: result.error,
      retryPath: result.retryPath,
      retryExpiresAt: result.retryExpiresAt,
      originalIndexes: result.originalIndexes,
    })),
  };
}

module.exports = {
  cleanResultText,
  formatStatusEvent,
  formatSuccessfulOutput,
  serializableBatchResult,
  statusEventVisible,
  verboseStatusEnabled,
};
