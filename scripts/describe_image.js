const fs = require('fs');
const {
  standardizeImageInput,
  ImageStandardizationError,
} = require('./image_input_resolver');
const { CliError, formatCliError } = require('./errors');
const {
  DEFAULT_MODEL,
  describeWithProviders,
  keyGuidance,
  keyRequiredError,
  providerOrder,
} = require('./providers/router');
const {
  RETRY_CACHE_MAX_AGE_MS,
  cleanupRetryCaches,
  createRetryCache,
  existingRetryCache,
  retryHint,
} = require('./storage/temp_files');
const { hasReadyCredential, resolveProviderCredentials } = require('./workflow/preflight');
const { formatStatusEvent, formatSuccessfulOutput } = require('./workflow/result_formatter');
const { createProviderLeaseManager } = require('./workflow/provider_lease');
const { createProviderScheduler } = require('./workflow/provider_scheduler');

const DEFAULT_PROMPT = 'Describe this image in detail.';

function writeStatusEvent(event, stream = process.stderr, env = process.env) {
  const line = formatStatusEvent(event, { env });
  if (line) stream.write(`${line}\n`);
}

function parseCliImageInput(value) {
  return {
    resolverInput: value,
    clipboard: value === 'clipboard',
  };
}

function imageInputCliError(error) {
  const message = error && (error.message || error);
  const exitCode = error instanceof ImageStandardizationError ? error.code : 1;
  return new CliError('IMAGE_INPUT', message || String(error), exitCode, error);
}

async function standardizeCliImageInput(inputMode, standardizeImpl = standardizeImageInput) {
  try {
    return await standardizeImpl(inputMode.resolverInput);
  } catch (error) {
    throw imageInputCliError(error);
  }
}

async function main() {
  if (process.argv.length < 3) {
    throw new CliError('USAGE', 'Usage: node vision-bridge/scripts/describe_image.js <image-input|clipboard> [question]');
  }
  cleanupRetryCaches();
  const inputMode = parseCliImageInput(process.argv[2]);
  const imageInput = inputMode.resolverInput;
  const prompt = process.argv[3] || DEFAULT_PROMPT;
  const credentials = resolveProviderCredentials();

  let retryPath = existingRetryCache(imageInput);
  if (!hasReadyCredential(credentials)) {
    if (inputMode.clipboard) {
      const clipboardImage = await standardizeCliImageInput(inputMode);
      retryPath = createRetryCache(clipboardImage);
    }
    const error = keyRequiredError(providerOrder());
    throw new CliError(error.code, `${error.message}${retryHint(retryPath)}`, error.exitCode, error);
  }

  const standardized = await standardizeCliImageInput(inputMode);
  if (inputMode.clipboard) retryPath = createRetryCache(standardized);

  let result;
  try {
    const providerScheduler = createProviderScheduler({
      defaultLimit: 1,
      leaseManager: createProviderLeaseManager(),
    });
    result = await describeWithProviders({
      image: standardized,
      prompt,
      credentials,
      onStatus: (event) => writeStatusEvent(event),
      providerScheduler,
    });
  } catch (error) {
    const hint = retryHint(retryPath);
    if (error instanceof CliError) throw new CliError(error.code, `${error.message}${hint}`, error.exitCode, error);
    throw new CliError('PROVIDERS_FAILED', `${error.message || error}${hint}`, 1, error);
  }

  process.stdout.write(`${formatSuccessfulOutput(result)}\n`);
  if (retryPath && fs.existsSync(retryPath)) fs.rmSync(retryPath, { force: true });
  return result;
}

function handleFatalError(error) {
  const cliError = error instanceof CliError
    ? error
    : new CliError('UNEXPECTED', error && (error.message || error), 1, error);
  process.stderr.write(`${formatCliError(cliError)}\n`);
  process.exitCode = cliError.exitCode;
}

if (require.main === module) main().catch(handleFatalError);

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_PROMPT,
  RETRY_CACHE_MAX_AGE_MS,
  cleanupRetryCaches,
  createRetryCache,
  describeWithProviders,
  formatStatusEvent,
  formatSuccessfulOutput,
  handleFatalError,
  imageInputCliError,
  keyGuidance,
  keyRequiredError,
  main,
  parseCliImageInput,
  providerOrder,
  standardizeCliImageInput,
  writeStatusEvent,
};
