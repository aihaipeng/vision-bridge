const { parseConcurrency } = require('./batch_runner');
const { cancellationError, throwIfCancelled } = require('./cancellation');

function createBoundedTaskQueue(concurrency, options = {}) {
  const limit = parseConcurrency(concurrency);
  const defaultSignal = options.signal;
  const pending = [];
  let active = 0;

  function drain() {
    while (active < limit && pending.length > 0) {
      const entry = pending.shift();
      if (entry.signal && entry.signal.aborted) {
        entry.reject(cancellationError(entry.signal));
        continue;
      }
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      active += 1;
      Promise.resolve()
        .then(() => {
          throwIfCancelled(entry.signal);
          return entry.task();
        })
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function run(task, runOptions = {}) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    const signal = runOptions.signal || defaultSignal;
    throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, signal, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          reject(cancellationError(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      pending.push(entry);
      drain();
    });
  }

  return Object.freeze({
    run,
    stats: () => Object.freeze({ active, pending: pending.length, limit }),
  });
}

module.exports = { createBoundedTaskQueue };
