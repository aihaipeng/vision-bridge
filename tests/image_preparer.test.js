const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bmp = require('bmp-ts');
const sharp = require('sharp');
const test = require('node:test');
const { standardizeImageInput } = require('../scripts/image_input_resolver');
const { MAX_INPUT_PIXELS } = require('../scripts/image_preparer');
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
    const tempDir = createTempDir(t);
    const variants = [
        ['sample.webp', await sharp(pngBytes).webp().toBuffer()],
        ['sample.tiff', await sharp(pngBytes).tiff().toBuffer()],
        ['sample.gif', await sharp(pngBytes).gif().toBuffer()],
        ['sample.bmp', bmp.encode({
            data: Buffer.from([255, 30, 120, 210]),
            width: 1,
            height: 1,
            bitPP: 24,
        }).data],
    ];

    for (const [name, data] of variants) {
        const filePath = path.join(tempDir, name);
        fs.writeFileSync(filePath, data);
        const standardized = await standardizeImageInput(filePath);
        assert.equal(standardized.mime, 'image/jpeg');
        const prepared = await prepareForZhipu(standardized);
        assert.equal(prepared.mime, 'image/jpeg');
        await assertZhipuReady(prepared);
    }

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const standardizedSvg = await standardizeImageInput(svg);
    assert.equal(standardizedSvg.mime, 'image/png');
    const preparedSvg = await prepareForZhipu(standardizedSvg);
    await assertZhipuReady(preparedSvg);
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
