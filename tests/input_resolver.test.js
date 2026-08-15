const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
    clipboardImagePath,
    clipboardSystemName,
    createPinnedLookup,
    isPublicIp,
    normalizeRemoteUrl,
    standardizeImageInput,
    ImageStandardizationError,
} = require('../scripts/image_input_resolver');
const { createPngBytes, createTempDir } = require('./helpers');

test('standardizes data URLs and bare Base64 in memory', async () => {
    const pngBytes = await createPngBytes();
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;

    let image = await standardizeImageInput(dataUrl);
    assert.equal(image.mime, 'image/png');
    assert.ok(image.data.equals(pngBytes));

    image = await standardizeImageInput(pngBytes.toString('base64'));
    assert.equal(image.mime, 'image/png');
    assert.ok(image.data.equals(pngBytes));
});

test('standardizes local paths, extensionless files, file URLs, and SVG text', async (t) => {
    const pngBytes = await createPngBytes();
    const tempDir = createTempDir(t);
    const imagePath = path.join(tempDir, 'sample.png');
    const extensionlessPath = path.join(tempDir, 'clipboard-cache');
    fs.writeFileSync(imagePath, pngBytes);
    fs.writeFileSync(extensionlessPath, pngBytes);

    let image = await standardizeImageInput(imagePath);
    assert.equal(image.mime, 'image/png');
    assert.ok(image.data.equals(pngBytes));

    image = await standardizeImageInput(new URL(`file:///${imagePath.replace(/\\/g, '/')}`).toString());
    assert.equal(image.mime, 'image/png');

    image = await standardizeImageInput(extensionlessPath);
    assert.equal(image.mime, 'image/png');

    image = await standardizeImageInput('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    assert.equal(image.mime, 'image/png');
});

test('reads the macOS clipboard through built-in AppKit with bitmap-first file fallback', async (t) => {
    const pngBytes = await createPngBytes();
    const tempDir = createTempDir(t);
    const calls = [];
    const image = await standardizeImageInput('clipboard', {
        clipboard: {
            platform: 'darwin',
            tmpDir: tempDir,
            pid: 4242,
            spawnSyncImpl(command, args, options) {
                calls.push({ command, args, options });
                fs.writeFileSync(args.at(-1), pngBytes);
                return { status: 0, stdout: 'bitmap\n' };
            },
        },
    });

    assert.equal(image.mime, 'image/png');
    assert.ok(image.data.equals(pngBytes));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'osascript');
    assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    const script = calls[0].args[3];
    assert.match(script, /NSPasteboard\.generalPasteboard/);
    assert.ok(script.indexOf('imageClasses.addObject($.NSImage)') < script.indexOf('urlClasses.addObject($.NSURL)'));
    assert.match(script, /NSPasteboardURLReadingContentsConformToTypesKey/);
    assert.match(script, /NSPasteboardURLReadingFileURLsOnlyKey/);
    assert.equal(fs.existsSync(path.join(tempDir, 'vision_clip_4242.png')), false);
});

test('preserves Windows clipboard file fallback and rejects unsupported platforms', async (t) => {
    const pngBytes = await createPngBytes();
    const tempDir = createTempDir(t);
    const imagePath = path.join(tempDir, 'copied-image.png');
    fs.writeFileSync(imagePath, pngBytes);
    const commands = [];
    const image = await standardizeImageInput('clipboard', {
        clipboard: {
            platform: 'win32',
            tmpDir: tempDir,
            pid: 4343,
            spawnSyncImpl(command) {
                commands.push(command);
                return commands.length === 1
                    ? { status: 1, stdout: '' }
                    : { status: 0, stdout: `${imagePath}\r\n` };
            },
        },
    });

    assert.equal(image.mime, 'image/png');
    assert.deepEqual(commands, ['powershell', 'powershell']);
    assert.throws(
        () => clipboardImagePath({ platform: 'linux' }),
        (error) => error instanceof ImageStandardizationError && /Windows 和 macOS/.test(error.message),
    );
    assert.equal(clipboardSystemName('win32'), 'Windows');
    assert.equal(clipboardSystemName('darwin'), 'macOS');
});

test('rejects unsafe or malformed inputs', async () => {
    const isImageError = (error) => error instanceof ImageStandardizationError;
    await assert.rejects(() => standardizeImageInput('\\\\server\\share\\image.png'), isImageError);
    await assert.rejects(() => standardizeImageInput('http://127.0.0.1/image.png'), isImageError);
    await assert.rejects(() => standardizeImageInput('data:image/png;base64,###'), isImageError);
    await assert.rejects(() => standardizeImageInput('a'.repeat(64)), isImageError);
    await assert.rejects(
        () => standardizeImageInput(`data:image/png;base64,${Buffer.from('<html>not an image</html>').toString('base64')}`),
        isImageError,
    );
    await assert.rejects(
        () => standardizeImageInput('Z:/definitely-missing/image.png'),
        (error) => isImageError(error) && /文件不存在或当前会话无法访问/.test(error.message),
    );
    await assert.rejects(
        () => standardizeImageInput('image.png'),
        (error) => isImageError(error) && /文件不存在或当前会话无法访问: image\.png/.test(error.message),
    );
});

test('returns the DNS callback shape requested by Node', async () => {
    const lookup = createPinnedLookup(['185.199.108.133', '2606:50c0:8000::154']);
    const lookupResult = (options) => new Promise((resolve, reject) => {
        lookup('example.test', options, (error, address, family) => {
            if (error) reject(error);
            else resolve({ address, family });
        });
    });

    const all = await lookupResult({ all: true });
    assert.deepEqual(all.address, [
        { address: '185.199.108.133', family: 4 },
        { address: '2606:50c0:8000::154', family: 6 },
    ]);
    assert.equal(all.family, undefined);

    const single = await lookupResult({ all: false });
    assert.equal(single.address, '185.199.108.133');
    assert.equal(single.family, 4);
});

test('normalizes only Bing thumbnail URLs to the stable global host', () => {
    const query = '?w=193&h=135&c=8&rs=1';
    for (const hostname of ['bing.com', 'www.bing.com', 'cn.bing.com']) {
        const normalized = normalizeRemoteUrl(`https://${hostname}/th/id/OIP.example${query}`);
        assert.equal(normalized.hostname, 'global.bing.com');
        assert.equal(normalized.pathname, '/th/id/OIP.example');
        assert.equal(normalized.search, query);
    }

    assert.equal(
        normalizeRemoteUrl('https://www.bing.com/images/search?q=test').hostname,
        'www.bing.com',
    );
    assert.equal(
        normalizeRemoteUrl('https://example.com/th/id/OIP.example').hostname,
        'example.com',
    );
    assert.equal(
        normalizeRemoteUrl('https://www.bing.com:8443/th/id/OIP.example').hostname,
        'www.bing.com',
    );
});

test('allows only globally routable IP addresses', () => {
    assert.equal(isPublicIp('8.8.8.8'), true);
    assert.equal(isPublicIp('::ffff:8.8.8.8'), true);
    assert.equal(isPublicIp('2001:4860:4860::8888'), true);
    for (const address of [
        '127.0.0.1',
        '192.168.1.1',
        '192.0.2.1',
        '198.18.0.1',
        '198.51.100.1',
        '203.0.113.1',
        '::1',
        '::ffff:127.0.0.1',
        '2001:db8::1',
        'fc00::1',
        'fe80::1',
    ]) {
        assert.equal(isPublicIp(address), false, `${address} must not be treated as globally routable`);
    }
});
