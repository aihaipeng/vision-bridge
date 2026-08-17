const fs = require('fs');
const path = require('path');
const { CliError, formatCliError } = require('./errors');
const { createInputItem } = require('./workflow/contracts');
const {
  executeBatch: executeManifest,
  inputFailure,
} = require('./workflow/batch_orchestrator');
const {
  formatStatusEvent,
  serializableBatchResult,
  statusEventVisible,
} = require('./workflow/result_formatter');
const { enforceBatchSize, resolveResourceLimits } = require('./workflow/resource_limits');

const DEFAULT_PROMPT = 'Describe this image in detail.';

function writeBatchStatusEvent(event, stream = process.stderr, env = process.env) {
  if (!statusEventVisible(event, env)) return;
  if (event.type === 'provider_available') {
    stream.write(`${formatStatusEvent(event, { env })}\n`);
    return;
  }
  stream.write(`${JSON.stringify({ type: 'status', ...event })}\n`);
}

function sourceForInput(value) {
  const input = String(value || '').trim();
  if (input === 'clipboard') return { kind: 'clipboard' };
  if (/^file:\/\//i.test(input)) return { kind: 'file_url', value: input };
  if (/^https?:\/\//i.test(input)) return { kind: 'http_url', value: input };
  return { kind: 'local_path', value: input };
}

function parseManifest(value) {
  const manifest = Array.isArray(value) ? { items: value } : value;
  if (!manifest || !Array.isArray(manifest.items) || manifest.items.length === 0) {
    throw new CliError('BATCH_MANIFEST', 'Batch manifest must be a non-empty array or an object containing a non-empty items array', 2);
  }
  const items = manifest.items.map((item, index) => {
    if (typeof item === 'string') {
      return createInputItem({
        inputId: `input-${index + 1}`,
        index,
        prompt: manifest.prompt || DEFAULT_PROMPT,
        source: sourceForInput(item),
      });
    }
    return createInputItem({
      inputId: item.inputId || `input-${index + 1}`,
      index,
      prompt: item.prompt || manifest.prompt || DEFAULT_PROMPT,
      source: item.source || sourceForInput(item.input),
    });
  });
  const inputIds = new Set();
  for (const item of items) {
    if (inputIds.has(item.inputId)) {
      throw new CliError('BATCH_MANIFEST', `Batch manifest contains duplicate inputId: ${item.inputId}`, 2);
    }
    inputIds.add(item.inputId);
  }
  enforceBatchSize(items, resolveResourceLimits().maxBatchItems);
  return {
    items,
    concurrency: manifest.concurrency,
    providerConcurrency: manifest.providerConcurrency,
  };
}

async function main() {
  if (process.argv.length < 3) {
    throw new CliError('USAGE', 'Usage: node scripts/describe_images.js <batch-manifest.json>', 2);
  }
  const manifestPath = path.resolve(process.argv[2]);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new CliError('BATCH_MANIFEST', `Unable to read batch manifest: ${error.message || error}`, 2, error);
  }
  const manifest = parseManifest(parsed);
  const results = await executeManifest(manifest, {
    onStatus: (event) => writeBatchStatusEvent(event),
  });
  process.stdout.write(`${JSON.stringify(serializableBatchResult(results), null, 2)}\n`);
  if (results.some(({ status }) => status === 'failed')) process.exitCode = 1;
  return results;
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
  DEFAULT_PROMPT,
  executeManifest,
  handleFatalError,
  inputFailure,
  main,
  parseManifest,
  serializableBatchResult,
  sourceForInput,
  writeBatchStatusEvent,
};
