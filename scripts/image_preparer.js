let sharpModule;
let bmpModule;

const MAX_INPUT_PIXELS = 100_000_000;
const CANONICAL_MIMES = new Set(['image/jpeg', 'image/png']);

class ImagePreparationError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ImagePreparationError';
  }
}

function loadSharp() {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = require('sharp');
    return sharpModule;
  } catch (error) {
    throw new ImagePreparationError('未找到或无法加载 sharp 依赖，请在 img2txt 目录执行 npm install', error);
  }
}

function loadBmp() {
  if (bmpModule) return bmpModule;
  try {
    bmpModule = require('bmp-ts');
    return bmpModule;
  } catch (error) {
    throw new ImagePreparationError('未找到或无法加载 bmp-ts 依赖，请在 img2txt 目录执行 npm install', error);
  }
}

function isBmp(data) {
  return data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d;
}

function bmpDimensions(data) {
  const headerSize = data.readUInt32LE(14);
  const width = headerSize === 12 ? data.readUInt16LE(18) : data.readInt32LE(18);
  const signedHeight = headerSize === 12 ? data.readUInt16LE(20) : data.readInt32LE(22);
  const height = Math.abs(signedHeight);
  if (width <= 0 || height <= 0) throw new ImagePreparationError('BMP 图片尺寸无效');
  if (width * height > MAX_INPUT_PIXELS) {
    throw new ImagePreparationError(`BMP 图片像素数超过 ${MAX_INPUT_PIXELS} 上限`);
  }
  return { width, height };
}

async function canonicalizeBmp(image) {
  const expected = bmpDimensions(image.data);
  try {
    const decoded = loadBmp().decode(image.data, { toRGBA: true });
    const width = Math.abs(decoded.width);
    const height = Math.abs(decoded.height);
    if (width !== expected.width || height !== expected.height || decoded.data.length !== width * height * 4) {
      throw new Error('解码后的 BMP 像素数据与文件头不一致');
    }
    const data = await loadSharp()(Buffer.from(decoded.data), {
      raw: { width, height, channels: 4 },
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    return { ...image, data, mime: 'image/jpeg' };
  } catch (error) {
    if (error instanceof ImagePreparationError) throw error;
    throw new ImagePreparationError(`BMP 图片解码失败: ${error.message || error}`, error);
  }
}

function inputOptions() {
  return {
    density: 144,
    page: 0,
    pages: 1,
    limitInputPixels: MAX_INPUT_PIXELS,
  };
}

async function metadataFor(image) {
  try {
    return await loadSharp()(image.data, inputOptions()).metadata();
  } catch (error) {
    if (error instanceof ImagePreparationError) throw error;
    throw new ImagePreparationError(`无法读取图片元数据: ${error.message || error}`, error);
  }
}

async function canonicalizeImage(image) {
  if (!image || !Buffer.isBuffer(image.data) || image.data.length === 0) {
    throw new ImagePreparationError('图片数据为空或无效');
  }
  if (isBmp(image.data)) return canonicalizeBmp(image);

  let metadata;
  try {
    metadata = await metadataFor(image);
  } catch (error) {
    if (error instanceof ImagePreparationError) {
      throw new ImagePreparationError(`无法解码图片: ${error.message.replace(/^无法读取图片元数据:\s*/, '')}`, error);
    }
    throw error;
  }
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new ImagePreparationError('无法解码图片或读取有效尺寸');
  }

  if (metadata.format === 'jpeg') return { ...image, mime: 'image/jpeg' };
  if (metadata.format === 'png') return { ...image, mime: 'image/png' };

  try {
    const pipeline = loadSharp()(image.data, inputOptions());
    if (metadata.format === 'svg') {
      return { ...image, data: await pipeline.png().toBuffer(), mime: 'image/png' };
    }
    return {
      ...image,
      data: await pipeline
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer(),
      mime: 'image/jpeg',
    };
  } catch (error) {
    throw new ImagePreparationError(`图片转换为标准格式失败: ${error.message || error}`, error);
  }
}

function fitsProfile(image, metadata, profile) {
  const maxDimension = profile.maxDimension || Number.MAX_SAFE_INTEGER;
  return profile.allowedMimes.includes(image.mime)
    && image.data.length < profile.maxBytes
    && metadata.width <= maxDimension
    && metadata.height <= maxDimension;
}

async function convertToJpeg(image, maxSide, quality) {
  const data = await loadSharp()(image.data, inputOptions())
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return { ...image, data, mime: 'image/jpeg' };
}

async function prepareImage(image, profile) {
  if (!profile || !Array.isArray(profile.allowedMimes) || !Number.isInteger(profile.maxBytes)) {
    throw new ImagePreparationError('图片准备配置无效');
  }
  if (!image || !CANONICAL_MIMES.has(image.mime)) {
    throw new ImagePreparationError('Provider 仅接受输入网关生成的 JPEG 或 PNG');
  }
  let metadata = await metadataFor(image);
  if (!metadata.width || !metadata.height) throw new ImagePreparationError('无法读取图片尺寸');
  if (fitsProfile(image, metadata, profile)) return image;

  for (const [configuredMaxSide, quality] of profile.compressionProfiles) {
    const maxSide = profile.maxDimension
      ? Math.min(configuredMaxSide, profile.maxDimension)
      : configuredMaxSide;
    let prepared;
    try {
      prepared = await convertToJpeg(image, maxSide, quality);
    } catch (error) {
      throw new ImagePreparationError(`图片转换失败: ${error.message || error}`, error);
    }
    metadata = await metadataFor(prepared);
    if (fitsProfile(prepared, metadata, profile)) return prepared;
  }

  throw new ImagePreparationError(`图片转换后仍无法满足 ${profile.label} 的上传限制`);
}

module.exports = { canonicalizeImage, ImagePreparationError, MAX_INPUT_PIXELS, prepareImage };
