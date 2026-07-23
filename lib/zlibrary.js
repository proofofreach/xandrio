/**
 * Bounded Z-Library EAPI client.  The only persisted credential is a remix
 * session token; passwords deliberately never leave connect().
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { requestRemote, readBoundedBuffer } = require('./remote-fetch');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const AUTH_FILE = path.join(DATA_DIR, 'zlibrary-auth.json');
const DEFAULT_BASE_URL = 'https://go-to-library.sk';
const BUILT_IN_BASE_URLS = Object.freeze([
  'https://go-to-library.sk',
  'https://z-library.sk',
  'https://z-lib.sk',
  'https://z-lib.fm',
  'https://z-lib.gd'
]);
const USER_AGENT = 'Alexandrio/1.0';

const PUBLIC_MESSAGES = {
  ZLIB_NOT_CONFIGURED: 'Connect Z-Library before downloading.',
  ZLIB_AUTH_INVALID: 'The Z-Library credentials were rejected.',
  ZLIB_AUTH_EXPIRED: 'Your Z-Library session expired. Reconnect to continue.',
  ZLIB_TIMEOUT: 'Z-Library did not respond in time.',
  ZLIB_UNAVAILABLE: 'Z-Library is temporarily unavailable.',
  ZLIB_RATE_LIMITED: 'Z-Library is rate limited. Try again shortly.',
  ZLIB_DAILY_LIMIT: 'Your Z-Library daily download limit has been reached.',
  ZLIB_PROTOCOL: 'Z-Library returned an unexpected response.',
  ZLIB_DOWNLOAD_INVALID: 'Z-Library returned an invalid download.'
};

class ZLibraryError extends Error {
  constructor(code, options = {}) {
    super(options.message || PUBLIC_MESSAGES[code] || 'Z-Library request failed.');
    this.name = 'ZLibraryError';
    this.code = code;
    this.statusCode = options.statusCode || statusForCode(code);
    this.publicMessage = options.publicMessage || PUBLIC_MESSAGES[code] || this.message;
    if (options.details) this.details = options.details;
    if (options.retryable !== undefined) this.retryable = options.retryable === true;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.cause) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
  }
}

function statusForCode(code) {
  return ({ ZLIB_NOT_CONFIGURED: 409, ZLIB_AUTH_INVALID: 401, ZLIB_AUTH_EXPIRED: 401,
    ZLIB_TIMEOUT: 504, ZLIB_UNAVAILABLE: 503, ZLIB_RATE_LIMITED: 429,
    ZLIB_DAILY_LIMIT: 429, ZLIB_PROTOCOL: 502, ZLIB_DOWNLOAD_INVALID: 502 })[code] || 502;
}

function createZLibraryClient(options = {}) {
  const fetchImpl = options.fetchImpl;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const lookupImpl = options.lookupImpl || dns.lookup;
  if (typeof lookupImpl !== 'function') throw new TypeError('lookupImpl must be a function');
  const authFile = options.authFile || AUTH_FILE;
  const configuredBaseUrl = options.baseUrl || process.env.ZLIBRARY_BASE_URL || DEFAULT_BASE_URL;
  const configuredFallbackBaseUrls = options.fallbackBaseUrls === undefined
    ? BUILT_IN_BASE_URLS
    : Array.isArray(options.fallbackBaseUrls) ? options.fallbackBaseUrls : [];
  const requestTimeoutMs = positiveInt(options.requestTimeoutMs || process.env.ZLIBRARY_REQUEST_TIMEOUT_MS, 12000);
  const downloadTimeoutMs = positiveInt(options.downloadTimeoutMs || process.env.ZLIBRARY_DOWNLOAD_TIMEOUT_MS, 60000);
  const maxDownloadBytes = positiveInt(options.maxDownloadBytes || process.env.ZLIBRARY_MAX_DOWNLOAD_BYTES, 100 * 1024 * 1024);
  const maxJsonBytes = positiveInt(options.maxJsonBytes || process.env.ZLIBRARY_MAX_JSON_BYTES, 2 * 1024 * 1024);
  const now = options.now || (() => new Date());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timestamp = () => {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  };
  let session = null;
  let anonymousBaseUrl = configuredBaseUrl;
  let cachedStatus = null;

  function hasStoredSession() {
    if (usableSession(session)) return true;
    try {
      const stored = JSON.parse(fsSync.readFileSync(authFile, 'utf8'));
      return usableSession(stored);
    } catch { return false; }
  }

  async function loadSession() {
    if (usableSession(session)) return session;
    let stored;
    try { stored = JSON.parse(await fs.readFile(authFile, 'utf8')); } catch { return null; }
    if (!usableSession(stored)) return null;
    let normalized = normalizeSession(stored, configuredBaseUrl, timestamp);
    if (!isTrustedAuthenticatedBaseUrl(normalized.baseUrl)) {
      normalized = { ...normalized, baseUrl: trustedAuthenticatedBaseUrls()[0] };
    }
    session = normalized;
    anonymousBaseUrl = normalized.baseUrl;
    // Migration is intentionally performed before a remote request so a legacy
    // password is scrubbed even when its old token is already expired.
    if (stored.version !== 2 || stored.email || stored.password || stored.loginAt || stored.baseUrl !== normalized.baseUrl) await persistSession(normalized);
    return session;
  }

  async function persistSession(value) {
    const selectedBaseUrl = safeBaseUrl(value.baseUrl || configuredBaseUrl);
    if (!isTrustedAuthenticatedBaseUrl(selectedBaseUrl)) throw new ZLibraryError('ZLIB_UNAVAILABLE');
    const clean = { version: 2, userId: String(value.userId), userKey: String(value.userKey),
      baseUrl: selectedBaseUrl, verifiedAt: value.verifiedAt || timestamp() };
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    const temporary = `${authFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(clean, null, 2), { mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, authFile);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    session = clean;
    anonymousBaseUrl = clean.baseUrl;
    return clean;
  }

  async function connect({ email, password } = {}) {
    if (!email || !password) throw new ZLibraryError('ZLIB_AUTH_INVALID');
    const baseUrl = safeBaseUrl(configuredBaseUrl);
    let response;
    try {
      response = await jsonRequest('/eapi/user/login', {
        baseUrl, auth: false, retry: false,
        params: { email, password, site_mode: 'books' }
      });
    } catch (error) {
      if (error.code === 'ZLIB_AUTH_EXPIRED') throw new ZLibraryError('ZLIB_AUTH_INVALID', { cause: error });
      throw error;
    }
    const token = parseLogin(response.body, response.headers);
    if (!token) throw new ZLibraryError('ZLIB_AUTH_INVALID');
    const candidate = { ...token, baseUrl, verifiedAt: timestamp() };
    const profile = await fetchProfile(candidate); // validate before persistence
    await persistSession(candidate);
    cachedStatus = statusFromProfile(profile, timestamp);
    return cachedStatus;
  }

  async function disconnect() {
    session = null;
    cachedStatus = null;
    await fs.unlink(authFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return disconnectedStatus();
  }

  async function getStatus() {
    const auth = await loadSession();
    if (!auth) return disconnectedStatus();
    try {
      const validated = await fetchProfileWithRecovery(auth);
      const profile = validated.profile;
      const status = statusFromProfile(profile, timestamp);
      cachedStatus = status;
      session = { ...validated.auth, verifiedAt: status.lastVerifiedAt };
      return status;
    } catch (error) {
      if (error.code === 'ZLIB_AUTH_EXPIRED') return failedStatus('auth-expired', error, true);
      return failedStatus('unavailable', normalizeError(error), true);
    }
  }

  async function search(query, opts = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new ZLibraryError('ZLIB_PROTOCOL', { publicMessage: 'Enter a search query.' });
    const limit = clampLimit(opts.limit);
    const params = { message: query.trim(), limit: String(limit) };
    addList(params, 'extensions[]', opts.extensions || ['epub']);
    addList(params, 'languages[]', opts.languages || []);
    const stored = await loadSession().catch(() => null);
    const preferredBaseUrl = stored?.baseUrl || anonymousBaseUrl;
    try {
      return await searchAtBaseUrl(preferredBaseUrl, params);
    } catch (originalError) {
      if (!retryable(originalError)) throw originalError;
      const attempted = new Set([preferredBaseUrl]);
      for (const baseUrl of trustedFallbackBaseUrls(preferredBaseUrl)) {
        if (attempted.has(baseUrl)) continue;
        attempted.add(baseUrl);
        try {
          const books = await searchAtBaseUrl(baseUrl, params);
          anonymousBaseUrl = baseUrl;
          return books;
        } catch { /* Try the next validated built-in domain. */ }
      }
      const candidates = await discoverDomains(preferredBaseUrl);
      for (const baseUrl of candidates) {
        if (attempted.has(baseUrl)) continue;
        attempted.add(baseUrl);
        try {
          const books = await searchAtBaseUrl(baseUrl, params);
          anonymousBaseUrl = baseUrl;
          return books;
        } catch { /* Try the next validated content domain. */ }
      }
      throw originalError;
    }
  }

  async function searchAtBaseUrl(baseUrl, params) {
    const response = await jsonRequest('/eapi/book/search', { auth: false, baseUrl, params, retry: true });
    const body = response.body;
    if (body && body.success === false) throw responseError(body, response.status);
    const books = body && (body.books || body.data?.books || body.response?.books);
    if (!Array.isArray(books)) throw new ZLibraryError('ZLIB_PROTOCOL');
    return books.map(normalizeBook);
  }

  async function download(result, destinationPath) {
    const auth = await loadSession();
    if (!auth) throw new ZLibraryError('ZLIB_NOT_CONFIGURED');
    if (!result || !result.zlibId || !result.hash || !destinationPath) throw new ZLibraryError('ZLIB_PROTOCOL');
    const validated = await fetchProfileWithRecovery(auth);
    const profile = validated.profile;
    const activeAuth = validated.auth;
    if (profile.downloadsToday >= profile.dailyLimit) {
      throw new ZLibraryError('ZLIB_DAILY_LIMIT', { details: { downloadsToday: profile.downloadsToday, dailyLimit: profile.dailyLimit } });
    }
    const ticket = await jsonRequest(`/eapi/book/${encodeURIComponent(result.zlibId)}/${encodeURIComponent(result.hash)}/file`, {
      auth: activeAuth, method: 'GET', retry: false
    });
    const downloadUrl = ticket.body?.file?.downloadLink || ticket.body?.file?.download_link || ticket.body?.downloadLink;
    if (!downloadUrl) throw new ZLibraryError('ZLIB_DOWNLOAD_INVALID');
    return streamDownload(downloadUrl, destinationPath, activeAuth);
  }

  async function fetchProfileWithRecovery(auth) {
    try {
      return { profile: await fetchProfile(auth), auth };
    } catch (originalError) {
      if (!retryable(originalError)) throw originalError;
      const attempted = new Set([auth.baseUrl]);
      for (const baseUrl of trustedAuthenticatedBaseUrls()) {
        if (attempted.has(baseUrl)) continue;
        attempted.add(baseUrl);
        const candidate = { ...auth, baseUrl };
        try {
          const profile = await fetchProfile(candidate);
          await persistSession(candidate);
          return { profile, auth: candidate };
        } catch (error) {
          if (error.code === 'ZLIB_AUTH_EXPIRED') throw error;
        }
      }
      throw originalError;
    }
  }

  function trustedFallbackBaseUrls(preferredBaseUrl) {
    const urls = [];
    const seen = new Set();
    for (const value of [preferredBaseUrl, configuredBaseUrl, ...configuredFallbackBaseUrls]) {
      try {
        const baseUrl = safeBaseUrl(value);
        if (!seen.has(baseUrl)) {
          seen.add(baseUrl);
          urls.push(baseUrl);
        }
      } catch { /* Ignore unsafe configured fallback entries. */ }
    }
    return urls;
  }

  function trustedAuthenticatedBaseUrls() {
    return trustedFallbackBaseUrls(null);
  }

  function isTrustedAuthenticatedBaseUrl(value) {
    let baseUrl;
    try { baseUrl = safeBaseUrl(value); } catch { return false; }
    return trustedAuthenticatedBaseUrls().includes(baseUrl);
  }

  async function discoverDomains(preferredBaseUrl) {
    const candidates = [];
    const seen = new Set();
    const seeds = [...new Set([preferredBaseUrl, configuredBaseUrl].filter(Boolean))];
    for (const seed of seeds) {
      try {
        const response = await jsonRequest('/eapi/info/domains', {
          auth: false,
          baseUrl: seed,
          method: 'GET',
          retry: true
        });
        if (!Array.isArray(response.body?.domains)) continue;
        for (const entry of response.body.domains) {
          if (entry && typeof entry === 'object' && (entry.contentAvailable === false || entry.isRedirector === true)) continue;
          const value = typeof entry === 'string' ? entry : entry?.domain;
          if (typeof value !== 'string' || !value.trim()) continue;
          try {
            const baseUrl = safeBaseUrl(value.includes('://') ? value : `https://${value}`);
            if (!seen.has(baseUrl)) {
              seen.add(baseUrl);
              candidates.push(baseUrl);
            }
          } catch { /* Ignore unsafe upstream candidates. */ }
        }
        if (candidates.length) return candidates;
      } catch { /* Try the next trusted seed. */ }
    }
    return candidates;
  }

  async function fetchProfile(auth) {
    const response = await jsonRequest('/eapi/user/profile', { auth, method: 'GET', retry: true });
    const user = response.body?.user || response.body?.data?.user || response.body?.response?.user;
    const downloadsToday = numeric(user?.downloads_today ?? user?.downloadsToday);
    const dailyLimit = numeric(user?.downloads_limit ?? user?.downloadsLimit);
    if (!user || downloadsToday === null || dailyLimit === null || downloadsToday < 0 || dailyLimit < 0 || downloadsToday > dailyLimit) {
      throw new ZLibraryError('ZLIB_PROTOCOL');
    }
    return { downloadsToday, dailyLimit };
  }

  async function jsonRequest(endpoint, request = {}) {
    const auth = request.auth === undefined ? await loadSession() : request.auth;
    if (request.auth !== false && !auth) throw new ZLibraryError('ZLIB_NOT_CONFIGURED');
    const baseUrl = safeBaseUrl(request.baseUrl || auth?.baseUrl || configuredBaseUrl);
    const method = request.method || 'POST';
    const parameters = request.params || {};
    const query = formEncode(parameters);
    const url = method === 'GET' && query ? `${baseUrl}${endpoint}?${query}` : `${baseUrl}${endpoint}`;
    const attempts = request.retry && (method === 'GET' || endpoint.endsWith('/search')) ? 2 : 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const remote = await secureRequest(url, {
          method,
          headers: headersFor(auth),
          ...(method !== 'GET' && query ? { body: query } : {})
        }, requestTimeoutMs, 'ZLIB_UNAVAILABLE');
        try {
          const response = remote.response;
          const text = (await readBoundedBuffer(response, maxJsonBytes)).toString('utf8');
          if (looksHtml(response, text)) throw new ZLibraryError('ZLIB_UNAVAILABLE', { statusCode: response.status, retryable: false });
          let body;
          try { body = text ? JSON.parse(text) : {}; } catch { throw new ZLibraryError('ZLIB_PROTOCOL', { statusCode: response.status }); }
          const unsuccessful = body?.success === false || body?.success === 0;
          if (!response.ok || unsuccessful) {
            const authenticatedRejection = auth && request.auth !== false && [400, 401, 403].includes(response.status);
            const error = authenticatedRejection
              ? new ZLibraryError('ZLIB_AUTH_EXPIRED', { statusCode: response.status })
              : endpoint.endsWith('/login') && unsuccessful
              ? new ZLibraryError('ZLIB_AUTH_INVALID', { statusCode: response.status })
              : responseError(body, response.status);
            const retryAfterMs = response.status === 429 ? shortRetryAfterMs(response) : null;
            if (retryAfterMs !== null) {
              error.retryable = true;
              error.retryAfterMs = retryAfterMs;
            }
            if (attempt + 1 < attempts && retryable(error)) { await retryDelay(error, sleep); continue; }
            throw error;
          }
          return { body, headers: response.headers, status: response.status };
        } finally {
          remote.close();
        }
      } catch (error) {
        lastError = normalizeError(error);
        if (attempt + 1 < attempts && retryable(lastError)) { await retryDelay(lastError, sleep); continue; }
        throw lastError;
      }
    }
    throw lastError;
  }

  async function streamDownload(initialUrl, destinationPath, auth) {
    const url = safeDownloadUrl(initialUrl);
    const credentialOrigin = new URL(auth.baseUrl).origin;
    const remote = await secureRequest(url, {
      method: 'GET',
      maxRedirects: 3,
      headersForUrl: current => ({
        'User-Agent': USER_AGENT,
        ...(current.origin === credentialOrigin ? { Cookie: remixCookie(auth) } : {})
      })
    }, downloadTimeoutMs, 'ZLIB_DOWNLOAD_INVALID');
    try {
      const response = remote.response;
      if (!response?.ok || !response.body) throw responseError({}, response?.status || 502, 'ZLIB_DOWNLOAD_INVALID');
      const contentLength = numeric(response.headers.get('content-length'));
      if ((contentLength !== null && (contentLength <= 0 || contentLength > maxDownloadBytes)) || isNonFileResponse(response)) {
        throw new ZLibraryError('ZLIB_DOWNLOAD_INVALID');
      }
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      const partPath = `${destinationPath}.part`;
      let bytes = 0;
      let prefix = Buffer.alloc(0);
      const guard = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
        if (bytes > maxDownloadBytes || looksLikeHtmlBytes(prefix)) callback(new ZLibraryError('ZLIB_DOWNLOAD_INVALID'));
        else callback(null, chunk);
      }});
      try {
        await pipeline(Readable.fromWeb(response.body), guard, fsSync.createWriteStream(partPath, { flags: 'w' }));
        if (!bytes) throw new ZLibraryError('ZLIB_DOWNLOAD_INVALID');
        await fs.rename(partPath, destinationPath);
        return destinationPath;
      } catch (error) {
        await fs.unlink(partPath).catch(() => {});
        throw normalizeError(error, 'ZLIB_DOWNLOAD_INVALID');
      }
    } finally {
      remote.close();
    }
  }

  async function secureRequest(url, requestOptions, timeoutMs, rejectionCode) {
    try {
      return await requestRemote(url, {
        fetchImpl,
        lookupImpl,
        requestImpl: options.requestImpl,
        timeoutMs,
        maxRedirects: requestOptions.maxRedirects ?? 0,
        method: requestOptions.method || 'GET',
        body: requestOptions.body,
        headersForUrl: requestOptions.headersForUrl || (() => requestOptions.headers || {})
      });
    } catch (error) {
      throw normalizeError(error, rejectionCode);
    }
  }

  return {
    hasStoredSession, connect, disconnect, getStatus, search, download,
    // Compatibility aliases, retained while legacy callers move to the client API.
    isConfigured: hasStoredSession,
    saveCredentials: async (email, password) => { const value = await connect({ email, password }); return { success: true, userId: session.userId, ...value }; },
    getProfile: async () => { const auth = await loadSession(); if (!auth) throw new ZLibraryError('ZLIB_NOT_CONFIGURED'); return fetchProfile(auth); },
    downloadBook: (zlibId, hash, destinationPath) => download({ zlibId, hash }, destinationPath)
  };
}

function usableSession(value) { return !!(value && value.userId && value.userKey); }
function normalizeSession(value, fallback, timestamp = isoNow) { return { version: 2, userId: String(value.userId), userKey: String(value.userKey), baseUrl: safeBaseUrl(value.baseUrl || fallback), verifiedAt: value.verifiedAt || timestamp() }; }
function positiveInt(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; }
function numeric(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function isoNow() { return new Date().toISOString(); }
function clampLimit(value) { const n = Number(value ?? 20); if (!Number.isInteger(n) || n < 1) throw new ZLibraryError('ZLIB_PROTOCOL', { publicMessage: 'Search limit must be a positive number.' }); return Math.min(n, 100); }
function addList(target, key, values) { for (const value of Array.isArray(values) ? values : []) if (typeof value === 'string' && value.trim()) { if (!target[key]) target[key] = []; target[key].push(value.trim()); } }
function formEncode(params) { const form = new URLSearchParams(); for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item)); return form.toString(); }
function headersFor(auth) { return { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, ...(auth ? { 'remix-userid': auth.userId, 'remix-userkey': auth.userKey, Cookie: remixCookie(auth) } : {}) }; }
function remixCookie(auth) { return `remix_userid=${auth.userId}; remix_userkey=${auth.userKey};`; }
function parseLogin(body, headers) { const response = body?.response || body?.user || body?.data?.user || body?.data || body; let userId = response?.user_id || response?.userId || response?.id; let userKey = response?.user_key || response?.userKey || response?.remix_userkey; const setCookie = headers?.get?.('set-cookie') || ''; userId ||= cookieValue(setCookie, 'remix_userid'); userKey ||= cookieValue(setCookie, 'remix_userkey'); return userId && userKey ? { userId: String(userId), userKey: String(userKey) } : null; }
function cookieValue(value, key) { const match = String(value).match(new RegExp(`(?:^|[,;]\\s*)${key}=([^;,\\s]+)`)); return match?.[1]; }
function responseError(body, status, fallback) { const message = String(body?.error || body?.message || body?.errors?.join?.(' ') || ''); if (status === 400 || status === 401 || status === 403) return new ZLibraryError(/please login|login required|token/i.test(message) ? 'ZLIB_AUTH_EXPIRED' : 'ZLIB_AUTH_INVALID', { statusCode: status }); if (status === 429) return new ZLibraryError('ZLIB_RATE_LIMITED', { statusCode: status, retryable: false }); if ([502, 503, 504].includes(status)) return new ZLibraryError('ZLIB_UNAVAILABLE', { statusCode: status, retryable: true }); if (status >= 500) return new ZLibraryError('ZLIB_UNAVAILABLE', { statusCode: status, retryable: false }); return new ZLibraryError(fallback || 'ZLIB_PROTOCOL', { statusCode: status }); }
function normalizeError(error, fallback) { if (error instanceof ZLibraryError) return error; if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || /timed out/i.test(String(error?.message || ''))) return new ZLibraryError('ZLIB_TIMEOUT', { cause: error, retryable: true }); return new ZLibraryError(fallback || 'ZLIB_UNAVAILABLE', { cause: error, retryable: !fallback || fallback === 'ZLIB_UNAVAILABLE' }); }
function retryable(error) { return error?.retryable === true; }
function shortRetryAfterMs(response) { const seconds = Number(response.headers.get('retry-after')); return Number.isFinite(seconds) && seconds > 0 && seconds <= 2 ? seconds * 1000 : null; }
async function retryDelay(error, sleep) { await sleep(error?.retryAfterMs ?? 100); }
function looksHtml(response, text) { return /text\/html/i.test(response.headers.get('content-type') || '') || /^\s*<!doctype html|^\s*<html/i.test(text); }
function safeBaseUrl(value) { let url; try { url = new URL(value); } catch { throw new ZLibraryError('ZLIB_UNAVAILABLE'); } if (url.protocol !== 'https:' || url.username || url.password || url.port || isPrivateHost(url.hostname)) throw new ZLibraryError('ZLIB_UNAVAILABLE'); return url.origin; }
function safeDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ZLibraryError('ZLIB_DOWNLOAD_INVALID'); }
  // Validate with the same SSRF policy as base URLs, but retain the signed
  // path/query that identifies the actual file.
  safeBaseUrl(url.href);
  return url.href;
}
function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIP(h) === 4) return isPrivateIpv4(h);
  if (net.isIP(h) !== 6) return false;
  if (h === '::' || h === '::1' || h.startsWith('::')) {
    const mapped = h.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/i);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      if (high <= 0xffff && low <= 0xffff) {
        return isPrivateIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
      }
    }
    return true;
  }
  const first = Number.parseInt(h.split(':', 1)[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}
function isPrivateIpv4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}
function normalizeBook(book) { return { title: book?.title || 'Unknown Title', author: book?.author || 'Unknown', format: String(book?.extension || 'epub').toUpperCase(), size: book?.filesizeString || formatBytes(book?.filesize), hash: book?.hash || '', zlibId: String(book?.id ?? ''), publisher: book?.publisher || '', language: book?.language || '', url: book?.href || '', coverUrl: typeof book?.cover === 'string' ? book.cover : '', isbn: normalizeIdentifiers(book?.identifier ?? book?.isbn), source: 'zlibrary' }; }
function normalizeIdentifiers(value) { const values = Array.isArray(value) ? value : String(value || '').split(/[\s,;|]+/); return [...new Set(values.map(item => String(item || '').replace(/[^0-9X]/gi, '').toUpperCase()).filter(item => item.length === 10 || item.length === 13))]; }
function formatBytes(bytes) { const value = Number(bytes); if (!Number.isFinite(value) || value <= 0) return ''; return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`; }
function disconnectedStatus() { return { configured: false, state: 'disconnected', reachable: false, authenticated: false, searchAvailable: true, downloadAvailable: false }; }
function statusFromProfile(profile, timestamp = isoNow) { return { configured: true, state: 'connected', reachable: true, authenticated: true, searchAvailable: true, downloadAvailable: true, downloadsToday: profile.downloadsToday, dailyLimit: profile.dailyLimit, downloadsRemaining: profile.dailyLimit - profile.downloadsToday, lastVerifiedAt: timestamp() }; }
function failedStatus(state, error, configured) { return { configured, state, reachable: false, authenticated: false, searchAvailable: true, downloadAvailable: false, errorCode: error.code, message: error.publicMessage }; }
function isNonFileResponse(response) { const type = response.headers.get('content-type') || ''; return /text\/html|application\/json|text\/json/i.test(type); }
function looksLikeHtmlBytes(value) { return /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(value.toString('utf8')); }

const defaultClient = createZLibraryClient();
module.exports = { ...defaultClient, createZLibraryClient, ZLibraryError, BUILT_IN_BASE_URLS };
