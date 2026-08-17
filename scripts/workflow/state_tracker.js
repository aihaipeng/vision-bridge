const TRANSITIONS = Object.freeze({
  discovered: new Set(['acquired', 'failed']),
  acquired: new Set(['standardized', 'failed']),
  standardized: new Set(['deduplicated', 'failed']),
  deduplicated: new Set(['queued', 'failed']),
  queued: new Set(['running', 'failed']),
  running: new Set(['succeeded', 'failed']),
  succeeded: new Set(['cleaned']),
  failed: new Set(['cleaned', 'retained']),
  cleaned: new Set(),
  retained: new Set(),
});

class WorkflowStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkflowStateError';
  }
}

class StateTracker {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.states = new Map();
  }

  start(entityId, metadata = {}) {
    if (this.states.has(entityId)) throw new WorkflowStateError(`State entity already exists: ${entityId}`);
    this.states.set(entityId, { state: 'discovered', metadata });
    this.emit(entityId, null, 'discovered');
  }

  transition(entityId, next) {
    const entry = this.states.get(entityId);
    if (!entry) throw new WorkflowStateError(`State entity does not exist: ${entityId}`);
    if (!TRANSITIONS[entry.state] || !TRANSITIONS[entry.state].has(next)) {
      throw new WorkflowStateError(`Invalid state transition: ${entry.state} -> ${next}`);
    }
    const previous = entry.state;
    entry.state = next;
    this.emit(entityId, previous, next);
  }

  stateOf(entityId) {
    const entry = this.states.get(entityId);
    return entry && entry.state;
  }

  emit(entityId, previous, state) {
    if (!this.onEvent) return;
    const entry = this.states.get(entityId);
    this.onEvent({
      type: 'workflow_state',
      entityId,
      previous,
      state,
      ...entry.metadata,
    });
  }
}

module.exports = { StateTracker, TRANSITIONS, WorkflowStateError };
