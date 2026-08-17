const { findClaudeCandidates } = require('./claude');
const { findOpenCodeCandidates } = require('./opencode');

const ADAPTERS = Object.freeze({
  claude: findClaudeCandidates,
  opencode: findOpenCodeCandidates,
});

function findSessionCandidates(options = {}) {
  const clients = options.client === 'auto' ? Object.keys(ADAPTERS) : [options.client];
  return clients.flatMap((client) => ADAPTERS[client]({
    cwd: options.cwd,
    sessionId: options.sessionId,
    maxAgeMs: options.maxAgeMs,
    homeDir: options.homeDir,
    now: options.now,
    platform: options.platform,
    queryDb: options.queryDb,
    projectsRoot: options.projectsRoot,
  }));
}

module.exports = { ADAPTERS, findSessionCandidates };
