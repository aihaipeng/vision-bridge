const { spawnSync } = require('child_process');

const PROVIDER_KEYS = {
  gemini: 'VISION_BRIDGE_GEMINI_API_KEY',
  zhipu: 'VISION_BRIDGE_ZHIPU_API_KEY',
  mistral: 'VISION_BRIDGE_MISTRAL_API_KEY',
  nvidia: 'VISION_BRIDGE_NVIDIA_API_KEY',
  cloudflare: 'VISION_BRIDGE_CLOUDFLARE_API_TOKEN',
};

const PROVIDER_EXTRA_KEYS = {
  cloudflare: 'VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID',
};

function readEnvironmentValue(name, options = {}) {
  const readUser = options.readUserEnvironmentKey || readUserEnvironmentKey;
  const env = options.env || process.env;
  const userValue = readUser(name);
  if (userValue) return { value: userValue, source: 'user-env' };
  const processValue = (env[name] || '').trim();
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

function resolveCredential(provider, options = {}) {
  const { value: key, source } = readEnvironmentValue(PROVIDER_KEYS[provider], options);
  const extraEnvName = PROVIDER_EXTRA_KEYS[provider];
  const extra = extraEnvName
    ? { envName: extraEnvName, ...readEnvironmentValue(extraEnvName, options) }
    : undefined;
  return { provider, key, source, extra };
}

module.exports = {
  PROVIDER_EXTRA_KEYS,
  PROVIDER_KEYS,
  readEnvironmentValue,
  readUserEnvironmentKey,
  resolveCredential,
};
