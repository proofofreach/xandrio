/** Shared SSRF-safe, bounded remote HTTP primitives. */
const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const { Readable, Transform } = require('stream');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Proxy agents are keyed by URL so a single agent (and its socket pool) is
// reused across requests to the same egress proxy.
const proxyAgentCache = new Map();
function proxyAgentFor(proxyUrl) {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl);
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

function isRestrictedIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function ipv6Bytes(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const [left, right = ''] = normalized.split('::');
  if (normalized.split('::').length > 2) return null;
  const expandIpv4 = parts => {
    const last = parts.at(-1);
    if (!last || !last.includes('.')) return parts;
    if (net.isIP(last) !== 4) return null;
    const octets = last.split('.').map(Number);
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const leftParts = expandIpv4(left ? left.split(':') : []);
  const rightParts = expandIpv4(right ? right.split(':') : []);
  if (!leftParts || !rightParts) return null;
  const parts = normalized.includes('::') ? [...leftParts, ...Array(8 - leftParts.length - rightParts.length).fill('0'), ...rightParts] : leftParts;
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return Buffer.from(parts.flatMap(part => {
    const value = parseInt(part, 16);
    return [value >> 8, value & 0xff];
  }));
}

function isRestrictedIpv6(address) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const isZero = bytes.every(byte => byte === 0);
  const isLoopback = bytes.subarray(0, 15).every(byte => byte === 0) && bytes[15] === 1;
  const ipv4Mapped = bytes.subarray(0, 12).every(byte => byte === 0) ||
    (bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff);
  if (isZero || isLoopback) return true;
  if (ipv4Mapped) return isRestrictedIpv4([...bytes.subarray(12)].join('.'));
  if ((bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || bytes[0] === 0xff) return true;
  return (bytes[0] & 0xe0) !== 0x20 || (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8);
}

function isPublicAddress(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(value);
  return family === 4 ? !isRestrictedIpv4(value) : family === 6 ? !isRestrictedIpv6(value) : false;
}

function isSafeRemoteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    return Boolean(hostname) && hostname !== 'localhost' && !hostname.endsWith('.localhost') && !hostname.endsWith('.local') &&
      (!net.isIP(hostname) || isPublicAddress(hostname));
  } catch { return false; }
}

async function boundedLookup(hostname, lookupImpl, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => lookupImpl(hostname, { all: true, verbatim: true })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Remote DNS lookup timed out')), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

async function assertPublicTarget(url, lookupImpl, timeoutMs) {
  if (!isSafeRemoteUrl(url)) throw new Error('Remote URL is not a safe public HTTPS URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(hostname) ? [{ address: hostname }] : await boundedLookup(hostname, lookupImpl, timeoutMs);
  if (!Array.isArray(records) || !records.length || records.some(record => !isPublicAddress(record?.address))) {
    throw new Error('Remote hostname does not resolve exclusively to public addresses');
  }
  return { address: records[0].address, family: records[0].family || net.isIP(records[0].address) };
}

// Route a request through an egress HTTP CONNECT proxy instead of pinning the
// destination IP. Used for the book-acquisition providers when BOOK_PROXY_URL
// points at a proxy that lives in a separate egress network namespace (VPN).
// The proxy performs its own DNS and connection, so IP pinning does not apply;
// assertPublicTarget has already validated the destination host resolves to
// public addresses before this is reached.
function proxiedHttpsFetch(url, options, proxyUrl, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    const headers = new Headers();
    const request = requestImpl(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      agent: proxyAgentFor(proxyUrl)
    }, response => {
      for (const [name, value] of Object.entries(response.headers || {})) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, String(item));
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 502,
        statusText: response.statusMessage || '',
        headers
      }));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

function pinnedHttpsFetch(url, options, target, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    const headers = new Headers();
    const request = requestImpl(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      // Preserve the URL hostname for TLS SNI and Host while preventing a
      // second DNS resolution from selecting a rebinding address.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }
    }, response => {
      for (const [name, value] of Object.entries(response.headers || {})) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, String(item));
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode || 502,
        statusText: response.statusMessage || '',
        headers
      }));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

async function requestRemote(initialUrl, options = {}) {
  const lookupImpl = options.lookupImpl || dns.lookup;
  const timeoutMs = Number(options.timeoutMs || 12000);
  const maxRedirects = Number(options.maxRedirects ?? 3);
  const headersForUrl = options.headersForUrl || (() => ({}));
  const initial = new URL(initialUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort();
  };
  let current = initial;
  let currentMethod = String(options.method || 'GET').toUpperCase();
  let currentBody = options.body;
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const target = await assertPublicTarget(current, lookupImpl, timeoutMs);
      const requestOptions = {
        redirect: 'manual',
        signal: controller.signal,
        method: currentMethod,
        body: currentBody,
        headers: headersForUrl(current, initial)
      };
      const response = options.fetchImpl
        ? await options.fetchImpl(current, requestOptions)
        : options.proxyUrl
          ? await proxiedHttpsFetch(current, requestOptions, options.proxyUrl, options.requestImpl)
          : await pinnedHttpsFetch(current, requestOptions, target, options.requestImpl);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, close };
      if (redirects === maxRedirects) throw new Error('Remote request exceeded redirect limit');
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('Remote redirect had no location');
      await response.body?.cancel?.().catch(() => {});
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      current = new URL(location, current);
    }
  } catch (error) {
    close();
    throw error;
  }
  close();
  throw new Error('Remote request exceeded redirect limit');
}

function declaredLength(response) {
  const value = Number(response.headers?.get?.('content-length'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readBoundedBuffer(response, maxBytes) {
  const length = declaredLength(response);
  if (length !== null && length > maxBytes) throw new Error('Remote response exceeds the allowed size');
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new Error('Remote response exceeds the allowed size');
    return data;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) throw new Error('Remote response exceeds the allowed size');
    chunks.push(data);
  }
  return Buffer.concat(chunks, bytes);
}

function byteLimit(maxBytes) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maxBytes ? new Error('Remote response exceeds the allowed size') : null, chunk);
  }});
}

module.exports = { isPublicAddress, isSafeRemoteUrl, assertPublicTarget, requestRemote, declaredLength, readBoundedBuffer, byteLimit };
