const fs = require('fs');
const { spawnSync } = require('child_process');

const PROVIDER_KEYS = {
  gemini: 'GEMINI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
};

function providerForBareCredential(providerMode) {
  return providerMode === 'gemini' ? 'gemini' : 'zhipu';
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

function readStdinCredential(providerMode) {
  if (process.stdin.isTTY) return null;
  const line = fs.readFileSync(0, 'utf8').trim().split(/\r?\n/)[0];
  if (!line) return null;
  const match = line.match(/^(GEMINI_API_KEY|ZHIPU_API_KEY)=(.+)$/);
  if (match) {
    return {
      provider: match[1] === 'GEMINI_API_KEY' ? 'gemini' : 'zhipu',
      key: match[2].trim(),
      source: 'stdin',
    };
  }
  return {
    provider: providerForBareCredential(providerMode),
    key: line,
    source: 'stdin',
  };
}

function resolveCredential(provider, stdinCredential) {
  if (stdinCredential && stdinCredential.provider === provider && stdinCredential.key) return stdinCredential;
  const envName = PROVIDER_KEYS[provider];
  const userKey = readUserEnvironmentKey(envName);
  if (userKey) return { provider, key: userKey, source: 'user-env' };
  const processKey = (process.env[envName] || '').trim();
  if (processKey) return { provider, key: processKey, source: 'env' };
  return { provider, key: '', source: 'missing' };
}

function persistUserEnvironmentKey(provider, key) {
  const envName = PROVIDER_KEYS[provider];
  if (!envName || !key || process.platform !== 'win32') return false;
  const script = `$value = [Console]::In.ReadToEnd().Trim(); [Environment]::SetEnvironmentVariable('${envName}', $value, 'User')`;
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    input: key,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) process.env[envName] = key;
  return result.status === 0;
}

module.exports = {
  PROVIDER_KEYS,
  persistUserEnvironmentKey,
  providerForBareCredential,
  readStdinCredential,
  readUserEnvironmentKey,
  resolveCredential,
};
