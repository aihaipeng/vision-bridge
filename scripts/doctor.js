const { PROVIDER_KEYS, resolveCredential } = require('./key_store');

const MINIMUM_NODE_VERSION = [20, 9, 0];
const REQUIRED_DEPENDENCIES = ['sharp', 'bmp-ts', 'https-proxy-agent'];

function versionAtLeast(current, minimum = MINIMUM_NODE_VERSION) {
  const parts = String(current).split('.').map((value) => Number(value));
  return minimum.every((value, index) => (parts[index] || 0) === value)
    || parts.some((value, index) => value !== minimum[index]
      && value > minimum[index]
      && parts.slice(0, index).every((part, earlier) => part === minimum[earlier]));
}

function dependencyFailures(requireImpl = require) {
  const failures = [];
  for (const dependency of REQUIRED_DEPENDENCIES) {
    try { requireImpl(dependency); }
    catch (error) { failures.push({ dependency, message: error.message || String(error) }); }
  }
  return failures;
}

function providerConfiguration(resolveImpl = resolveCredential) {
  return Object.keys(PROVIDER_KEYS).map((provider) => {
    const credential = resolveImpl(provider);
    return { provider, envName: PROVIDER_KEYS[provider], configured: Boolean(credential.key), source: credential.source };
  });
}

function main() {
  let exitCode = 0;
  if (versionAtLeast(process.versions.node)) {
    process.stdout.write(`[OK] Node.js ${process.versions.node}\n`);
  } else {
    process.stderr.write(`[ERROR] NODE_VERSION: 需要 Node.js 20.9.0+，当前为 ${process.versions.node}\n`);
    exitCode = 1;
  }

  const dependencyErrors = dependencyFailures();
  if (dependencyErrors.length) {
    for (const failure of dependencyErrors) {
      process.stderr.write(`[ERROR] DEPENDENCY: ${failure.dependency} 无法加载: ${failure.message}\n`);
    }
    process.stderr.write('[ACTION] 在 Skill 目录运行 npm ci --omit=dev\n');
    exitCode = 1;
  } else {
    process.stdout.write(`[OK] 运行依赖: ${REQUIRED_DEPENDENCIES.join(', ')}\n`);
  }

  const providers = providerConfiguration();
  for (const provider of providers) {
    const stream = provider.configured ? process.stdout : process.stderr;
    stream.write(`${provider.configured ? '[OK]' : '[WARN]'} ${provider.envName}: ${provider.configured ? `已配置 (${provider.source})` : '未配置'}\n`);
  }
  if (!providers.some(({ configured }) => configured)) {
    process.stderr.write('[ERROR] KEY_REQUIRED: 至少配置 ZHIPU_API_KEY 或 GEMINI_API_KEY；配置后直接重新运行 npm run doctor\n');
    if (exitCode === 0) exitCode = 2;
  }
  process.exitCode = exitCode;
  return { exitCode, dependencyErrors, providers };
}

if (require.main === module) main();

module.exports = {
  dependencyFailures,
  main,
  MINIMUM_NODE_VERSION,
  providerConfiguration,
  REQUIRED_DEPENDENCIES,
  versionAtLeast,
};
