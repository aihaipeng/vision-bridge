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

const MAX_DOWNLOAD_MB = 32;
const REMOTE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = MAX_DOWNLOAD_MB * 1024 * 1024;
const BING_THUMBNAIL_HOSTS = new Set(['bing.com', 'www.bing.com', 'cn.bing.com']);

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

function clipboardImagePath() {
  if (process.platform !== 'win32') {
    raiseImageError('错误: clipboard 模式仅支持 Windows，请把图片保存成文件后再提供路径');
  }
  const tmp = path.join(os.tmpdir(), `vision_clip_${process.pid}.png`);
  const save = spawnSync('powershell', ['-NoProfile', '-Sta', '-Command', "$ErrorActionPreference='Stop'; try { $img = Get-Clipboard -Format Image } catch { $img = $null }; if ($img) { $img.Save('" + tmp.replace(/'/g, "''") + "') } else { exit 1 }"] , { stdio: 'ignore' });
  if (save.status === 0 && fs.existsSync(tmp)) return { filePath: tmp, isTemp: true };
  const files = spawnSync('powershell', ['-NoProfile', '-Sta', '-Command', "$ErrorActionPreference='Stop'; try { $f = Get-Clipboard -Format FileDropList } catch { $f = $null }; if ($f -and $f.Count -gt 0) { Write-Output $f[0].FullName } else { exit 1 }"], { encoding: 'utf8' });
  if (files.status === 0) {
    const filePath = (files.stdout || '').trim().split(/\r?\n/)[0];
    if (filePath && fs.existsSync(filePath)) return { filePath, isTemp: false };
  }
  raiseImageError('错误: 剪贴板中没有图片。请重新用截图工具或右键复制图片，或先把图片保存成文件再提供路径');
}

function resolveLocalImage(filePath, source) {
  filePath = path.resolve(filePath);
  if (filePath.startsWith('\\\\')) raiseImageError('错误: 不支持 UNC 网络共享路径，请先复制到本地磁盘后再提供');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) raiseImageError(`错误: 文件不存在: ${source}`);
  const size = fs.statSync(filePath).size;
  if (size > MAX_DOWNLOAD_BYTES) raiseImageError(`错误: 本地图片超过 ${MAX_DOWNLOAD_MB}MB 限制，请先压缩或裁剪后再提供`);
  return { data: fs.readFileSync(filePath), source };
}

function isPublicIp(ip) {
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  const family = net.isIP(ip);
  if (family) return !NON_PUBLIC_IPS.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  raiseImageError(`错误: 远程主机解析到了非法地址: ${ip}`);
}

function createPinnedLookup(addresses) {
  const records = addresses.map((address) => ({ address, family: net.isIP(address) }));
  if (!records.length || records.some((record) => !record.family)) {
    raiseImageError('错误: 远程主机没有可固定的有效 IP 地址');
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

async function ensurePublicHttpUrl(inputUrl) {
  const url = normalizeRemoteUrl(inputUrl);
  if (!['http:', 'https:'].includes(url.protocol)) raiseImageError(`错误: 不支持的远程 URL 协议: ${url.protocol}`);
  if (url.username || url.password) raiseImageError('错误: 远程 URL 不允许包含用户名或密码');
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length) raiseImageError(`错误: 远程主机 ${url.hostname} 未解析到有效地址`);
  const addresses = records.map((r) => r.address);
  for (const address of addresses) {
    if (!isPublicIp(address)) raiseImageError(`错误: 仅允许公开远程 URL，主机 ${url.hostname} 解析到了非公网地址 ${address}`);
  }
  return { url, addresses };
}

function readResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        res.destroy(new ImageStandardizationError(`错误: 远程图片下载后超过 ${MAX_DOWNLOAD_MB}MB 限制`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function requestRemote(currentUrl, redirectsLeft) {
  const { url, addresses } = await ensurePublicHttpUrl(currentUrl);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { 'User-Agent': 'img2txt/1.0' },
      lookup: createPinnedLookup(addresses),
      servername: url.hostname,
      timeout: REMOTE_TIMEOUT_MS,
    }, async (res) => {
      try {
        const remoteAddress = res.socket && res.socket.remoteAddress ? res.socket.remoteAddress : addresses[0];
        if (!isPublicIp(remoteAddress)) throw new ImageStandardizationError(`错误: 远程主机 ${url.hostname} 实际连接到了非公网地址 ${remoteAddress}`);
        if ([301,302,303,307,308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) throw new ImageStandardizationError(`错误: 远程 URL 重定向次数超过 ${MAX_REDIRECTS} 次限制`);
          const location = res.headers.location;
          if (!location) throw new ImageStandardizationError('错误: 远程 URL 返回了空的重定向地址');
          res.resume();
          resolve(requestRemote(new URL(location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = (await readResponse(res)).toString('utf8').slice(0, 300);
          throw new ImageStandardizationError(`错误: 下载远程图片失败，HTTP ${res.statusCode}: ${detail}`);
        }
        resolve(readResponse(res));
      } catch (error) {
        reject(error);
      }
    });
    req.on('timeout', () => req.destroy(new ImageStandardizationError('错误: 下载远程图片超时')));
    req.on('error', reject);
    req.end();
  });
}

async function resolveRemoteImage(inputUrl) {
  const data = await requestRemote(inputUrl, MAX_REDIRECTS);
  return { data, source: inputUrl };
}

function resolveDataUrl(input) {
  const [header, payload] = input.split(',', 2);
  if (payload === undefined) raiseImageError('错误: Data URL 格式不完整，缺少逗号分隔符');
  const meta = header.slice(5);
  if (!meta.toLowerCase().startsWith('image/')) raiseImageError('错误: Data URL 仅支持 image/* 媒体类型');
  let data;
  if (meta.toLowerCase().includes(';base64')) {
    const compact = payload.replace(/\s+/g, '');
    const estimatedSize = Math.floor(compact.length * 3 / 4);
    if (estimatedSize > MAX_DOWNLOAD_BYTES) raiseImageError(`错误: Data URL 解码后超过 ${MAX_DOWNLOAD_MB}MB 限制`);
    try { data = Buffer.from(compact, 'base64'); } catch { raiseImageError('错误: Data URL 中的图片数据不是有效的 Base64'); }
  } else {
    data = Buffer.from(decodeURIComponent(payload), 'utf8');
  }
  return { data, source: 'data-url' };
}

function resolveBareBase64(input) {
  const compact = input.replace(/\s+/g, '');
  if (compact.length < 16) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return null;
  const estimatedSize = Math.ceil(compact.length / 4) * 3;
  if (estimatedSize > MAX_DOWNLOAD_BYTES) raiseImageError(`错误: Base64 图片解码后超过 ${MAX_DOWNLOAD_MB}MB 限制`);
  let data;
  try { data = Buffer.from(compact, 'base64'); } catch { return null; }
  return { data, source: 'base64' };
}

function looksLikeLocalPath(value) {
  if (path.isAbsolute(value)) return true;
  if (/^\.{1,2}[\\/]/.test(value) || /[\\/]/.test(value)) return true;
  return /^[^<>:"|?*\r\n]+\.[A-Za-z0-9]{1,16}$/.test(value);
}

async function resolveImageInput(input) {
  const value = String(input || '').trim();
  if (!value) raiseImageError('错误: 图片输入不能为空');
  if (value === 'clipboard') {
    const { filePath, isTemp } = clipboardImagePath();
    try { return resolveLocalImage(filePath, 'clipboard'); }
    finally { if (isTemp && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true }); }
  }
  if (/^<svg\b/i.test(value) || (/^<\?xml\b/i.test(value) && /<svg\b/i.test(value))) {
    return { data: Buffer.from(value, 'utf8'), source: 'svg-text' };
  }
  if (value.toLowerCase().startsWith('data:')) return resolveDataUrl(value);
  if (value.toLowerCase().startsWith('http://') || value.toLowerCase().startsWith('https://')) return resolveRemoteImage(value);
  if (value.toLowerCase().startsWith('file://')) return resolveLocalImage(fileURLToPath(value), value);
  if (value.startsWith('\\\\')) raiseImageError('错误: 不支持 UNC 网络共享路径，请先复制到本地磁盘后再提供');
  if (fs.existsSync(value)) return resolveLocalImage(value, value);
  const resolved = resolveBareBase64(value);
  if (resolved) return resolved;
  if (looksLikeLocalPath(value)) {
    raiseImageError(`错误: 文件不存在或当前会话无法访问: ${value}。如果这是聊天附件，请重新上传为带真实路径的附件，或提供图片的绝对路径`);
  }
  raiseImageError(`错误: 无法识别图片输入，请提供本地路径、公开 http(s) URL、data URL、裸 Base64 或 clipboard: ${input}`);
}

async function standardizeImageInput(input) {
  try {
    return await canonicalizeImage(await resolveImageInput(input));
  } catch (error) {
    if (error instanceof ImageStandardizationError) throw error;
    if (error instanceof ImagePreparationError) raiseImageError(`错误: ${error.message}`);
    raiseImageError(`错误: 图片输入处理失败: ${error.message || error}`);
  }
}

module.exports = {
  createPinnedLookup,
  ImageStandardizationError,
  isPublicIp,
  MAX_DOWNLOAD_MB,
  normalizeRemoteUrl,
  standardizeImageInput,
};
