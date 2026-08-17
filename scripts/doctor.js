const { PROVIDER_EXTRA_KEYS, PROVIDER_KEYS, resolveCredential } = require('./key_store');

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

async function avifCapability(sharpImpl = require('sharp')) {
  try {
    const encoded = await sharpImpl({
      create: { width: 1, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).avif().toBuffer();
    const metadata = await sharpImpl(encoded).metadata();
    if (metadata.format !== 'heif' || metadata.width !== 1 || metadata.height !== 1) {
      throw new Error('AVIF decode result did not match expectations');
    }
    return { supported: true };
  } catch (error) {
    return { supported: false, message: error.message || String(error) };
  }
}

function providerConfiguration(resolveImpl = resolveCredential) {
  return Object.keys(PROVIDER_KEYS).map((provider) => {
    const credential = resolveImpl(provider);
    const extraEnvName = PROVIDER_EXTRA_KEYS[provider];
    const extraConfigured = !extraEnvName
      || (credential.extra && Boolean(credential.extra.value));
    return {
      provider,
      envName: PROVIDER_KEYS[provider],
      extraEnvName,
      extraConfigured,
      configured: Boolean(credential.key) && extraConfigured,
      source: credential.source,
    };
  });
}

async function main() {
  let exitCode = 0;
  if (versionAtLeast(process.versions.node)) {
    process.stdout.write(`[OK] Node.js ${process.versions.node}\n`);
  } else {
    process.stderr.write(`[ERROR] NODE_VERSION: Node.js 20.9.0+ is required; current version is ${process.versions.node}\n`);
    exitCode = 1;
  }

  const dependencyErrors = dependencyFailures();
  if (dependencyErrors.length) {
    for (const failure of dependencyErrors) {
      process.stderr.write(`[ERROR] DEPENDENCY: Unable to load ${failure.dependency}: ${failure.message}\n`);
    }
    process.stderr.write('[ACTION] Run npm ci --omit=dev in the Skill directory\n');
    exitCode = 1;
  } else {
    process.stdout.write(`[OK] Runtime dependencies: ${REQUIRED_DEPENDENCIES.join(', ')}\n`);
  }

  let avif = { supported: false, message: 'Runtime dependencies failed; AVIF probe was not run' };
  if (!dependencyErrors.length) {
    avif = await avifCapability();
    if (avif.supported) process.stdout.write('[OK] AVIF: encode and decode probe passed\n');
    else {
      process.stderr.write(`[ERROR] AVIF: The current sharp/libvips build lacks required AVIF support: ${avif.message}\n`);
      exitCode = 1;
    }
  }

  const providers = providerConfiguration();
  for (const provider of providers) {
    const stream = provider.configured ? process.stdout : process.stderr;
    stream.write(`${provider.configured ? '[OK]' : '[WARN]'} ${provider.envName}: ${provider.configured ? `configured (${provider.source})` : 'not configured'}\n`);
    if (provider.extraEnvName) {
      const extraStream = provider.extraConfigured ? process.stdout : process.stderr;
      extraStream.write(`${provider.extraConfigured ? '[OK]' : '[WARN]'} ${provider.extraEnvName}: ${provider.extraConfigured ? 'configured' : 'not configured'}\n`);
    }
  }
  if (!providers.some(({ configured }) => configured)) {
    process.stderr.write('[ERROR] KEY_REQUIRED: Configure at least one Provider Key (VISION_BRIDGE_ZHIPU_API_KEY, VISION_BRIDGE_GEMINI_API_KEY, VISION_BRIDGE_MISTRAL_API_KEY, VISION_BRIDGE_NVIDIA_API_KEY, or VISION_BRIDGE_CLOUDFLARE_API_TOKEN + VISION_BRIDGE_CLOUDFLARE_ACCOUNT_ID), then run npm run doctor again\n');
    if (exitCode === 0) exitCode = 2;
  }
  process.exitCode = exitCode;
  return { exitCode, dependencyErrors, avif, providers };
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`[ERROR] DOCTOR: ${error.message || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  avifCapability,
  dependencyFailures,
  main,
  MINIMUM_NODE_VERSION,
  providerConfiguration,
  REQUIRED_DEPENDENCIES,
  versionAtLeast,
};
