const assert = require('node:assert/strict');
const test = require('node:test');
const { createBoundedTaskQueue } = require('../scripts/workflow/bounded_task_queue');

test('bounded task queue limits active work and preserves each result', async () => {
  const queue = createBoundedTaskQueue(2);
  let active = 0;
  let peak = 0;
  const results = await Promise.all([1, 2, 3, 4].map((value) => queue.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
    return value * 2;
  })));

  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8]);
  assert.deepEqual(queue.stats(), { active: 0, pending: 0, limit: 2 });
});
