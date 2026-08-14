const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const {
    DEFAULT_PROMPT,
    RETRY_CACHE_MAX_AGE_MS,
    cleanupRetryCaches,
} = require('../scripts/describe_image');
const { createPngBytes, createTempDir } = require('./helpers');

const cliPath = path.resolve(__dirname, '..', 'scripts', 'describe_image.js');

test('CLI emits one-line errors without stack traces', async (t) => {
    const missingFile = spawnSync(process.execPath, [cliPath, 'Z:/definitely-missing/image.png', '描述图片'], {
        encoding: 'utf8',
    });
    assert.equal(missingFile.status, 1);
    assert.equal(missingFile.stdout, '');
    assert.match(missingFile.stderr, /^\[ERROR\] IMAGE_INPUT:/);
    assert.doesNotMatch(missingFile.stderr, /^\s+at\s/m);

    const tempDir = createTempDir(t);
    const imagePath = path.join(tempDir, 'sample.png');
    fs.writeFileSync(imagePath, await createPngBytes());
    const missingNativeDependency = spawnSync(process.execPath, ['--no-addons', cliPath, imagePath, '描述图片'], {
        encoding: 'utf8',
        env: { ...process.env, VISION_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' },
    });
    assert.equal(missingNativeDependency.status, 1);
    assert.equal(missingNativeDependency.stdout, '');
    assert.match(missingNativeDependency.stderr, /^\[ERROR\] IMAGE_INPUT:/);
    assert.doesNotMatch(missingNativeDependency.stderr, /^\s+at\s/m);
});

test('retry cache cleanup removes only expired cache files', (t) => {
    const suffix = `${process.pid}_${Date.now()}`;
    const prefix = `img2txt_retry_test_${suffix}_`;
    const oldPath = path.join(os.tmpdir(), `${prefix}old.png`);
    const freshPath = path.join(os.tmpdir(), `${prefix}fresh.png`);
    fs.writeFileSync(oldPath, 'old');
    fs.writeFileSync(freshPath, 'fresh');
    t.after(() => {
        fs.rmSync(oldPath, { force: true });
        fs.rmSync(freshPath, { force: true });
    });
    fs.utimesSync(oldPath, new Date(0), new Date(0));

    assert.equal(RETRY_CACHE_MAX_AGE_MS, 24 * 60 * 60 * 1000);
    assert.equal(cleanupRetryCaches(Date.now(), 1000, prefix), 1);
    assert.ok(!fs.existsSync(oldPath));
    assert.ok(fs.existsSync(freshPath));
});

test('Skill command examples are safe for Bash on Windows', () => {
    const skillRoot = path.resolve(__dirname, '..');
    const documentation = [
        fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'),
        fs.readFileSync(path.join(skillRoot, 'references', 'troubleshooting.md'), 'utf8'),
    ].join('\n');

    assert.doesNotMatch(documentation, /node scripts\\describe_image\.js/);
    assert.match(documentation, /```bash[\s\S]*node scripts\/describe_image\.js 'C:\/path\/to\/image\.png'/);
});

test('Skill directly handles image-only and unsupported-image messages', () => {
    const skill = fs.readFileSync(path.resolve(__dirname, '..', 'SKILL.md'), 'utf8');
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] || '';

    assert.equal(DEFAULT_PROMPT, '请详细描述这张图片的内容');
    assert.match(description, /用户仅发送图片/);
    assert.match(description, /Unsupported Image/);
    assert.match(description, /不得询问/);
    assert.match(skill, /用户仅发送图片且没有文字说明时，立即运行脚本并详细描述图片，不询问用途/);
});

test('Skill never treats the clipboard as an implicit attachment fallback', () => {
    const skillRoot = path.resolve(__dirname, '..');
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const troubleshooting = fs.readFileSync(path.join(skillRoot, 'references', 'troubleshooting.md'), 'utf8');

    assert.match(skill, /附件读取失败不构成剪贴板授权/);
    assert.match(skill, /仅当用户明确说明图片位于剪贴板或明确要求读取剪贴板时使用 `clipboard`/);
    assert.match(troubleshooting, /不得自动检查剪贴板/);
});
