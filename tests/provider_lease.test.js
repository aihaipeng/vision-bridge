const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const {
  ProviderLeaseManager,
  providerLeaseName,
} = require('../scripts/workflow/provider_lease');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-provider-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('two lease managers serialize the same Provider', async (t) => {
  const root = tempRoot(t);
  const first = new ProviderLeaseManager({ tempRoot: root, pollMs: 2, ttlMs: 1000, renewMs: 100 });
  const second = new ProviderLeaseManager({ tempRoot: root, pollMs: 2, ttlMs: 1000, renewMs: 100 });
  let active = 0;
  let peak = 0;
  const task = (manager, delay) => manager.run('zhipu', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
  });

  await Promise.all([task(first, 20), task(second, 2)]);
  assert.equal(peak, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('different Providers can hold leases concurrently', async (t) => {
  const root = tempRoot(t);
  const first = new ProviderLeaseManager({ tempRoot: root, pollMs: 2 });
  const second = new ProviderLeaseManager({ tempRoot: root, pollMs: 2 });
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = (manager, provider) => manager.run(provider, async () => {
    active += 1;
    peak = Math.max(peak, active);
    if (active === 2) release();
    await gate;
    active -= 1;
  });

  await Promise.all([run(first, 'zhipu'), run(second, 'gemini')]);
  assert.equal(peak, 2);
});

test('stale Provider lease is atomically recovered', async (t) => {
  const root = tempRoot(t);
  const manager = new ProviderLeaseManager({ tempRoot: root, pollMs: 2, ttlMs: 10, renewMs: 3 });
  const filePath = path.join(root, providerLeaseName('zhipu'));
  fs.writeFileSync(filePath, `${JSON.stringify({ pid: 999999, acquiredAt: 1, createdAt: 1 })}\n`);
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(filePath, old, old);

  const lease = await manager.acquire('zhipu');
  assert.equal(lease.owner.pid, process.pid);
  lease.release();
  assert.equal(fs.existsSync(filePath), false);
});

test('lease heartbeat prevents recovery while the owner is active', async (t) => {
  const root = tempRoot(t);
  const first = new ProviderLeaseManager({ tempRoot: root, pollMs: 2, ttlMs: 20, renewMs: 4 });
  const second = new ProviderLeaseManager({ tempRoot: root, pollMs: 2, ttlMs: 20, renewMs: 4 });
  const lease = await first.acquire('zhipu');
  let secondAcquired = false;
  const waiting = second.acquire('zhipu').then((next) => {
    secondAcquired = true;
    next.release();
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondAcquired, false);
  lease.release();
  await waiting;
  assert.equal(secondAcquired, true);
});

test('aborted lease waiter creates no file and lease stores only process metadata', async (t) => {
  const root = tempRoot(t);
  const first = new ProviderLeaseManager({ tempRoot: root, pollMs: 5 });
  const second = new ProviderLeaseManager({ tempRoot: root, pollMs: 5 });
  const lease = await first.acquire('zhipu');
  const content = JSON.parse(fs.readFileSync(lease.path, 'utf8'));
  assert.deepEqual(Object.keys(content).sort(), ['acquiredAt', 'createdAt', 'pid']);

  const controller = new AbortController();
  const waiting = second.acquire('zhipu', { signal: controller.signal });
  controller.abort(new Error('stop waiting'));
  await assert.rejects(waiting, (error) => error.code === 'BATCH_CANCELLED');
  assert.deepEqual(fs.readdirSync(root), [path.basename(lease.path)]);
  lease.release();
  assert.deepEqual(fs.readdirSync(root), []);
});

test('two OS processes serialize the same Provider lease', async (t) => {
  const root = tempRoot(t);
  const logPath = path.join(root, 'events.log');
  const worker = path.resolve(__dirname, 'fixtures/provider_lease_worker.js');
  const run = (label) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root, logPath, label, '30'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `worker ${label} exited ${code}`));
    });
  });

  await Promise.all([run('first'), run('second')]);
  const events = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => {
    const [label, type, timestamp] = line.split(',');
    return { label, type, timestamp: Number(timestamp) };
  });
  assert.equal(events.length, 4);
  assert.equal(events[0].type, 'start');
  assert.equal(events[1].type, 'end');
  assert.equal(events[2].type, 'start');
  assert.equal(events[3].type, 'end');
  assert.ok(events[2].timestamp >= events[1].timestamp);
});
