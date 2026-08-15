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
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    return { ...image, data, mime: 'image/png' };
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

function needsAutoOrient(metadata) {
  return Number.isInteger(metadata.orientation) && metadata.orientation > 1;
}

async function normalizeCanonicalOrientation(image, metadata) {
  if (!needsAutoOrient(metadata)) return image;
  const pipeline = loadSharp()(image.data, inputOptions()).autoOrient();
  const data = image.mime === 'image/png'
    ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  return { ...image, data };
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

  if (metadata.format === 'jpeg') {
    return normalizeCanonicalOrientation({ ...image, mime: 'image/jpeg' }, metadata);
  }
  if (metadata.format === 'png') {
    return normalizeCanonicalOrientation({ ...image, mime: 'image/png' }, metadata);
  }

  try {
    const pipeline = loadSharp()(image.data, inputOptions());
    if (metadata.format === 'svg') {
      return { ...image, data: await pipeline.png().toBuffer(), mime: 'image/png' };
    }
    if (metadata.hasAlpha) {
      return {
        ...image,
        data: await pipeline
          .autoOrient()
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toBuffer(),
        mime: 'image/png',
      };
    }
    return {
      ...image,
      data: await pipeline
        .autoOrient()
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

function compressionCandidates(metadata, profile) {
  const inputMaxSide = Math.max(metadata.width, metadata.height);
  const seen = new Set();
  const candidates = [];
  for (const entry of profile.compressionProfiles) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ImagePreparationError('图片压缩档位配置无效');
    }
    const [configuredMaxSide, maxQuality] = entry;
    if (!Number.isInteger(configuredMaxSide) || configuredMaxSide <= 0
      || !Number.isInteger(maxQuality) || maxQuality < 1 || maxQuality > 100) {
      throw new ImagePreparationError('图片压缩档位配置无效');
    }
    const maxSide = Math.min(
      configuredMaxSide,
      profile.maxDimension || Number.MAX_SAFE_INTEGER,
      inputMaxSide,
    );
    if (!seen.has(maxSide)) {
      seen.add(maxSide);
      candidates.push({ maxSide, maxQuality });
    }
  }
  return candidates;
}

function encodedImage(image, data, mime, info) {
  return {
    image: { ...image, data, mime },
    metadata: { width: info.width, height: info.height },
  };
}

async function convertToPng(image, maxSide) {
  const { data, info } = await loadSharp()(image.data, inputOptions())
    .autoOrient()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  return encodedImage(image, data, 'image/png', info);
}

function jpegChromaSubsampling(image, pngStats) {
  if (image.mime !== 'image/png') return '4:2:0';
  return pngStats && pngStats.entropy < 6 ? '4:4:4' : '4:2:0';
}

async function convertToJpeg(image, maxSide, quality, mozjpeg, chromaSubsampling) {
  const { data, info } = await loadSharp()(image.data, inputOptions())
    .autoOrient()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality, mozjpeg, chromaSubsampling })
    .toBuffer({ resolveWithObject: true });
  return encodedImage(image, data, 'image/jpeg', info);
}

async function bestJpegAtSize(image, candidate, profile, chromaSubsampling) {
  const configuredMinimum = Number.isInteger(profile.minJpegQuality)
    ? profile.minJpegQuality
    : Math.min(...profile.compressionProfiles.map((entry) => entry[1]));
  const minQuality = Math.min(candidate.maxQuality, Math.max(1, configuredMinimum));
  const maxIterations = Number.isInteger(profile.qualitySearchIterations)
    ? Math.max(0, profile.qualitySearchIterations)
    : 4;
  const qualityBoost = Number.isInteger(profile.mozjpegQualityBoost)
    ? Math.max(0, profile.mozjpegQualityBoost)
    : 4;
  const probeMargin = Number.isInteger(profile.mozjpegProbeMargin)
    ? Math.max(0, profile.mozjpegProbeMargin)
    : 10;
  const probeMinQuality = Math.max(1, minQuality - probeMargin);

  const maximum = await convertToJpeg(image, candidate.maxSide, candidate.maxQuality, false, chromaSubsampling);
  if (fitsProfile(maximum.image, maximum.metadata, profile)) {
    const optimized = await convertToJpeg(image, candidate.maxSide, candidate.maxQuality, true, chromaSubsampling);
    return fitsProfile(optimized.image, optimized.metadata, profile) ? optimized.image : maximum.image;
  }
  if (probeMinQuality === candidate.maxQuality) return null;

  const minimum = await convertToJpeg(image, candidate.maxSide, probeMinQuality, false, chromaSubsampling);
  if (!fitsProfile(minimum.image, minimum.metadata, profile)) return null;

  let best = minimum;
  let bestQuality = probeMinQuality;
  let lower = probeMinQuality + 1;
  let upper = candidate.maxQuality - 1;
  let iterations = 0;
  while (lower <= upper && iterations < maxIterations) {
    const quality = Math.floor((lower + upper) / 2);
    const prepared = await convertToJpeg(image, candidate.maxSide, quality, false, chromaSubsampling);
    if (fitsProfile(prepared.image, prepared.metadata, profile)) {
      best = prepared;
      bestQuality = quality;
      lower = quality + 1;
    } else {
      upper = quality - 1;
    }
    iterations += 1;
  }

  const boostedQuality = Math.min(
    candidate.maxQuality,
    Math.max(minQuality, bestQuality + qualityBoost),
  );
  const optimized = await convertToJpeg(image, candidate.maxSide, boostedQuality, true, chromaSubsampling);
  if (fitsProfile(optimized.image, optimized.metadata, profile)) return optimized.image;
  const conservativeQuality = Math.max(minQuality, bestQuality);
  if (boostedQuality === conservativeQuality) {
    return conservativeQuality === bestQuality ? best.image : null;
  }

  const conservative = await convertToJpeg(image, candidate.maxSide, conservativeQuality, true, chromaSubsampling);
  return fitsProfile(conservative.image, conservative.metadata, profile)
    ? conservative.image
    : null;
}

async function prepareImage(image, profile) {
  if (!profile || !Array.isArray(profile.allowedMimes) || !Number.isInteger(profile.maxBytes)
    || !Array.isArray(profile.compressionProfiles) || profile.compressionProfiles.length === 0) {
    throw new ImagePreparationError('图片准备配置无效');
  }
  if (!image || !CANONICAL_MIMES.has(image.mime)) {
    throw new ImagePreparationError('Provider 仅接受输入网关生成的 JPEG 或 PNG');
  }
  let metadata = await metadataFor(image);
  if (!metadata.width || !metadata.height) throw new ImagePreparationError('无法读取图片尺寸');
  image = await normalizeCanonicalOrientation(image, metadata);
  if (needsAutoOrient(metadata)) metadata = await metadataFor(image);
  if (fitsProfile(image, metadata, profile)) return image;

  const candidates = compressionCandidates(metadata, profile);
  let pngStats;
  if (image.mime === 'image/png') {
    try {
      pngStats = await loadSharp()(image.data, inputOptions()).stats();
    } catch (error) {
      throw new ImagePreparationError(`图片内容分析失败: ${error.message || error}`, error);
    }
  }
  const shouldTryLosslessPng = image.mime === 'image/png'
    && profile.allowedMimes.includes('image/png')
    && (metadata.hasAlpha || pngStats.entropy < 6);
  if (shouldTryLosslessPng) {
    try {
      const optimized = await convertToPng(image, candidates[0].maxSide);
      if (fitsProfile(optimized.image, optimized.metadata, profile)) return optimized.image;
      if (metadata.hasAlpha) {
        for (const candidate of candidates.slice(1)) {
          const prepared = await convertToPng(image, candidate.maxSide);
          if (fitsProfile(prepared.image, prepared.metadata, profile)) return prepared.image;
        }
        throw new ImagePreparationError(`透明图片转换后仍无法满足 ${profile.label} 的上传限制`);
      }
    } catch (error) {
      if (error instanceof ImagePreparationError) throw error;
      throw new ImagePreparationError(`图片转换失败: ${error.message || error}`, error);
    }
  }

  const chromaSubsampling = jpegChromaSubsampling(image, pngStats);
  for (const candidate of candidates) {
    try {
      const prepared = await bestJpegAtSize(image, candidate, profile, chromaSubsampling);
      if (prepared) return prepared;
    } catch (error) {
      if (error instanceof ImagePreparationError) throw error;
      throw new ImagePreparationError(`图片转换失败: ${error.message || error}`, error);
    }
  }

  throw new ImagePreparationError(`图片转换后仍无法满足 ${profile.label} 的上传限制`);
}

module.exports = { canonicalizeImage, ImagePreparationError, MAX_INPUT_PIXELS, prepareImage };
