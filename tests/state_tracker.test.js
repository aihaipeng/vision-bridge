const assert = require('node:assert/strict');
const test = require('node:test');
const { StateTracker, WorkflowStateError } = require('../scripts/workflow/state_tracker');

test('StateTracker accepts only forward workflow transitions', () => {
  const events = [];
  const tracker = new StateTracker((event) => events.push(event));
  tracker.start('input-1', { inputId: 'input-1', index: 0 });
  for (const state of ['acquired', 'standardized', 'deduplicated', 'queued', 'running', 'succeeded', 'cleaned']) {
    tracker.transition('input-1', state);
  }

  assert.equal(tracker.stateOf('input-1'), 'cleaned');
  assert.deepEqual(events.map(({ state }) => state), [
    'discovered', 'acquired', 'standardized', 'deduplicated', 'queued', 'running', 'succeeded', 'cleaned',
  ]);
  assert.throws(() => tracker.transition('input-1', 'running'), WorkflowStateError);
});

test('StateTracker supports failure and retained terminal paths', () => {
  const tracker = new StateTracker();
  tracker.start('input-1');
  tracker.transition('input-1', 'failed');
  tracker.transition('input-1', 'retained');
  assert.equal(tracker.stateOf('input-1'), 'retained');
});
