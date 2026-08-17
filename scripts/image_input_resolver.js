const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const { URL, fileURLToPath } = require('url');
const { canonicalizeImage, ImagePreparationError } = require('./image_preparer');
const { cancellationError, throwIfCancelled } = require('./workflow/cancellation');

const MAX_DOWNLOAD_MB = 32;
const REMOTE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = MAX_DOWNLOAD_MB * 1024 * 1024;
const BING_THUMBNAIL_HOSTS = new Set(['bing.com', 'www.bing.com', 'cn.bing.com']);
const MACOS_CLIPBOARD_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');

function writeImageAsPng(image, destination) {
  if (!image || image.isNil()) return false;
  const tiffData = image.TIFFRepresentation;
  if (!tiffData || tiffData.length === 0) return false;
  const representation = $.NSBitmapImageRep.imageRepWithData(tiffData);
  if (!representation || representation.isNil()) return false;
  const pngData = representation.representationUsingTypeProperties($.NSPNGFileType, $({}));
  return Boolean(pngData && pngData.writeToFileAtomically($(destination), true));
}

function run(argv) {
  const destination = argv[0];
  const pasteboard = $.NSPasteboard.generalPasteboard;

  const fileOptions = $.NSMutableDictionary.dictionary;
  fileOptions.setObjectForKey($.NSImage.imageTypes, $('NSPasteboardURLReadingContentsConformToTypesKey'));
  fileOptions.setObjectForKey($.NSNumber.numberWithBool(true), $('NSPasteboardURLReadingFileURLsOnlyKey'));
  const urlClasses = $.NSMutableArray.array;
  urlClasses.addObject($.NSURL);
  const urls = pasteboard.readObjectsForClassesOptions(urlClasses, fileOptions);
  if (urls && urls.count > 0) {
    const image = $.NSImage.alloc.initWithContentsOfURL(urls.objectAtIndex(0));
    if (writeImageAsPng(image, destination)) return 'file';
  }

  const imageClasses = $.NSMutableArray.array;
  imageClasses.addObject($.NSImage);
  const images = pasteboard.readObjectsForClassesOptions(imageClasses, $());
  if (images && images.count > 0 && writeImageAsPng(images.objectAtIndex(0), destination)) {
    return 'bitmap';
  }

  throw new Error('clipboard does not contain an image');
}
`;

const NON_PUBLIC_IPS = new net.BlockList();
const NON_PUBLIC_SUBNETS = {
  ipv4: [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ],
  ipv6: [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ],
};
for (const [type, subnets] of Object.entries(NON_PUBLIC_SUBNETS)) {
  for (const [address, prefix] of subnets) NON_PUBLIC_IPS.addSubnet(address, prefix, type);
}

class ImageStandardizationError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = 'ImageStandardizationError';
    this.code = code;
  }
}

function raiseImageError(message, code = 1) {
  throw new ImageStandardizationError(message, code);
}

function clipboardSystemName(platform = process.platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'system';
}

function windowsClipboardImagePath({ spawnSyncImpl, existsSync, tmpDir, pid }) {
  const files = spawnSyncImpl('powershell', ['-NoProfile', '-Sta', '-Command', "$ErrorActionPreference='Stop'; try { $f = Get-Clipboard -Format FileDropList } catch { $f = $null }; if ($f -and $f.Count -gt 0) { Write-Output $f[0].FullName } else { exit 1 }"], { encoding: 'utf8' });
  if (files.status === 0) {
    const filePath = (files.stdout || '').trim().split(/\r?\n/)[0];
    if (filePath && existsSync(filePath)) return { filePath, isTemp: false };
  }
  const tmp = path.join(tmpDir, `vision_clip_${pid}.png`);
  const save = spawnSyncImpl('powershell', ['-NoProfile', '-Sta', '-Command', "$ErrorActionPreference='Stop'; try { $img = Get-Clipboard -Format Image } catch { $img = $null }; if ($img) { $img.Save('" + tmp.replace(/'/g, "''") + "') } else { exit 1 }"] , { stdio: 'ignore' });
  if (save.status === 0 && existsSync(tmp)) return { filePath: tmp, isTemp: true };
  raiseImageError('Error: The clipboard does not contain an image. Copy an image again with a screenshot tool or context menu, or save it as a file and provide its path');
}

function macosClipboardImagePath({ spawnSyncImpl, existsSync, rmSync, tmpDir, pid }) {
  const tmp = path.join(tmpDir, `vision_clip_${pid}.png`);
  const result = spawnSyncImpl('osascript', ['-l', 'JavaScript', '-e', MACOS_CLIPBOARD_SCRIPT, tmp], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0 && existsSync(tmp)) return { filePath: tmp, isTemp: true };
  if (existsSync(tmp)) rmSync(tmp, { force: true });
  if (result.error) {
    raiseImageError(`Error: Unable to invoke the macOS clipboard tool osascript: ${result.error.message || result.error}`);
  }
  raiseImageError('Error: The clipboard does not contain an image. Copy an image again with a screenshot tool or context menu, or save it as a file and provide its path');
}

function clipboardImagePath(options = {}) {
  const dependencies = {
    platform: options.platform ?? process.platform,
    spawnSyncImpl: options.spawnSyncImpl || spawnSync,
    existsSync: options.existsSync || fs.existsSync,
    rmSync: options.rmSync || fs.rmSync,
    tmpDir: options.tmpDir || os.tmpdir(),
    pid: options.pid ?? process.pid,
  };
  if (dependencies.platform === 'win32') return windowsClipboardImagePath(dependencies);
  if (dependencies.platform === 'darwin') return macosClipboardImagePath(dependencies);
  raiseImageError('Error: Clipboard mode supports only Windows and macOS; save the image as a file and provide its path');
}

function resolveLocalImage(filePath, source) {
  filePath = path.resolve(filePath);
  if (filePath.startsWith('\\\\')) raiseImageError('Error: UNC network-share paths are unsupported; copy the image to a local disk first');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) raiseImageError(`Error: File does not exist: ${source}`);
  const size = fs.statSync(filePath).size;
  if (size > MAX_DOWNLOAD_BYTES) raiseImageError(`Error: Local image exceeds the ${MAX_DOWNLOAD_MB}MB limit; compress or crop it first`);
  return { data: fs.readFileSync(filePath), source };
}

function isPublicIp(ip) {
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = net.isIP(ip);
  if (family) return !NON_PUBLIC_IPS.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  raiseImageError(`Error: Remote host resolved to a forbidden address: ${ip}`);
}

function createPinnedLookup(addresses) {
  const records = addresses.map((address) => ({ address, family: net.isIP(address) }));
  if (!records.length || records.some((record) => !record.family)) {
    raiseImageError('Error: Remote host has no valid IP address that can be pinned');
  }
  return (_hostname, options, callback) => {
    if (options && typeof options === 'object' && options.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  };
}

function normalizeRemoteUrl(inputUrl) {
  const url = new URL(inputUrl);
  const hostname = url.hostname.toLowerCase();
  if (!url.port && BING_THUMBNAIL_HOSTS.has(hostname) && /^\/th\/id(?:\/|$)/i.test(url.pathname)) {
    url.hostname = 'global.bing.com';
  }
  return url;
}

async function ensurePublicHttpUrl(inputUrl, options = {}) {
  throwIfCancelled(options.signal);
  const url = normalizeRemoteUrl(inputUrl);
  if (!['http:', 'https:'].includes(url.protocol)) raiseImageError(`Error: Unsupported remote URL protocol: ${url.protocol}`);
  if (url.username || url.password) raiseImageError('Error: Remote URL cannot contain a username or password');
  const records = await dns.lookup(url.hostname, { all: true });
  throwIfCancelled(options.signal);
  if (!records.length) raiseImageError(`Error: Remote host ${url.hostname} did not resolve to a valid address`);
  const addresses = records.map((r) => r.address);
  for (const address of addresses) {
    if (!isPublicIp(address)) raiseImageError(`Error: Only public remote URLs are allowed; host ${url.hostname} resolved to non-public address ${address}`);
  }
  return { url, addresses };
}

function readResponse(res, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => res.destroy(cancellationError(signal));
    if (signal) {
      if (signal.aborted) { reject(cancellationError(signal)); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (callback, value) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const chunks = [];
    let total = 0;
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        res.destroy(new ImageStandardizationError(`Error: Downloaded remote image exceeds the ${MAX_DOWNLOAD_MB}MB limit`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => finish(resolve, Buffer.concat(chunks)));
    res.on('error', (error) => finish(reject, signal && signal.aborted ? cancellationError(signal, error) : error));
  });
}

async function requestRemote(currentUrl, redirectsLeft, options = {}) {
  const { signal } = options;
  throwIfCancelled(signal);
  const { url, addresses } = await ensurePublicHttpUrl(currentUrl, options);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let req;
    const onAbort = () => req.destroy(cancellationError(signal));
    const finish = (callback, value) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { 'User-Agent': 'vision-bridge/1.0' },
      lookup: createPinnedLookup(addresses),
      servername: url.hostname,
      timeout: REMOTE_TIMEOUT_MS,
    }, async (res) => {
      try {
        const remoteAddress = res.socket && res.socket.remoteAddress ? res.socket.remoteAddress : addresses[0];
        if (!isPublicIp(remoteAddress)) throw new ImageStandardizationError(`Error: Remote host ${url.hostname} connected to non-public address ${remoteAddress}`);
        if ([301,302,303,307,308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) throw new ImageStandardizationError(`Error: Remote URL exceeded the ${MAX_REDIRECTS}-redirect limit`);
          const location = res.headers.location;
          if (!location) throw new ImageStandardizationError('Error: Remote URL returned an empty redirect location');
          res.resume();
          finish(resolve, requestRemote(new URL(location, url).toString(), redirectsLeft - 1, options));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = (await readResponse(res, signal)).toString('utf8').slice(0, 300);
          throw new ImageStandardizationError(`Error: Failed to download remote image, HTTP ${res.statusCode}: ${detail}`);
        }
        finish(resolve, readResponse(res, signal));
      } catch (error) {
        finish(reject, error);
      }
    });
    req.on('timeout', () => req.destroy(new ImageStandardizationError('Error: Remote image download timed out')));
    req.on('error', (error) => finish(reject, signal && signal.aborted ? cancellationError(signal, error) : error));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.end();
  });
}

async function resolveRemoteImage(inputUrl, options = {}) {
  const data = await requestRemote(inputUrl, MAX_REDIRECTS, options);
  return { data, source: inputUrl };
}

function resolveDataUrl(input) {
  const [header, payload] = input.split(',', 2);
  if (payload === undefined) raiseImageError('Error: Incomplete Data URL; missing comma delimiter');
  const meta = header.slice(5);
  if (!meta.toLowerCase().startsWith('image/')) raiseImageError('Error: Data URL supports only image/* media types');
  let data;
  if (meta.toLowerCase().includes(';base64')) {
    const compact = payload.replace(/\s+/g, '');
    const estimatedSize = Math.floor(compact.length * 3 / 4);
    if (estimatedSize > MAX_DOWNLOAD_BYTES) raiseImageError(`Error: Decoded Data URL exceeds the ${MAX_DOWNLOAD_MB}MB limit`);
    try { data = Buffer.from(compact, 'base64'); } catch { raiseImageError('Error: Image data in the Data URL is not valid Base64'); }
  } else {
    data = Buffer.from(decodeURIComponent(payload), 'utf8');
  }
  return { data, source: 'data-url' };
}

function looksLikeBareBase64(input) {
  const compact = input.replace(/\s+/g, '');
  return compact.length >= 16
    && /^[A-Za-z0-9+/]*={0,2}$/.test(compact)
    && compact.length % 4 !== 1;
}

function looksLikeLocalPath(value) {
  if (path.isAbsolute(value)) return true;
  if (/^\.{1,2}[\\/]/.test(value) || /[\\/]/.test(value)) return true;
  return /^[^<>:"|?*\r\n]+\.[A-Za-z0-9]{1,16}$/.test(value);
}

async function resolveImageInput(input, options = {}) {
  throwIfCancelled(options.signal);
  const value = String(input || '').trim();
  if (!value) raiseImageError('Error: Image input cannot be empty');
  if (value === 'clipboard') {
    const { filePath, isTemp } = clipboardImagePath(options.clipboard);
    try { return resolveLocalImage(filePath, 'clipboard'); }
    finally { if (isTemp && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true }); }
  }
  if (/^<svg\b/i.test(value) || (/^<\?xml\b/i.test(value) && /<svg\b/i.test(value))) {
    raiseImageError('Error: Raw SVG text is not accepted as user input; provide the SVG through a local path, file URL, or public HTTP(S) URL');
  }
  if (value.toLowerCase().startsWith('data:')) {
    raiseImageError('Error: Data URLs are not accepted as user input; provide a local path, file URL, public HTTP(S) URL, or clipboard');
  }
  if (value.toLowerCase().startsWith('http://') || value.toLowerCase().startsWith('https://')) {
    return (options.resolveRemoteImageImpl || resolveRemoteImage)(value, options);
  }
  if (value.toLowerCase().startsWith('file://')) return resolveLocalImage(fileURLToPath(value), value);
  if (value.startsWith('\\\\')) raiseImageError('Error: UNC network-share paths are unsupported; copy the image to a local disk first');
  if (fs.existsSync(value)) return resolveLocalImage(value, value);
  if (looksLikeBareBase64(value)) {
    raiseImageError('Error: Bare Base64 is not accepted as user input; provide a local path, file URL, public HTTP(S) URL, or clipboard');
  }
  if (looksLikeLocalPath(value)) {
    raiseImageError(`Error: File does not exist or is inaccessible to the current session: ${value}. If this is a chat attachment, upload it again with a real path or provide the image's absolute path`);
  }
  raiseImageError(`Error: Unrecognized image input; provide a local path, file URL, public HTTP(S) URL, or clipboard: ${input}`);
}

async function standardizeImageInput(input, options = {}) {
  try {
    return await canonicalizeImage(await resolveImageInput(input, options));
  } catch (error) {
    if (error instanceof ImageStandardizationError) throw error;
    if (error instanceof ImagePreparationError) raiseImageError(`Error: ${error.message}`);
    raiseImageError(`Error: Image input processing failed: ${error.message || error}`);
  }
}

async function standardizeInternalDataUrl(input) {
  try {
    return await canonicalizeImage(resolveDataUrl(String(input || '').trim()));
  } catch (error) {
    if (error instanceof ImageStandardizationError) throw error;
    if (error instanceof ImagePreparationError) raiseImageError(`Error: ${error.message}`);
    raiseImageError(`Error: Session attachment processing failed: ${error.message || error}`);
  }
}

module.exports = {
  clipboardImagePath,
  clipboardSystemName,
  createPinnedLookup,
  ImageStandardizationError,
  isPublicIp,
  MAX_DOWNLOAD_MB,
  normalizeRemoteUrl,
  resolveImageInput,
  standardizeInternalDataUrl,
  standardizeImageInput,
};
