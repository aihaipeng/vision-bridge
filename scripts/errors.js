class CliError extends Error {
  constructor(code, message, exitCode = 1, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

class ProviderError extends Error {
  constructor(provider, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.model = options.model;
    this.status = options.status;
    this.auth = options.auth === true;
    this.retryable = options.retryable === true;
    this.quotaScope = options.quotaScope;
    this.retryAfterMs = options.retryAfterMs;
    this.scope = options.scope;
    this.failures = Array.isArray(options.failures) ? options.failures : [];
  }
}

function singleLine(value) {
  return String(value || '未知错误').replace(/\s+/g, ' ').trim();
}

function formatCliError(error) {
  const code = error instanceof CliError ? error.code : 'UNEXPECTED';
  return `[ERROR] ${code}: ${singleLine(error && (error.message || error))}`;
}

function providerFailureScope(error) {
  if (!(error instanceof ProviderError)) return 'model';
  if (error.scope === 'model' || error.scope === 'provider') return error.scope;
  if (error.quotaScope === 'model') return 'model';
  if (error.auth || error.code === 'NETWORK' || error.quotaScope === 'provider') return 'provider';
  if (error.status === 400 || error.status === 408 || error.status === 429 || error.status >= 500) return 'provider';
  return 'model';
}

module.exports = { CliError, ProviderError, formatCliError, providerFailureScope, singleLine };
