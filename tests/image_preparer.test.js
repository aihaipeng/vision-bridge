const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bmp = require('bmp-ts');
const sharp = require('sharp');
const test = require('node:test');
const { standardizeImageInput } = require('../scripts/image_input_resolver');
const {
    canonicalizeImage,
    MAX_INPUT_PIXELS,
    prepareImage,
} = require('../scripts/image_preparer');
const {
    ZHIPU_MAX_IMAGE_BYTES,
    ZHIPU_MAX_IMAGE_DIMENSION,
    prepareForZhipu,
} = require('../scripts/describe_image');
const { createPngBytes, createTempDir } = require('./helpers');

async function assertZhipuReady(image) {
    const metadata = await sharp(image.data).metadata();
    assert.ok(['image/jpeg', 'image/png'].includes(image.mime));
    assert.ok(image.data.length < ZHIPU_MAX_IMAGE_BYTES);
    assert.ok(metadata.width <= ZHIPU_MAX_IMAGE_DIMENSION);
    assert.ok(metadata.height <= ZHIPU_MAX_IMAGE_DIMENSION);
}

test('canonicalizes every decodable noncanonical format before Provider preparation', async (t) => {
    const pngBytes = await createPngBytes();
    const opaquePngBytes = await sharp(pngBytes).removeAlpha().png().toBuffer();
    const tempDir = createTempDir(t);
    const variants = [
        ['sample.webp', await sharp(opaquePngBytes).webp().toBuffer(), 'image/jpeg'],
        ['sample.tiff', await sharp(opaquePngBytes).tiff().toBuffer(), 'image/jpeg'],
        ['sample.gif', await sharp(opaquePngBytes).gif().toBuffer(), 'image/png'],
        ['sample.bmp', bmp.encode({
            data: Buffer.from([255, 30, 120, 210]),
            width: 1,
            height: 1,
            bitPP: 24,
        }).data, 'image/png'],
    ];

    for (const [name, data, expectedMime] of variants) {
        const filePath = path.join(tempDir, name);
        fs.writeFileSync(filePath, data);
        const standardized = await standardizeImageInput(filePath);
        assert.equal(standardized.mime, expectedMime);
        const prepared = await prepareForZhipu(standardized);
        await assertZhipuReady(prepared);
    }

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const standardizedSvg = await standardizeImageInput(svg);
    assert.equal(standardizedSvg.mime, 'image/png');
    const preparedSvg = await prepareForZhipu(standardizedSvg);
    await assertZhipuReady(preparedSvg);
});

test('normalizes EXIF orientation before removing metadata', async () => {
    const pixels = Buffer.alloc(120 * 60 * 3);
    for (let y = 0; y < 60; y += 1) {
        for (let x = 0; x < 120; x += 1) {
            const offset = (y * 120 + x) * 3;
            pixels[offset] = x < 60 ? 255 : 0;
            pixels[offset + 1] = 0;
            pixels[offset + 2] = x < 60 ? 0 : 255;
        }
    }
    let orientationSix;
    for (let orientation = 2; orientation <= 8; orientation += 1) {
        const input = await sharp(pixels, { raw: { width: 120, height: 60, channels: 3 } })
            .jpeg({ quality: 95 })
            .withMetadata({ orientation })
            .toBuffer();
        const expected = await sharp(input)
            .autoOrient()
            .jpeg({ quality: 95, mozjpeg: true })
            .toBuffer();
        const canonical = await canonicalizeImage({
            data: input,
            mime: 'image/jpeg',
            source: `orientation-${orientation}-test`,
        });
        const metadata = await sharp(canonical.data).metadata();
        assert.ok(canonical.data.equals(expected), `orientation ${orientation} must match Sharp autoOrient`);
        assert.equal(metadata.width, orientation >= 5 ? 60 : 120);
        assert.equal(metadata.height, orientation >= 5 ? 120 : 60);
        assert.equal(metadata.orientation, undefined);
        if (orientation === 6) orientationSix = input;
    }

    const prepared = await prepareImage(
        { data: orientationSix, mime: 'image/jpeg', source: 'direct-orientation-test' },
        {
            label: '方向测试',
            maxBytes: 1_000_000,
            maxDimension: 200,
            allowedMimes: ['image/jpeg', 'image/png'],
            compressionProfiles: [[200, 90]],
        },
    );
    const preparedMetadata = await sharp(prepared.data).metadata();
    assert.equal(preparedMetadata.width, 60);
    assert.equal(preparedMetadata.height, 120);
    assert.equal(preparedMetadata.orientation, undefined);
});

test('preserves transparent content when canonicalizing alpha-capable formats', async () => {
    const transparent = await sharp({
        create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
        input: Buffer.from('<svg width="128" height="128"><rect x="24" y="24" width="80" height="80" fill="white"/></svg>'),
    }]).webp({ lossless: true }).toBuffer();

    const canonical = await canonicalizeImage({ data: transparent, mime: 'image/webp', source: 'alpha-test' });
    const metadata = await sharp(canonical.data).metadata();
    const stats = await sharp(canonical.data).stats();
    assert.equal(canonical.mime, 'image/png');
    assert.equal(metadata.hasAlpha, true);
    assert.equal(stats.channels[3].min, 0);
    assert.equal(stats.channels[3].max, 255);
});

test('keeps alpha as PNG when an oversized transparent image must be resized', async () => {
    const width = 512;
    const height = 512;
    const pixels = crypto.randomBytes(width * height * 4);
    const input = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const prepared = await prepareImage(
        { data: input, mime: 'image/png', source: 'alpha-resize-test' },
        {
            label: '透明图片测试',
            maxBytes: 300_000,
            maxDimension: width,
            allowedMimes: ['image/jpeg', 'image/png'],
            compressionProfiles: [[width, 90], [256, 82], [128, 72]],
        },
    );
    const metadata = await sharp(prepared.data).metadata();
    assert.equal(prepared.mime, 'image/png');
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.isPalette, false);
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 256);
    assert.ok(prepared.data.length < 300_000);
});

test('losslessly optimizes oversized PNG before considering JPEG', async () => {
    const width = 800;
    const height = 600;
    const pixels = Buffer.alloc(width * height * 3, 255);
    for (let y = 20; y < height; y += 40) {
        pixels.fill(20, (y * width + 40) * 3, (y * width + width - 40) * 3);
    }
    const unoptimized = await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png({ compressionLevel: 0 })
        .toBuffer();
    assert.ok(unoptimized.length > 100_000);

    const prepared = await prepareImage(
        { data: unoptimized, mime: 'image/png', source: 'png-lossless-test' },
        {
            label: 'PNG 无损测试',
            maxBytes: 100_000,
            maxDimension: 800,
            allowedMimes: ['image/jpeg', 'image/png'],
            minJpegQuality: 68,
            compressionProfiles: [[800, 90], [400, 80]],
        },
    );
    const decoded = await sharp(prepared.data).raw().toBuffer();
    assert.equal(prepared.mime, 'image/png');
    assert.ok(prepared.data.length < 100_000);
    assert.ok(decoded.equals(pixels));
});

test('searches JPEG quality before reducing dimensions', async () => {
    const width = 1000;
    const height = 750;
    const pixels = crypto.randomBytes(width * height * 3);
    const source = await sharp(pixels, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 96, mozjpeg: true })
        .toBuffer();
    const qualityTarget = await sharp(source)
        .jpeg({ quality: 72, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer();

    const prepared = await prepareImage(
        { data: source, mime: 'image/jpeg', source: 'adaptive-quality-test' },
        {
            label: 'JPEG 自适应测试',
            maxBytes: qualityTarget.length + 1,
            maxDimension: width,
            allowedMimes: ['image/jpeg', 'image/png'],
            minJpegQuality: 68,
            qualitySearchIterations: 6,
            compressionProfiles: [[width, 90], [700, 82], [500, 75]],
        },
    );
    const metadata = await sharp(prepared.data).metadata();
    assert.equal(prepared.mime, 'image/jpeg');
    assert.equal(metadata.width, width);
    assert.equal(metadata.height, height);
    assert.ok(prepared.data.length < qualityTarget.length + 1);
});

test('reduces excessive dimensions and byte size', async (t) => {
    const tooWide = await createPngBytes({ width: ZHIPU_MAX_IMAGE_DIMENSION + 1, height: 2 });
    await assertZhipuReady(await prepareForZhipu({ data: tooWide, mime: 'image/png', source: 'dimension-test' }));

    const noisyPixels = crypto.randomBytes(2500 * 2500 * 3);
    const oversized = await sharp(noisyPixels, {
        raw: { width: 2500, height: 2500, channels: 3 },
    }).png().toBuffer();
    assert.ok(oversized.length >= ZHIPU_MAX_IMAGE_BYTES);

    const tempDir = createTempDir(t);
    const imagePath = path.join(tempDir, 'oversized.png');
    fs.writeFileSync(imagePath, oversized);
    await assertZhipuReady(await prepareForZhipu(await standardizeImageInput(imagePath)));

    await assert.rejects(
        () => prepareForZhipu(
            { data: oversized, mime: 'image/png', source: 'failure-test' },
            { maxBytes: 128, maxDimension: 64, profiles: [[64, 1]] },
        ),
        /无法满足/,
    );
});

test('enforces a finite decompressed pixel limit', async () => {
    assert.equal(MAX_INPUT_PIXELS, 100_000_000);
    const hugeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"></svg>';
    await assert.rejects(
        () => standardizeImageInput(hugeSvg),
        /pixel limit|像素|exceeds/i,
    );
});

test('Provider preparation rejects images that bypass the canonical gateway', async () => {
    const webp = await sharp(await createPngBytes()).webp().toBuffer();
    await assert.rejects(
        () => prepareForZhipu({ data: webp, mime: 'image/webp', source: 'bypass-test' }),
        /仅接受.*JPEG.*PNG/,
    );
});
