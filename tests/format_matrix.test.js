const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bmp = require('bmp-ts');
const sharp = require('sharp');
const { ImageStandardizationError, standardizeImageInput } = require('../scripts/image_input_resolver');

async function formatFixtures() {
  const image = sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.8 } },
  });
  const jpeg = await image.clone().flatten({ background: '#ffffff' }).jpeg().toBuffer();
  return new Map([
    ['jpg', jpeg],
    ['jpeg', jpeg],
    ['png', await image.clone().png().toBuffer()],
    ['webp', await image.clone().webp().toBuffer()],
    ['tiff', await image.clone().tiff().toBuffer()],
    ['avif', await image.clone().avif().toBuffer()],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>')],
    ['gif', await image.clone().gif().toBuffer()],
    ['bmp', bmp.encode({
      data: Buffer.from([255, 60, 40, 20, 255, 60, 40, 20, 255, 60, 40, 20, 255, 60, 40, 20]),
      bitPP: 32,
      width: 2,
      height: 2,
    }).data],
  ]);
}

test('all confirmed formats work from local paths and simulated public URLs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-format-matrix-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtures = await formatFixtures();

  for (const [extension, data] of fixtures) {
    const filePath = path.join(directory, `image.${extension}`);
    fs.writeFileSync(filePath, data);
    const local = await standardizeImageInput(filePath);
    assert.ok(['image/jpeg', 'image/png'].includes(local.mime), `${extension} local canonical MIME`);

    const remoteUrl = `https://images.example.test/image.${extension}`;
    const remote = await standardizeImageInput(remoteUrl, {
      resolveRemoteImageImpl: async (value) => {
        assert.equal(value, remoteUrl);
        return { data, source: value };
      },
    });
    assert.ok(['image/jpeg', 'image/png'].includes(remote.mime), `${extension} remote canonical MIME`);
  }
});

test('real decoding ignores forged extensions and rejects corrupt bytes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-format-truth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixtures = await formatFixtures();
  const forged = path.join(directory, 'jpeg-disguised-as.png');
  const corrupt = path.join(directory, 'corrupt.jpg');
  fs.writeFileSync(forged, fixtures.get('jpg'));
  fs.writeFileSync(corrupt, Buffer.from('not-an-image'));

  assert.equal((await standardizeImageInput(forged)).mime, 'image/jpeg');
  await assert.rejects(standardizeImageInput(corrupt), (error) => (
    error instanceof ImageStandardizationError && /Unable to decode image/.test(error.message)
  ));
});
