const http = require('http');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { cancellationError, throwIfCancelled } = require('../workflow/cancellation');

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
    const signal = options.signal;
    try { throwIfCancelled(signal); } catch (error) { reject(error); return; }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (proxyAgent) proxyAgent.destroy();
      callback(value);
    };
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
          response.destroy(new Error('Provider response exceeds the 2MB safety limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        finish(resolve, {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          text: async () => body,
        });
      });
      response.on('error', (error) => {
        finish(reject, error);
      });
    });
    const overallTimer = setTimeout(() => request.destroy(new Error(`Request exceeded ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => request.destroy(cancellationError(signal));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request was idle for more than ${timeoutMs}ms`)));
    request.on('error', (error) => {
      finish(reject, signal && signal.aborted ? cancellationError(signal, error) : error);
    });
    request.end(options.body);
  });
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs = configuredTimeoutMs()) {
  if (!fetchImpl) return nativeRequest(url, options, timeoutMs);
  const timeoutController = new AbortController();
  const callerSignal = options.signal;
  throwIfCancelled(callerSignal);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  const timer = setTimeout(() => timeoutController.abort(new Error(`Request exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (callerSignal && callerSignal.aborted) throw cancellationError(callerSignal, error);
    throw error;
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
