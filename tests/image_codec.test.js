const assert = require('node:assert/strict');
const test = require('node:test');
const { encodeBase64, encodeDataUrl } = require('../scripts/image_codec');

test('encodeBase64 returns the raw Base64 payload', () => {
  const image = { data: Buffer.from([0x00, 0xff, 0x10]), mime: 'image/png' };

  assert.equal(encodeBase64(image), 'AP8Q');
});

test('encodeDataUrl includes the prepared image MIME type', () => {
  const image = { data: Buffer.from('vision-bridge'), mime: 'image/jpeg' };

  assert.equal(
    encodeDataUrl(image),
    'data:image/jpeg;base64,dmlzaW9uLWJyaWRnZQ==',
  );
});

test('encoding does not mutate the prepared image', () => {
  const data = Buffer.from('image');
  const image = { data, mime: 'image/png' };

  encodeBase64(image);
  encodeDataUrl(image);

  assert.equal(image.data, data);
  assert.equal(image.mime, 'image/png');
});

test('encodeBase64 rejects missing Buffer data', () => {
  assert.throws(() => encodeBase64({ data: 'not-a-buffer', mime: 'image/png' }), {
    name: 'TypeError',
    message: 'Image payload is missing Buffer data',
  });
});

test('encodeDataUrl rejects an invalid MIME type', () => {
  assert.throws(() => encodeDataUrl({ data: Buffer.from('x'), mime: 'text/plain' }), {
    name: 'TypeError',
    message: 'Image payload is missing a valid image/* MIME type',
  });
});
