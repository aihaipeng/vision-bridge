function requireImageData(image) {
  if (!image || !Buffer.isBuffer(image.data)) {
    throw new TypeError('Image payload is missing Buffer data');
  }
  return image.data;
}

function encodeBase64(image) {
  return requireImageData(image).toString('base64');
}

function encodeDataUrl(image) {
  if (!image || typeof image.mime !== 'string' || !image.mime.startsWith('image/')) {
    throw new TypeError('Image payload is missing a valid image/* MIME type');
  }
  return `data:${image.mime};base64,${encodeBase64(image)}`;
}

module.exports = { encodeBase64, encodeDataUrl };
