const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('public docs state the confirmed formats and input boundary', () => {
  const skill = read('SKILL.md');
  const readme = read('README.md');
  const limits = read('references/provider_limits.md');
  const combined = `${skill}\n${readme}\n${limits}`;

  for (const format of ['JPG', 'JPEG', 'PNG', 'WebP', 'TIFF', 'AVIF', 'SVG', 'GIF', 'BMP']) {
    assert.match(combined, new RegExp(`\\b${format}\\b`, 'i'));
  }
  assert.match(skill, /Reject user-supplied Data URLs and bare Base64/);
  assert.match(readme, /默认全局并发为 3/);
  assert.match(readme, /单 Provider 在进程内和整台机器上默认并发均为 1/);
  assert.match(readme, /单批默认最多 3 张/);
  assert.match(readme, /取得\/标准化默认并发为 1/);
  assert.match(readme, /整台机器上默认并发均为 1/);
  assert.match(readme, /create_retry_manifest\.js/);
  assert.match(skill, /VISION_BRIDGE_BATCH_TIMEOUT_MS/);
  assert.match(limits, /VISION_BRIDGE_MAX_BATCH_ITEMS/);
  assert.match(limits, /VISION_BRIDGE_ACQUIRE_CONCURRENCY/);
  assert.match(limits, /VISION_BRIDGE_VERBOSE/);
  assert.match(limits, /image_codec\.js/);
  assert.match(readme, /默认隐藏 Provider 加载日志/);
  assert.match(readme, /\[INFO\] provider loaded: <provider>/);
  assert.match(readme, /不打印模型列表/);
  assert.match(readme, /不包含 `provider` 或 `model` 字段/);
  assert.doesNotMatch(`${skill}\n${readme}`, /\[识别模型: provider\/model\]/);
});

test('public docs no longer advertise Data URL or bare Base64 as accepted inputs', () => {
  const readme = read('README.md');
  const skill = read('SKILL.md');

  assert.doesNotMatch(readme, /\| Data URL \|/);
  assert.doesNotMatch(readme, /\| 裸 Base64 \|/);
  assert.doesNotMatch(skill, /真实来源包括[^\n]*(?:Data URL|裸 Base64)/);
});
