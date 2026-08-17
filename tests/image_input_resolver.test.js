const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const sharp = require('sharp');
const {
  ImageStandardizationError,
  standardizeImageInput,
  standardizeInternalDataUrl,
} = require('../scripts/image_input_resolver');

async function pngBuffer() {
  return sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
}

test('public input rejects Data URLs', async () => {
  const png = await pngBuffer();
  const input = `data:image/png;base64,${png.toString('base64')}`;

  await assert.rejects(standardizeImageInput(input), (error) => (
    error instanceof ImageStandardizationError && /Data URLs are not accepted/.test(error.message)
  ));
});

test('public input rejects bare Base64', async () => {
  const png = await pngBuffer();

  await assert.rejects(standardizeImageInput(png.toString('base64')), (error) => (
    error instanceof ImageStandardizationError && /Bare Base64 is not accepted/.test(error.message)
  ));
});

test('public input rejects raw SVG text while SVG files remain format inputs', async () => {
  await assert.rejects(standardizeImageInput('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), (error) => (
    error instanceof ImageStandardizationError && /Raw SVG text is not accepted/.test(error.message)
  ));
});

test('internal session adapters can standardize Data URLs', async () => {
  const png = await pngBuffer();
  const result = await standardizeInternalDataUrl(`data:image/png;base64,${png.toString('base64')}`);

  assert.equal(result.mime, 'image/png');
  assert.ok(Buffer.isBuffer(result.data));
});

test('file URLs resolve through the public input gateway', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-bridge-file-url-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'image.png');
  fs.writeFileSync(file, await pngBuffer());

  const result = await standardizeImageInput(pathToFileURL(file).toString());

  assert.equal(result.mime, 'image/png');
});
