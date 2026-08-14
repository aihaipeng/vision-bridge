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
  }
}

function singleLine(value) {
  return String(value || '未知错误').replace(/\s+/g, ' ').trim();
}

function formatCliError(error) {
  const code = error instanceof CliError ? error.code : 'UNEXPECTED';
  return `[ERROR] ${code}: ${singleLine(error && (error.message || error))}`;
}

module.exports = { CliError, ProviderError, formatCliError, singleLine };
