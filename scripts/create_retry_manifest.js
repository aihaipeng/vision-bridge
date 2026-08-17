const fs = require('node:fs');
const path = require('node:path');
const { CliError, formatCliError } = require('./errors');
const { createRetryManifest } = require('./workflow/retry_manifest');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch (error) {
    throw new CliError('RETRY_MANIFEST', `Unable to read ${label}: ${error.message || error}`, 2, error);
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    throw new CliError(
      'USAGE',
      'Usage: node scripts/create_retry_manifest.js <original-batch-manifest.json> <batch-results.json>',
      2,
    );
  }
  const retryManifest = createRetryManifest(
    readJson(argv[0], 'original batch manifest'),
    readJson(argv[1], 'batch results'),
  );
  process.stdout.write(`${JSON.stringify(retryManifest, null, 2)}\n`);
  return retryManifest;
}

function handleFatalError(error) {
  const cliError = error instanceof CliError
    ? error
    : new CliError('UNEXPECTED', error && (error.message || error), 1, error);
  process.stderr.write(`${formatCliError(cliError)}\n`);
  process.exitCode = cliError.exitCode;
}

if (require.main === module) {
  try { main(); } catch (error) { handleFatalError(error); }
}

module.exports = { handleFatalError, main, readJson };
