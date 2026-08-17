const assert = require('node:assert/strict');
const test = require('node:test');
const { createInputItem } = require('../scripts/workflow/contracts');
const { contentHash, resolverValueForSource, standardizeInputItem } = require('../scripts/workflow/input_pipeline');

test('contentHash is deterministic SHA-256 over standardized bytes', () => {
  assert.equal(contentHash(Buffer.from('image')), '6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d');
});

test('resolverValueForSource maps clipboard and rejects unresolved session attachments', () => {
  assert.equal(resolverValueForSource({ kind: 'clipboard' }), 'clipboard');
  assert.throws(() => resolverValueForSource({ kind: 'session_attachment', client: 'claude' }), /exact file path/);
});

test('standardizeInputItem creates a canonical ImageAsset', async () => {
  const item = createInputItem({
    inputId: 'input-1', index: 0, prompt: 'describe',
    source: { kind: 'local_path', value: 'C:/image.png' },
  });
  const data = Buffer.from('canonical-image');
  const asset = await standardizeInputItem(item, {
    standardizeImpl: async (value) => {
      assert.equal(value, 'C:/image.png');
      return { data, mime: 'image/png' };
    },
    dimensionsImpl: async () => ({ width: 10, height: 20 }),
  });

  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.width, 10);
  assert.equal(asset.height, 20);
  assert.equal(asset.contentHash, contentHash(data));
});
