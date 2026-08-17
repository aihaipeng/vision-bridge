const BATCH_EVENT_TYPES = new Set([
  'provider_available',
  'provider_cooldown',
  'provider_skipped',
  'model_cooldown',
]);

function eventIdentity(event) {
  if (!BATCH_EVENT_TYPES.has(event.type)) return null;
  return `${event.type}:${event.provider || ''}`;
}

function createStatusEmitter(sink) {
  const seen = new Set();
  return (event) => {
    if (!sink) return;
    const identity = eventIdentity(event);
    if (identity && seen.has(identity)) return;
    if (identity) seen.add(identity);
    sink(event);
  };
}

module.exports = { BATCH_EVENT_TYPES, createStatusEmitter, eventIdentity };
