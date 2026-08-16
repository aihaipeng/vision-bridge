const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_STATE_FILE = process.env.VISION_HEALTH_FILE || path.join(os.tmpdir(), 'vision_bridge_health.json');
const COOLDOWN_BASE_MS = 60 * 1000;
const COOLDOWN_MAX_MS = 16 * 60 * 1000;
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROVIDER_SENTINEL = '__provider';

function loadState(file = DEFAULT_STATE_FILE, now = Date.now()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const state = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object') continue;
      const cooldownFresh = entry.cooldownUntil && entry.cooldownUntil >= now - STATE_MAX_AGE_MS;
      const successFresh = entry.lastSuccess && entry.lastSuccess >= now - STATE_MAX_AGE_MS;
      if (cooldownFresh || successFresh) state[key] = entry;
    }
    return state;
  } catch {
    return {};
  }
}

function persistState(state, file = DEFAULT_STATE_FILE) {
  try {
    const disk = loadState(file);
    const merged = {};
    for (const key of new Set([...Object.keys(disk), ...Object.keys(state)])) {
      const mine = state[key];
      const theirs = disk[key];
      merged[key] = !mine ? theirs : !theirs ? mine
        : ((mine.updatedAt || 0) >= (theirs.updatedAt || 0) ? mine : theirs);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, file);
  } catch {
    // ponytail: 无锁合并写，毫秒级窗口内两写者相撞时丢一次更新，可接受；健康状态是建议性数据
  }
}

function createHealthStore({ file = DEFAULT_STATE_FILE, now = Date.now() } = {}) {
  const store = { state: loadState(file, now), file, persist: () => persistState(store.state, file) };
  return store;
}

function cooldownDuration(failures, retryAfterMs, baseMs = COOLDOWN_BASE_MS, maxMs = COOLDOWN_MAX_MS) {
  const escalated = Math.min(baseMs * 2 ** (failures - 1), maxMs);
  if (!retryAfterMs || retryAfterMs <= 0) return escalated;
  return Math.min(Math.max(escalated, retryAfterMs), maxMs);
}

function recordFailure(state, provider, model, { scope, code, retryAfterMs } = {}, now = Date.now()) {
  if (code === 'AUTH') return null;
  const key = `${provider}/${model}`;
  const previous = state[key] || {};
  const failures = (previous.failures || 0) + 1;
  const cooldownUntil = now + cooldownDuration(failures, retryAfterMs);
  state[key] = {
    failures,
    lastSuccess: previous.lastSuccess || 0,
    cooldownUntil,
    lastError: `${scope || 'model'}/${code || 'UNEXPECTED'}`,
    updatedAt: now,
  };
  return state[key];
}

function recordProviderFailure(state, provider, details = {}, now = Date.now()) {
  return recordFailure(state, provider, PROVIDER_SENTINEL, { ...details, scope: 'provider' }, now);
}

function recordSuccess(state, provider, model, now = Date.now()) {
  state[`${provider}/${model}`] = { failures: 0, lastSuccess: now, cooldownUntil: 0, lastError: '', updatedAt: now };
  delete state[`${provider}/${PROVIDER_SENTINEL}`];
}

function entryFor(state, provider, model) {
  return state[`${provider}/${model}`];
}

function cooldownRemaining(entry, now = Date.now()) {
  return entry && entry.cooldownUntil > now ? entry.cooldownUntil - now : 0;
}

function cooledModels(models, provider, state, now = Date.now()) {
  return models.filter((model) => cooldownRemaining(entryFor(state, provider, model), now) > 0);
}

function orderModels(models, provider, state, now = Date.now()) {
  return models
    .map((model, index) => ({ model, index, entry: entryFor(state, provider, model) }))
    .sort((a, b) => {
      const aCooling = cooldownRemaining(a.entry, now) > 0;
      const bCooling = cooldownRemaining(b.entry, now) > 0;
      if (aCooling !== bCooling) return aCooling ? 1 : -1;
      if (aCooling) return a.entry.cooldownUntil - b.entry.cooldownUntil;
      return a.index - b.index;
    })
    .map(({ model }) => model);
}

function orderProviders(providers, state, now = Date.now()) {
  return providers
    .map((provider, index) => ({ provider, index, entry: state[`${provider}/${PROVIDER_SENTINEL}`] }))
    .sort((a, b) => {
      const aCooling = cooldownRemaining(a.entry, now) > 0;
      const bCooling = cooldownRemaining(b.entry, now) > 0;
      if (aCooling !== bCooling) return aCooling ? 1 : -1;
      if (aCooling) return a.entry.cooldownUntil - b.entry.cooldownUntil;
      return a.index - b.index;
    })
    .map(({ provider }) => provider);
}

function providerCooldown(state, provider, now = Date.now()) {
  const entry = state[`${provider}/${PROVIDER_SENTINEL}`];
  const remainingMs = cooldownRemaining(entry, now);
  return remainingMs > 0 ? { provider, remainingMs, lastError: entry.lastError || '' } : null;
}

module.exports = {
  DEFAULT_STATE_FILE,
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  PROVIDER_SENTINEL,
  cooldownDuration,
  cooledModels,
  cooldownRemaining,
  createHealthStore,
  entryFor,
  loadState,
  orderModels,
  orderProviders,
  providerCooldown,
  recordFailure,
  recordProviderFailure,
  recordSuccess,
};
