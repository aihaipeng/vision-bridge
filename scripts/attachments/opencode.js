const { spawnSync } = require('child_process');
const {
  DEFAULT_MAX_AGE_MINUTES,
  MESSAGE_ID_PATTERN,
  PART_ID_PATTERN,
  SESSION_ID_PATTERN,
  directoriesMatch,
  fail,
} = require('./common');

const OPENCODE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
    const detail = String(result.stderr || result.error || 'opencode db failed').replace(/\s+/g, ' ').trim();
    fail('SESSION_RECOVERY', `Unable to read the OpenCode session database: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout || '[]');
  } catch (error) {
    fail('SESSION_RECOVERY', `The OpenCode session database returned invalid JSON: ${error.message}`);
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
  if (!PART_ID_PATTERN.test(partId)) fail('SESSION_RECOVERY', 'Invalid OpenCode part ID format');
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

module.exports = {
  OPENCODE_MAX_BUFFER_BYTES,
  findOpenCodeCandidates,
  groupOpenCodeMetadata,
  openCodeImagesFromRows,
  openCodeMetadataQuery,
  openCodePartsQuery,
  openCodePowerShellCommand,
  queryOpenCodeDatabase,
};
