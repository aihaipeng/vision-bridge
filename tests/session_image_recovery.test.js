const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { createPngBytes, createTempDir } = require('./helpers');
const {
  claudeCandidateFromEntry,
  findClaudeCandidates,
  findOpenCodeCandidates,
  materializeCandidate,
  openCodePowerShellCommand,
  parseArguments,
  selectCandidate,
} = require('../scripts/recover_session_images');

function dataUrl(bytes, mime = 'image/png') {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

test('parses safe session recovery arguments', () => {
  assert.deepEqual(
    parseArguments(['--client', 'claude', '--cwd', 'C:/work', '--max-age-minutes', '5']),
    {
      client: 'claude',
      cwd: 'C:/work',
      maxAgeMinutes: 5,
      homeDir: require('os').homedir(),
    },
  );
  assert.throws(() => parseArguments(['--client', 'unknown', '--cwd', 'C:/work']), /仅支持/);
  assert.throws(() => parseArguments(['--client', 'auto']), /需要 --cwd/);
  assert.throws(() => parseArguments(['--session', "ses_bad'; DROP TABLE session;--"]), /格式无效/);
});

test('extracts only base64 image parts from Claude Code user messages', async () => {
  const png = await createPngBytes();
  const candidate = claudeCandidateFromEntry({
    type: 'user',
    uuid: 'message-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    cwd: 'C:/work',
    timestamp: '2026-08-16T01:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '[Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
      ],
    },
  });
  assert.equal(candidate.client, 'claude');
  assert.equal(candidate.images.length, 1);
  assert.equal(candidate.images[0].dataUrl, dataUrl(png));
  assert.equal(candidate.images[0].originalName, null);
});

test('finds the latest Claude Code image turn for the requested cwd', async (t) => {
  const png = await createPngBytes();
  const home = createTempDir(t, 'img2txt-claude-home-');
  const project = path.join(home, '.claude', 'projects', 'fixture');
  fs.mkdirSync(project, { recursive: true });
  const sessionPath = path.join(project, '11111111-1111-1111-1111-111111111111.jsonl');
  const entry = {
    type: 'user',
    uuid: 'message-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    cwd: 'C:/target',
    timestamp: '2026-08-16T01:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }],
    },
  };
  fs.writeFileSync(sessionPath, `${JSON.stringify(entry)}\n`);
  const now = Date.parse('2026-08-16T01:01:00.000Z');
  fs.utimesSync(sessionPath, new Date(now), new Date(now));

  const found = findClaudeCandidates({ homeDir: home, cwd: 'C:/target', now, maxAgeMs: 120000 });
  assert.equal(found.length, 1);
  assert.equal(found[0].messageId, 'message-1');
  assert.deepEqual(findClaudeCandidates({ homeDir: home, cwd: 'C:/other', now, maxAgeMs: 120000 }), []);
});

test('reads OpenCode image file parts without exposing message text', async () => {
  const png = await createPngBytes();
  const queries = [];
  const queryDb = (query) => {
    queries.push(query);
    if (query.startsWith('SELECT s.id')) {
      return [{
        session_id: 'ses_abc123',
        directory: 'C:/target',
        message_id: 'msg_abc123',
        part_id: 'prt_abc123',
        time_created: Date.parse('2026-08-16T01:00:00.000Z'),
      }];
    }
    return [{ data: JSON.stringify({ type: 'file', mime: 'image/png', filename: 'image.png', url: dataUrl(png) }) }];
  };
  const found = findOpenCodeCandidates({
    cwd: 'C:/target',
    now: Date.parse('2026-08-16T01:01:00.000Z'),
    maxAgeMs: 120000,
    queryDb,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].images[0].originalName, 'image.png');
  assert.equal(found[0].images[0].dataUrl, dataUrl(png));
  assert.ok(queries.every((query) => !query.includes('message text')));
});

test('uses the Windows cmd shim before the PowerShell shim for OpenCode', () => {
  const command = openCodePowerShellCommand();
  assert.match(command, /Get-Command opencode\.cmd/);
  assert.ok(command.indexOf('opencode.cmd') < command.indexOf('Get-Command opencode -ErrorAction'));
  assert.match(command, /OutputEncoding/);
});

test('refuses ambiguous recent sessions instead of guessing', () => {
  const newest = {
    client: 'opencode', sessionId: 'ses_one', createdAt: 20000, images: [{}],
  };
  const concurrent = {
    client: 'claude', sessionId: '22222222-2222-2222-2222-222222222222', createdAt: 10000, images: [{}],
  };
  assert.throws(() => selectCandidate([newest, concurrent]), /拒绝猜测/);
  assert.equal(selectCandidate([newest, { ...concurrent, createdAt: 1000 }]), newest);
});

test('materializes recovered images through the canonical input gateway', async (t) => {
  const png = await createPngBytes();
  const tempRoot = createTempDir(t, 'img2txt-session-output-');
  const result = await materializeCandidate({
    client: 'opencode',
    sessionId: 'ses_abc123',
    messageId: 'msg_abc123',
    createdAt: Date.now(),
    images: [{ dataUrl: dataUrl(png), mime: 'image/png', originalName: 'image.png' }],
  }, { tempRoot });
  assert.equal(result.source, 'conversation-session');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mime, 'image/png');
  assert.ok(fs.existsSync(result.images[0].path));
  assert.ok(fs.readFileSync(result.images[0].path).equals(png));
  assert.doesNotMatch(JSON.stringify(result), /base64|iVBOR/);
});
