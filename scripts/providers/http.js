const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function configuredTimeoutMs() {
  const value = Number(process.env.VISION_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function bypassesProxy(hostname) {
  const entries = String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  return entries.some((entry) => {
    if (entry === '*') return true;
    const normalized = entry.split(':')[0].replace(/^\./, '');
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function proxyAgentFor(url) {
  if (bypassesProxy(url.hostname)) return null;
  const proxyUrl = url.protocol === 'https:'
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    : process.env.HTTP_PROXY || process.env.http_proxy;
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
}

function nativeRequest(urlValue, options, timeoutMs) {
  const url = new URL(urlValue);
  const transport = url.protocol === 'https:' ? https : http;
  const proxyAgent = proxyAgentFor(url);
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: { ...options.headers, Connection: 'close' },
      agent: proxyAgent || false,
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Provider 响应超过 2MB 安全上限'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(overallTimer);
        if (proxyAgent) proxyAgent.destroy();
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          text: async () => body,
        });
      });
      response.on('error', (error) => {
        clearTimeout(overallTimer);
        if (proxyAgent) proxyAgent.destroy();
        reject(error);
      });
    });
    const overallTimer = setTimeout(() => request.destroy(new Error(`请求超过 ${timeoutMs}ms`)), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求空闲超过 ${timeoutMs}ms`)));
    request.on('error', (error) => {
      clearTimeout(overallTimer);
      if (proxyAgent) proxyAgent.destroy();
      reject(error);
    });
    request.end(options.body);
  });
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs = configuredTimeoutMs()) {
  if (!fetchImpl) return nativeRequest(url, options, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超过 ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  bypassesProxy,
  configuredTimeoutMs,
  fetchWithTimeout,
  nativeRequest,
  proxyAgentFor,
};
