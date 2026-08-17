const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_MAX_AGE_MINUTES, directoriesMatch } = require('./common');

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

module.exports = { claudeCandidateFromEntry, dataUrlFromClaudePart, findClaudeCandidates, walkRecentJsonl };
