const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const { CliError } = require('../scripts/errors');
const {
  claudeCandidateFromEntry,
  cleanupRecoveryDirectories,
  materializeCandidate,
  selectCandidate,
} = require('../scripts/recover_session_images');

test('Claude image parts become ordered recovery candidates', () => {
  const candidate = claudeCandidateFromEntry({
    type: 'user',
    timestamp: '2026-08-18T00:00:00.000Z',
    sessionId: 'session-a',
    cwd: 'C:/work',
    message: {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
    },
  }, 'fallback');

  assert.equal(candidate.client, 'claude');
  assert.equal(candidate.images.length, 1);
  assert.equal(candidate.images[0].dataUrl, 'data:image/png;base64,AA==');
});

test('selectCandidate refuses ambiguous recent sessions', () => {
  assert.throws(() => selectCandidate([
    { sessionId: 'ses_A', createdAt: 20_000 },
    { sessionId: 'ses_B', createdAt: 10_000 },
  ]), (error) => error instanceof CliError && error.code === 'SESSION_AMBIGUOUS');
});

test('materializeCandidate writes standardized images and cleanup removes expired directories', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-bridge-recovery-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  const candidate = {
    client: 'claude', sessionId: 'ses_Test', messageId: 'message', createdAt: Date.now(),
    images: [{ dataUrl: `data:image/png;base64,${png.toString('base64')}`, originalName: null }],
  };

  const result = await materializeCandidate(candidate, { tempRoot });

  assert.equal(result.images.length, 1);
  assert.equal(fs.existsSync(result.images[0].path), true);
  const directory = path.dirname(result.images[0].path);
  fs.utimesSync(directory, new Date(0), new Date(0));
  assert.equal(cleanupRecoveryDirectories(Date.now(), tempRoot), 1);
  assert.equal(fs.existsSync(directory), false);
});
