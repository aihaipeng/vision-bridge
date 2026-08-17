const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanupExpiredTransactions, createTempFileTransaction } = require('../scripts/storage/temp_files');

test('temp transaction removes successful files and retains only requested retry files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-txn-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  const remove = transaction.write(Buffer.from('a'), 'remove.png');
  const keep = transaction.write(Buffer.from('b'), 'keep.png');
  transaction.retain(keep.cleanupToken);
  const reference = transaction.retryReference(keep.cleanupToken, 0, 1000);

  const summary = transaction.close();

  assert.deepEqual(summary, { removed: 1, retained: 1 });
  assert.equal(fs.existsSync(remove.path), false);
  assert.equal(fs.existsSync(keep.path), true);
  assert.equal(reference.retryPath, keep.path);
  assert.equal(reference.retryExpiresAt, '1970-01-01T00:00:01.000Z');
});

test('rollback removes the entire owned transaction directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-txn-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  transaction.write(Buffer.from('a'), 'image.png');

  transaction.rollback();

  assert.equal(fs.existsSync(transaction.directory), false);
});

test('expired transaction cleanup stays within its owned prefix', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-txn-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transaction = createTempFileTransaction({ tempRoot: root });
  transaction.write(Buffer.from('a'), 'image.png');
  fs.utimesSync(transaction.directory, new Date(0), new Date(0));

  assert.equal(cleanupExpiredTransactions(Date.now(), 1000, { tempRoot: root }), 1);
  assert.equal(fs.existsSync(transaction.directory), false);
});
