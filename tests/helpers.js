const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

function fakeResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    };
}

async function createPngBytes(options = {}) {
    const width = options.width || 2;
    const height = options.height || 2;
    return sharp({
        create: {
            width,
            height,
            channels: 4,
            background: options.background || { r: 30, g: 120, b: 210, alpha: 1 },
        },
    }).png().toBuffer();
}

function createTempDir(t, prefix = 'img2txt-') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

module.exports = { createPngBytes, createTempDir, fakeResponse };
