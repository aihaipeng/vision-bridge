const assert = require('node:assert/strict');
const test = require('node:test');
const { createStatusEmitter } = require('../scripts/workflow/status_events');

test('status emitter deduplicates batch Provider events but keeps image events', () => {
  const events = [];
  const emit = createStatusEmitter((event) => events.push(event));
  emit({ type: 'provider_available', provider: 'zhipu' });
  emit({ type: 'provider_available', provider: 'zhipu' });
  emit({ type: 'model_switch', provider: 'zhipu', jobId: 'a' });
  emit({ type: 'model_switch', provider: 'zhipu', jobId: 'b' });

  assert.deepEqual(events.map(({ type }) => type), ['provider_available', 'model_switch', 'model_switch']);
});
