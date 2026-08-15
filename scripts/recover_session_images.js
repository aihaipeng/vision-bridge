const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CliError, formatCliError } = require('./errors');
const { standardizeImageInput } = require('./image_input_resolver');

const DEFAULT_MAX_AGE_MINUTES = 60;
const AMBIGUITY_WINDOW_MS = 15 * 1000;
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_PREFIX = 'img2txt_session_';
const SESSION_ID_PATTERN = /^(?:ses_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]+$/;
const PART_ID_PATTERN = /^prt_[A-Za-z0-9]+$/;
const OPENCODE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function fail(code, message, exitCode = 1) {
  throw new CliError(code, message, exitCode);
}

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
      if (index >= argv.length) fail('USAGE', `参数 ${argument} 缺少值`);
      return argv[index];
    };
    if (argument === '--client') options.client = next().toLowerCase();
    else if (argument === '--cwd') options.cwd = next();
    else if (argument === '--session') options.sessionId = next();
    else if (argument === '--max-age-minutes') options.maxAgeMinutes = Number(next());
    else if (argument === '--home') options.homeDir = next();
    else fail('USAGE', `未知参数: ${argument}`);
  }
  if (!['auto', 'claude', 'opencode'].includes(options.client)) {
    fail('USAGE', '--client 仅支持 auto、claude 或 opencode');
  }
  if (!Number.isFinite(options.maxAgeMinutes) || options.maxAgeMinutes <= 0) {
    fail('USAGE', '--max-age-minutes 必须是正数');
  }
  if (options.sessionId && !SESSION_ID_PATTERN.test(options.sessionId)) {
    fail('USAGE', 'session ID 格式无效');
  }
  if (!options.cwd && !options.sessionId) {
    fail('USAGE', '自动恢复需要 --cwd；也可以使用 --session 精确指定会话');
  }
  return options;
}

function normalizedDirectory(value, platform = process.platform) {
  if (!value) return '';
  let normalized = path.resolve(String(value)).replace(/[\\/]+$/, '');
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function directoriesMatch(left, right, platform = process.platform) {
  return normalizedDirectory(left, platform) === normalizedDirectory(right, platform);
}

function dataUrlFromClaudePart(part) {
  const source = part && part.source;
  if (!source || source.type !== 'base64' || !/^image\//i.test(source.media_type || '')) return null;
  if (typeof source.data !== 'string' || source.data.length === 0) return null;
  return {
    dataUrl: `data:${source.media_type};base64,${source.data}`,
    mime: source.media_type,
    originalName: null,
  };
}

function claudeCandidateFromEntry(entry, fallbackSessionId) {
  if (!entry || entry.type !== 'user' || !entry.message || entry.message.role !== 'user') return null;
  const images = Array.isArray(entry.message.content)
    ? entry.message.content.map(dataUrlFromClaudePart).filter(Boolean)
    : [];
  if (images.length === 0) return null;
  const createdAt = Date.parse(entry.timestamp || '') || 0;
  return {
    client: 'claude',
    sessionId: entry.sessionId || entry.session_id || fallbackSessionId,
    messageId: entry.uuid || null,
    directory: entry.cwd || null,
    createdAt,
    images,
  };
}

function walkRecentJsonl(root, cutoffMs, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) walkRecentJsonl(fullPath, cutoffMs, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const stats = fs.statSync(fullPath);
      if (stats.mtimeMs >= cutoffMs) files.push({ fullPath, stats });
    }
  }
  return files;
}

function findClaudeCandidates(options = {}) {
  const now = options.now || Date.now();
  const maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MINUTES * 60 * 1000;
  const root = options.projectsRoot || path.join(options.homeDir || os.homedir(), '.claude', 'projects');
  const candidates = [];
  for (const { fullPath, stats } of walkRecentJsonl(root, now - maxAgeMs)) {
    const fallbackSessionId = path.basename(fullPath, '.jsonl');
    let latest;
    for (const line of fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const candidate = claudeCandidateFromEntry(entry, fallbackSessionId);
      if (!candidate) continue;
      if (options.sessionId && candidate.sessionId !== options.sessionId) continue;
      if (options.cwd && !directoriesMatch(candidate.directory, options.cwd, options.platform)) continue;
      if ((candidate.createdAt || stats.mtimeMs) < now - maxAgeMs) continue;
      if (!latest || candidate.createdAt > latest.createdAt) latest = candidate;
    }
    if (latest) candidates.push(latest);
  }
  return candidates;
}

function openCodePowerShellCommand() {
  return "$encoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $encoding; $OutputEncoding = $encoding; "
    + "$command = Get-Command opencode.cmd -ErrorAction SilentlyContinue; "
    + "if (-not $command) { $command = Get-Command opencode -ErrorAction Stop }; "
    + "& $command.Source db $env:IMG2TXT_OPENCODE_QUERY --format json";
}

function queryOpenCodeDatabase(query, options = {}) {
  const spawn = options.spawnSyncImpl || spawnSync;
  const env = { ...process.env, IMG2TXT_OPENCODE_QUERY: query };
  const result = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', openCodePowerShellCommand()], {
      encoding: 'utf8', env, windowsHide: true, maxBuffer: OPENCODE_MAX_BUFFER_BYTES,
    })
    : spawn('opencode', ['db', query, '--format', 'json'], {
      encoding: 'utf8', env, maxBuffer: OPENCODE_MAX_BUFFER_BYTES,
    });
  if (result.error && result.error.code === 'ENOENT') return null;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.error || 'opencode db 执行失败').replace(/\s+/g, ' ').trim();
    fail('SESSION_RECOVERY', `无法读取 OpenCode 会话数据库: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout || '[]');
  } catch (error) {
    fail('SESSION_RECOVERY', `OpenCode 会话数据库返回了无效 JSON: ${error.message}`);
  }
}

function openCodeMetadataQuery(sessionId) {
  const sessionClause = sessionId ? ` AND s.id='${sessionId}'` : '';
  return `SELECT s.id AS session_id, s.directory, m.id AS message_id, p.id AS part_id, m.time_created,`
    + ` json_extract(p.data, '$.filename') AS filename, json_extract(p.data, '$.mime') AS mime`
    + ' FROM session s JOIN message m ON m.session_id=s.id JOIN part p ON p.message_id=m.id'
    + ` WHERE json_extract(m.data, '$.role')='user' AND json_extract(p.data, '$.type')='file'`
    + ` AND json_extract(p.data, '$.mime') LIKE 'image/%'${sessionClause}`
    + ' ORDER BY m.time_created DESC, p.time_created ASC LIMIT 200';
}

function openCodePartsQuery(partId) {
  if (!PART_ID_PATTERN.test(partId)) fail('SESSION_RECOVERY', 'OpenCode part ID 格式无效');
  return `SELECT p.data FROM part p WHERE p.id='${partId}'`
    + ` AND json_extract(p.data, '$.type')='file' AND json_extract(p.data, '$.mime') LIKE 'image/%'`;
}

function groupOpenCodeMetadata(rows, options = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row || !SESSION_ID_PATTERN.test(row.session_id || '')
      || !MESSAGE_ID_PATTERN.test(row.message_id || '') || !PART_ID_PATTERN.test(row.part_id || '')) continue;
    if (options.sessionId && row.session_id !== options.sessionId) continue;
    if (options.cwd && !directoriesMatch(row.directory, options.cwd, options.platform)) continue;
    const key = `${row.session_id}:${row.message_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        client: 'opencode',
        sessionId: row.session_id,
        messageId: row.message_id,
        directory: row.directory || null,
        createdAt: Number(row.time_created) || 0,
        partIds: [],
        images: [],
      });
    }
    groups.get(key).partIds.push(row.part_id);
  }
  return [...groups.values()];
}

function openCodeImagesFromRows(rows) {
  const images = [];
  for (const row of rows || []) {
    let part;
    try {
      part = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }
    if (!part || part.type !== 'file' || !/^image\//i.test(part.mime || '')) continue;
    if (typeof part.url !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(part.url)) continue;
    images.push({ dataUrl: part.url, mime: part.mime, originalName: part.filename || null });
  }
  return images;
}

function findOpenCodeCandidates(options = {}) {
  const queryDb = options.queryDb || ((query) => queryOpenCodeDatabase(query, options));
  const metadataRows = queryDb(openCodeMetadataQuery(options.sessionId));
  if (metadataRows === null) return [];
  const now = options.now || Date.now();
  const maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MINUTES * 60 * 1000;
  const candidates = groupOpenCodeMetadata(metadataRows, options)
    .filter((candidate) => candidate.createdAt >= now - maxAgeMs);
  for (const candidate of candidates) {
    for (const partId of candidate.partIds) {
      candidate.images.push(...openCodeImagesFromRows(queryDb(openCodePartsQuery(partId))));
    }
    delete candidate.partIds;
  }
  return candidates.filter((candidate) => candidate.images.length > 0);
}

function selectCandidate(candidates, options = {}) {
  const ordered = [...candidates].sort((left, right) => right.createdAt - left.createdAt);
  if (ordered.length === 0) {
    fail('SESSION_IMAGE_NOT_FOUND', '当前目录和时间范围内没有可恢复的会话图片；请重新粘贴、上传或提供真实路径');
  }
  if (!options.sessionId && ordered.length > 1
    && ordered[0].sessionId !== ordered[1].sessionId
    && ordered[0].createdAt - ordered[1].createdAt <= AMBIGUITY_WINDOW_MS) {
    const ids = ordered.slice(0, 3).map((candidate) => candidate.sessionId).join(', ');
    fail('SESSION_AMBIGUOUS', `多个近期会话同时包含图片，拒绝猜测: ${ids}；请使用 --session 指定当前会话`);
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
  cleanupRecoveryDirectories(options.now || Date.now(), tempRoot);
  const safeSession = candidate.sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeMessage = String(candidate.messageId || candidate.createdAt).replace(/[^A-Za-z0-9_-]/g, '_');
  const directory = path.join(tempRoot, `${RECOVERY_PREFIX}${candidate.client}_${safeSession}_${safeMessage}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const images = [];
  for (let index = 0; index < candidate.images.length; index += 1) {
    const recovered = candidate.images[index];
    const standardized = await standardizeImageInput(recovered.dataUrl);
    const extension = standardized.mime === 'image/png' ? 'png' : 'jpg';
    const digest = crypto.createHash('sha256').update(standardized.data).digest('hex').slice(0, 12);
    const filePath = path.join(directory, `image_${index + 1}_${digest}.${extension}`);
    fs.writeFileSync(filePath, standardized.data, { mode: 0o600 });
    images.push({
      index: index + 1,
      path: filePath,
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
  const common = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    maxAgeMs: options.maxAgeMinutes * 60 * 1000,
    homeDir: options.homeDir,
    now: options.now,
  };
  const candidates = [];
  if (options.client === 'auto' || options.client === 'claude') {
    candidates.push(...findClaudeCandidates(common));
  }
  if (options.client === 'auto' || options.client === 'opencode') {
    candidates.push(...findOpenCodeCandidates({ ...common, queryDb: options.queryDb }));
  }
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
