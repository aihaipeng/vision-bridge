const { resolveCredential } = require('../key_store');
const { avifCapability, dependencyFailures, versionAtLeast } = require('../doctor');
const { CliError } = require('../errors');
const { credentialReady, keyRequiredError, providerOrder } = require('../providers/router');

function resolveProviderCredentials(resolveImpl = resolveCredential) {
  return Object.fromEntries(providerOrder().map((provider) => [provider, resolveImpl(provider)]));
}

function hasReadyCredential(credentials) {
  return providerOrder().some((provider) => credentialReady(provider, credentials[provider]));
}

async function runBatchPreflight(options = {}) {
  const nodeVersion = options.nodeVersion || process.versions.node;
  if (!versionAtLeast(nodeVersion)) {
    throw new CliError('NODE_VERSION', `Node.js 20.9.0+ is required; current version is ${nodeVersion}`, 1);
  }
  const dependencyErrors = (options.dependencyCheck || dependencyFailures)();
  if (dependencyErrors.length) {
    const names = dependencyErrors.map(({ dependency }) => dependency).join(', ');
    throw new CliError('DEPENDENCY', `Runtime dependencies cannot be loaded: ${names}. Run npm ci --omit=dev in the Skill directory`, 1);
  }
  const avif = await (options.avifCheck || avifCapability)();
  if (!avif.supported) {
    throw new CliError('AVIF_UNAVAILABLE', `The current sharp/libvips build lacks required AVIF support: ${avif.message || 'probe failed'}`, 1);
  }
  const credentials = options.credentials || resolveProviderCredentials(options.resolveImpl);
  if (!hasReadyCredential(credentials)) throw keyRequiredError(providerOrder());
  return {
    credentials,
    diagnostics: Object.freeze({
      nodeVersion,
      avif: true,
      configuredProviders: Object.freeze(providerOrder().filter((provider) => credentialReady(provider, credentials[provider]))),
    }),
  };
}

module.exports = { hasReadyCredential, resolveProviderCredentials, runBatchPreflight };
