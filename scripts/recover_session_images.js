const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSessionCandidates } = require('./attachments');
const { claudeCandidateFromEntry, findClaudeCandidates } = require('./attachments/claude');
const { DEFAULT_MAX_AGE_MINUTES, SESSION_ID_PATTERN, directoriesMatch, fail } = require('./attachments/common');
const {
  findOpenCodeCandidates,
  groupOpenCodeMetadata,
  openCodeImagesFromRows,
  openCodeMetadataQuery,
  openCodePartsQuery,
  openCodePowerShellCommand,
} = require('./attachments/opencode');
const { CliError, formatCliError } = require('./errors');
const { standardizeInternalDataUrl } = require('./image_input_resolver');

const AMBIGUITY_WINDOW_MS = 15 * 1000;
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_PREFIX = 'vision_bridge_session_';

function parseArguments(argv) {
  const options = {
    client: 'auto',
    maxAgeMinutes: DEFAULT_MAX_AGE_MINUTES,
    homeDir: os.homedir(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) fail('USAGE', `Missing value for argument ${argument}`);
      return argv[index];
    };
    if (argument === '--client') options.client = next().toLowerCase();
    else if (argument === '--cwd') options.cwd = next();
    else if (argument === '--session') options.sessionId = next();
    else if (argument === '--max-age-minutes') options.maxAgeMinutes = Number(next());
    else if (argument === '--home') options.homeDir = next();
    else fail('USAGE', `Unknown argument: ${argument}`);
  }
  if (!['auto', 'claude', 'opencode'].includes(options.client)) {
    fail('USAGE', '--client accepts only auto, claude, or opencode');
  }
  if (!Number.isFinite(options.maxAgeMinutes) || options.maxAgeMinutes <= 0) {
    fail('USAGE', '--max-age-minutes must be a positive number');
  }
  if (options.sessionId && !SESSION_ID_PATTERN.test(options.sessionId)) {
    fail('USAGE', 'Invalid session ID format');
  }
  if (!options.cwd && !options.sessionId) {
    fail('USAGE', 'Automatic recovery requires --cwd; use --session to select an exact session');
  }
  return options;
}

function selectCandidate(candidates, options = {}) {
  const ordered = [...candidates].sort((left, right) => right.createdAt - left.createdAt);
  if (ordered.length === 0) {
    fail('SESSION_IMAGE_NOT_FOUND', 'No recoverable session image exists in the current directory and time range; paste or upload the image again, or provide a real path');
  }
  if (!options.sessionId && ordered.length > 1
    && ordered[0].sessionId !== ordered[1].sessionId
    && ordered[0].createdAt - ordered[1].createdAt <= AMBIGUITY_WINDOW_MS) {
    const ids = ordered.slice(0, 3).map((candidate) => candidate.sessionId).join(', ');
    fail('SESSION_AMBIGUOUS', `Multiple recent sessions contain images; refusing to guess: ${ids}. Use --session to specify the current session`);
  }
  return ordered[0];
}

function cleanupRecoveryDirectories(now = Date.now(), tempRoot = os.tmpdir()) {
  if (!fs.existsSync(tempRoot)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RECOVERY_PREFIX)) continue;
    const fullPath = path.resolve(tempRoot, entry.name);
    if (path.dirname(fullPath) !== path.resolve(tempRoot)) continue;
    if (fs.statSync(fullPath).mtimeMs < now - RECOVERY_MAX_AGE_MS) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

async function materializeCandidate(candidate, options = {}) {
  const tempRoot = options.tempRoot || os.tmpdir();
  if (!options.transaction) cleanupRecoveryDirectories(options.now || Date.now(), tempRoot);
  const safeSession = candidate.sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeMessage = String(candidate.messageId || candidate.createdAt).replace(/[^A-Za-z0-9_-]/g, '_');
  const directory = path.join(tempRoot, `${RECOVERY_PREFIX}${candidate.client}_${safeSession}_${safeMessage}`);
  if (!options.transaction) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const images = [];
  for (let index = 0; index < candidate.images.length; index += 1) {
    const recovered = candidate.images[index];
    const standardized = await standardizeInternalDataUrl(recovered.dataUrl);
    const extension = standardized.mime === 'image/png' ? 'png' : 'jpg';
    const digest = crypto.createHash('sha256').update(standardized.data).digest('hex').slice(0, 12);
    const fileName = `image_${index + 1}_${digest}.${extension}`;
    const temporary = options.transaction
      ? options.transaction.write(standardized.data, fileName)
      : { path: path.join(directory, fileName), cleanupToken: null };
    if (!options.transaction) fs.writeFileSync(temporary.path, standardized.data, { mode: 0o600 });
    images.push({
      index: index + 1,
      path: temporary.path,
      cleanupToken: temporary.cleanupToken,
      mime: standardized.mime,
      originalName: recovered.originalName,
    });
  }
  return {
    client: candidate.client,
    sessionId: candidate.sessionId,
    messageId: candidate.messageId,
    createdAt: candidate.createdAt,
    source: 'conversation-session',
    images,
  };
}

async function recoverSessionImages(options) {
  const candidates = findSessionCandidates({
    ...options,
    maxAgeMs: options.maxAgeMinutes * 60 * 1000,
  });
  return materializeCandidate(selectCandidate(candidates, options), options);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await recoverSessionImages(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function handleFatalError(error) {
  const cliError = error instanceof CliError
    ? error
    : new CliError('SESSION_RECOVERY', error && (error.message || error), 1, error);
  process.stderr.write(`${formatCliError(cliError)}\n`);
  process.exitCode = cliError.exitCode;
}

if (require.main === module) main().catch(handleFatalError);

module.exports = {
  AMBIGUITY_WINDOW_MS,
  DEFAULT_MAX_AGE_MINUTES,
  RECOVERY_PREFIX,
  claudeCandidateFromEntry,
  cleanupRecoveryDirectories,
  directoriesMatch,
  findClaudeCandidates,
  findOpenCodeCandidates,
  groupOpenCodeMetadata,
  materializeCandidate,
  openCodeImagesFromRows,
  openCodeMetadataQuery,
  openCodePartsQuery,
  openCodePowerShellCommand,
  parseArguments,
  recoverSessionImages,
  selectCandidate,
};
