const { spawnSync } = require('child_process');

const PROVIDER_KEYS = {
  gemini: 'GEMINI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
};

const PROVIDER_EXTRA_KEYS = {
  cloudflare: 'CLOUDFLARE_ACCOUNT_ID',
};

function readEnvironmentValue(name) {
  const userValue = readUserEnvironmentKey(name);
  if (userValue) return { value: userValue, source: 'user-env' };
  const processValue = (process.env[name] || '').trim();
  if (processValue) return { value: processValue, source: 'env' };
  return { value: '', source: 'missing' };
}

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
  const { value: key, source } = readEnvironmentValue(PROVIDER_KEYS[provider]);
  const extraEnvName = PROVIDER_EXTRA_KEYS[provider];
  const extra = extraEnvName
    ? { envName: extraEnvName, ...readEnvironmentValue(extraEnvName) }
    : undefined;
  return { provider, key, source, extra };
}

module.exports = {
  PROVIDER_EXTRA_KEYS,
  PROVIDER_KEYS,
  readUserEnvironmentKey,
  resolveCredential,
};
