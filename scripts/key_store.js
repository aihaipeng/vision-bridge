const { spawnSync } = require('child_process');

const PROVIDER_KEYS = {
  gemini: 'GEMINI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
};

function readUserEnvironmentKey(name) {
  if (process.platform !== 'win32') return '';
  const script = `[Environment]::GetEnvironmentVariable('${name}', 'User')`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function resolveCredential(provider) {
  const envName = PROVIDER_KEYS[provider];
  const userKey = readUserEnvironmentKey(envName);
  if (userKey) return { provider, key: userKey, source: 'user-env' };
  const processKey = (process.env[envName] || '').trim();
  if (processKey) return { provider, key: processKey, source: 'env' };
  return { provider, key: '', source: 'missing' };
}

module.exports = {
  PROVIDER_KEYS,
  readUserEnvironmentKey,
  resolveCredential,
};
