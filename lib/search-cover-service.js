const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs').promises;
const path = require('path');
const net = require('net');

const DEFAULT_DESCRIPTOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 15 * 60 * 1000;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_COVER_REDIRECTS = 3;
const MAX_DESCRIPTOR_REGISTRY_SIZE = 1200;
// v4 changes source precedence so cached generated provider placeholders are
// reconsidered against catalog covers instead of remaining sticky forever.
const COVER_CACHE_SCHEMA = 'v4';
const DESCRIPTOR_REGISTRY_SCHEMA = 'v1';

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

function isRestrictedIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 0) ||
    (parts[0] === 192 && parts[1] === 2) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
    parts[0] === 0 || parts[0] >= 224;
}

function ipv6Bytes(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const [left, right = ''] = normalized.split('::');
  if (normalized.split('::').length > 2) return null;
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const expandIpv4 = parts => {
    const last = parts.at(-1);
    if (!last || !last.includes('.')) return parts;
    if (net.isIP(last) !== 4) return null;
    const octets = last.split('.').map(Number);
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const expandedLeft = expandIpv4(leftParts);
  const expandedRight = expandIpv4(rightParts);
  if (!expandedLeft || !expandedRight) return null;
  const parts = normalized.includes('::')
    ? [...expandedLeft, ...Array(8 - expandedLeft.length - expandedRight.length).fill('0'), ...expandedRight]
    : expandedLeft;
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
  const isIpv4Embedded = bytes.subarray(0, 12).every(byte => byte === 0) ||
    (bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff);
  if (isZero || isLoopback) return true;
  if (isIpv4Embedded) return isRestrictedIpv4([...bytes.subarray(12)].join('.'));
  if ((bytes[0] & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)) return true;
  if (bytes[0] === 0xff) return true;
  // Global unicast IPv6 is 2000::/3; everything else is reserved or local-use.
  if ((bytes[0] & 0xe0) !== 0x20) return true;
  return bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
}

function isSafeRemoteAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(normalized);
  if (family === 4) return !isRestrictedIpv4(normalized);
  if (family === 6) return !isRestrictedIpv6(normalized);
  return false;
}

function isSafeRemoteCoverUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const address = hostname.replace(/^\[|\]$/g, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) return false;
    if (net.isIP(address) && !isSafeRemoteAddress(address)) return false;
    return true;
  } catch {
    return false;
  }
}

function sanitizedRemoteUrl(value) {
  if (!isSafeRemoteCoverUrl(value)) return '';
  try {
    const url = new URL(String(value));
    url.hash = '';
    return url.toString().slice(0, 2048);
  } catch {
    return '';
  }
}

function normalizeIsbns(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .map(item => String(item || '').replace(/[^0-9X]/gi, '').toUpperCase())
    .filter(item => item.length === 10 || item.length === 13))];
}

function descriptorFor(result = {}) {
  result = result && typeof result === 'object' ? result : {};
  const source = String(result.source || 'unknown').slice(0, 40);
  const descriptor = {
    source,
    hash: String(result.hash || '').slice(0, 180),
    title: String(result.title || '').slice(0, 300),
    author: String(result.author || '').slice(0, 200),
    language: String(result.language || '').slice(0, 20),
    sourceCoverUrl: isSafeRemoteCoverUrl(result.coverUrl || result.sourceCoverUrl)
      ? String(result.coverUrl || result.sourceCoverUrl)
      : '',
    gutenbergId: String(result.gutenbergId || '').replace(/\D/g, '').slice(0, 12),
    iaIdentifier: String(result.iaIdentifier || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 160),
    openLibraryWorkKey: String(result.openLibraryWorkKey || '').slice(0, 100),
    openLibraryEditionKey: String(result.openLibraryEditionKey || '').slice(0, 100),
    isbn: normalizeIsbns(result.isbn)
  };
  // Do not add an empty field: equivalent descriptors should retain one cache
  // key regardless of whether the provider omitted an optional page URL.
  if (source === 'annas') {
    const sourcePageUrl = sanitizedRemoteUrl(result.sourcePageUrl || result.url);
    if (sourcePageUrl) descriptor.sourcePageUrl = sourcePageUrl;
  }
  return descriptor;
}

function descriptorKey(descriptor) {
  return crypto.createHash('sha256')
    .update(`${COVER_CACHE_SCHEMA}|${JSON.stringify(descriptor)}`)
    .digest('hex')
    .slice(0, 32);
}

function stableBookIdentity(descriptor) {
  const work = String(descriptor.openLibraryWorkKey || '')
    .replace(/^\/?works\//i, '')
    .trim()
    .toLowerCase();
  if (work) return `work:${work}`;

  const isbn = normalizeIsbns(descriptor.isbn).sort()[0];
  if (isbn) return `isbn:${isbn}`;

  const edition = String(descriptor.openLibraryEditionKey || '')
    .replace(/^\/?books\//i, '')
    .trim()
    .toLowerCase();
  if (edition) return `edition:${edition}`;
  return '';
}

function stableCoverKey(descriptor) {
  const identity = stableBookIdentity(descriptor);
  if (!identity) return '';
  return crypto.createHash('sha256')
    .update(`${COVER_CACHE_SCHEMA}|identity|${identity}`)
    .digest('hex')
    .slice(0, 32);
}

function createSearchCoverService(options = {}) {
  const cacheDir = options.cacheDir;
  if (!cacheDir) throw new Error('createSearchCoverService requires cacheDir');
  const fetchImpl = options.fetchImpl || fetch;
  const lookupImpl = options.lookupImpl || dns.lookup;
  const getDimensions = options.getDimensions;
  const fetchCoverByISBN = options.fetchCoverByISBN;
  const fetchCoverByOpenLibraryWorkKey = options.fetchCoverByOpenLibraryWorkKey;
  const fetchCoverFromGutenbergId = options.fetchCoverFromGutenbergId;
  const fetchCoverFromAnnasPage = options.fetchCoverFromAnnasPage;
  const fetchCoverFromGoogleBooks = options.fetchCoverFromGoogleBooks;
  const resolveOpenLibraryIdentity = options.resolveOpenLibraryIdentity;
  const descriptorTtlMs = options.descriptorTtlMs || DEFAULT_DESCRIPTOR_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs || DEFAULT_NEGATIVE_TTL_MS;
  const registry = new Map();
  const negative = new Map();
  const inflight = new Map();
  const descriptorRegistryPath = path.join(cacheDir, 'descriptors.json');
  let persistence = Promise.resolve();
  let persistenceError = null;
  let registryDirty = false;
  let registryWriteActive = false;

  function trimRegistry() {
    const now = Date.now();
    for (const [key, entry] of registry) {
      if (!entry || !entry.descriptor || entry.expiresAt <= now) registry.delete(key);
    }
    while (registry.size > MAX_DESCRIPTOR_REGISTRY_SIZE) registry.delete(registry.keys().next().value);
  }

  const registryReady = (async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(descriptorRegistryPath, 'utf8'));
      if (saved?.schema !== DESCRIPTOR_REGISTRY_SCHEMA || !Array.isArray(saved.entries)) return;
      for (const savedEntry of saved.entries) {
        const key = String(savedEntry?.key || '');
        const descriptor = descriptorFor(savedEntry?.descriptor);
        const expiresAt = Number(savedEntry?.expiresAt);
        if (!/^[a-f0-9]{32}$/.test(key) || descriptorKey(descriptor) !== key ||
            !Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
        if (!registry.has(key)) registry.set(key, {
          descriptor,
          fingerprint: JSON.stringify(descriptor),
          expiresAt
        });
      }
      trimRegistry();
    } catch {
      // An absent or corrupt registry must not prevent cover lookup.
    }
  })();

  async function writeRegistrySnapshot() {
    await registryReady;
    trimRegistry();
    const saved = {
      schema: DESCRIPTOR_REGISTRY_SCHEMA,
      entries: [...registry.entries()].map(([key, entry]) => ({
        key,
        descriptor: entry.descriptor,
        expiresAt: entry.expiresAt
      }))
    };
    const temporaryPath = `${descriptorRegistryPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.part`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(saved));
      await fs.rename(temporaryPath, descriptorRegistryPath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  function persistRegistry() {
    registryDirty = true;
    if (registryWriteActive) return persistence;
    registryWriteActive = true;
    persistence = persistence.then(async () => {
      // Capture the latest registry once per burst. A registration arriving
      // during a write marks it dirty and receives one fresh follow-up snapshot.
      while (registryDirty) {
        registryDirty = false;
        try {
          await writeRegistrySnapshot();
          persistenceError = null;
        } catch (error) {
          // Keep the queue fulfilled so a transient failure cannot poison later
          // writes or become an unhandled rejection when register() is synchronous.
          persistenceError = error;
        }
      }
      registryWriteActive = false;
    }).catch(error => {
      // This guard covers unexpected errors in the drain itself and keeps
      // subsequent registrations able to schedule a new write.
      persistenceError = error;
      registryWriteActive = false;
    });
    return persistence;
  }

  function cachePath(key) {
    return path.join(cacheDir, `${key}.img`);
  }

  async function validCachedCover(key) {
    try {
      const filePath = cachePath(key);
      const buffer = await fs.readFile(filePath);
      const contentType = imageType(buffer);
      const dimensions = getDimensions?.(buffer);
      const ratio = dimensions ? dimensions.width / dimensions.height : 0;
      if (!contentType || buffer.length < 1200 || buffer.length > MAX_COVER_BYTES ||
          !dimensions || dimensions.width < 96 || dimensions.height < 128 || ratio < 0.42 || ratio > 1.12) {
        await fs.unlink(filePath).catch(() => {});
        return null;
      }
      return { filePath, buffer, contentType, dimensions };
    } catch {
      return null;
    }
  }

  async function writeRemoteCover(url, outputPath) {
    if (!isSafeRemoteCoverUrl(url)) return false;
    try {
      let currentUrl = new URL(url);
      let response;
      for (let redirects = 0; redirects <= MAX_COVER_REDIRECTS; redirects += 1) {
        const hostname = currentUrl.hostname.replace(/^\[|\]$/g, '');
        const addresses = net.isIP(hostname)
          ? [{ address: hostname }]
          : await lookupImpl(hostname, { all: true, verbatim: true });
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(record => !isSafeRemoteAddress(record?.address))) {
          return false;
        }

        response = await fetchImpl(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(12000),
          headers: {
            'Accept': 'image/jpeg,image/png,image/*;q=0.8',
            'User-Agent': 'Xandrio/1.0 (local audiobook cover cache)'
          }
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirects === MAX_COVER_REDIRECTS) return false;
        const location = response.headers?.get?.('location');
        if (!location) return false;
        currentUrl = new URL(location, currentUrl);
        if (!isSafeRemoteCoverUrl(currentUrl)) return false;
      }
      if (!response?.ok || response.redirected || (response.url && !isSafeRemoteCoverUrl(response.url))) return false;
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_COVER_BYTES) return false;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!imageType(buffer) || buffer.length > MAX_COVER_BYTES) return false;
      const partPath = `${outputPath}.part`;
      await fs.writeFile(partPath, buffer);
      await fs.rename(partPath, outputPath);
      return true;
    } catch {
      return false;
    }
  }

  async function tryWriter(key, writer) {
    const outputPath = cachePath(key);
    try {
      if (!await writer(outputPath)) return null;
      return validCachedCover(key);
    } catch {
      await fs.unlink(outputPath).catch(() => {});
      return null;
    }
  }

  async function tryOpenLibraryIdentity(key, descriptor) {
    if (!resolveOpenLibraryIdentity || !descriptor.title) return null;
    const identity = await resolveOpenLibraryIdentity({
      title: descriptor.title,
      author: descriptor.author,
      language: descriptor.language
    }, { timeoutMs: 7000 });
    if (identity?.confidence?.level !== 'high') return null;

    const editionId = String(identity.openLibraryEditionKey || '').replace(/^\/?books\//, '');
    if (editionId) {
      const cover = await tryWriter(key, outputPath =>
        writeRemoteCover(`https://covers.openlibrary.org/b/olid/${encodeURIComponent(editionId)}-L.jpg?default=false`, outputPath));
      if (cover) return cover;
    }
    for (const isbn of normalizeIsbns(identity.isbn).slice(0, 3)) {
      const cover = await tryWriter(key, outputPath => fetchCoverByISBN?.(isbn, outputPath));
      if (cover) return cover;
    }
    const coverId = String(identity.coverId || '').replace(/\D/g, '');
    if (coverId) {
      const cover = await tryWriter(key, outputPath => writeRemoteCover(
        `https://covers.openlibrary.org/b/id/${encodeURIComponent(coverId)}-L.jpg?default=false`,
        outputPath
      ));
      if (cover) return cover;
    }
    if (identity.openLibraryWorkKey) {
      return tryWriter(key, outputPath => fetchCoverByOpenLibraryWorkKey?.(identity.openLibraryWorkKey, outputPath));
    }
    return null;
  }

  async function resolveFresh(key, descriptor) {
    await fs.mkdir(cacheDir, { recursive: true });

    const tryKnownCatalogIdentity = async () => {
      const editionId = descriptor.openLibraryEditionKey.replace(/^\/?books\//, '');
      if (editionId) {
        const cover = await tryWriter(key, outputPath => writeRemoteCover(
          `https://covers.openlibrary.org/b/olid/${encodeURIComponent(editionId)}-L.jpg?default=false`,
          outputPath
        ));
        if (cover) return cover;
      }
      for (const isbn of descriptor.isbn.slice(0, 3)) {
        const cover = await tryWriter(key, outputPath => fetchCoverByISBN?.(isbn, outputPath));
        if (cover) return cover;
      }
      if (descriptor.openLibraryWorkKey) {
        const cover = await tryWriter(key, outputPath => fetchCoverByOpenLibraryWorkKey?.(descriptor.openLibraryWorkKey, outputPath));
        if (cover) return cover;
      }
      return null;
    };

    // Scraped catalogs frequently expose a first-page scan as their thumbnail.
    // Prefer a search-ranked, high-confidence catalog identity for those
    // sources; retain the provider thumbnail as a fallback for unmatched work.
    const preferCatalog = descriptor.source === 'annas' || descriptor.source === 'zlibrary';
    if (preferCatalog) {
      const cover = await tryKnownCatalogIdentity();
      if (cover) return cover;
    }

    if (descriptor.sourceCoverUrl && !preferCatalog) {
      const cover = await tryWriter(key, outputPath => writeRemoteCover(descriptor.sourceCoverUrl, outputPath));
      if (cover) return cover;
    }
    if (descriptor.gutenbergId) {
      const cover = await tryWriter(key, outputPath => fetchCoverFromGutenbergId?.(descriptor.gutenbergId, outputPath));
      if (cover) return cover;
    }
    if (descriptor.iaIdentifier) {
      const cover = await tryWriter(key, outputPath => writeRemoteCover(
        `https://archive.org/services/img/${encodeURIComponent(descriptor.iaIdentifier)}`,
        outputPath
      ));
      if (cover) return cover;
    }
    if (!preferCatalog) {
      const cover = await tryKnownCatalogIdentity();
      if (cover) return cover;
    }

    const openLibraryCover = await tryOpenLibraryIdentity(key, descriptor);
    if (openLibraryCover) return openLibraryCover;
    const googleCover = await tryWriter(key, outputPath => fetchCoverFromGoogleBooks?.(
      descriptor.title,
      descriptor.author,
      outputPath
    ));
    if (googleCover) return googleCover;

    // Anna edition pages can expose Calibre-style generated title cards. They
    // remain useful when no real cover exists, but must be the final Anna
    // fallback after high-confidence catalog sources have been exhausted.
    if (descriptor.source === 'annas' && descriptor.sourcePageUrl) {
      const pageCover = await tryWriter(key, outputPath =>
        fetchCoverFromAnnasPage?.(descriptor.sourcePageUrl, outputPath));
      if (pageCover) return pageCover;
    }
    if (descriptor.source === 'zlibrary' && descriptor.sourceCoverUrl) {
      return tryWriter(key, outputPath => writeRemoteCover(descriptor.sourceCoverUrl, outputPath));
    }
    return null;
  }

  function register(result) {
    const descriptor = descriptorFor(result);
    if (!descriptor.title && !descriptor.hash) return null;
    const key = descriptorKey(descriptor);
    const fingerprint = JSON.stringify(descriptor);
    const previous = registry.get(key);
    registry.set(key, { descriptor, fingerprint, expiresAt: Date.now() + descriptorTtlMs });
    if (previous && previous.fingerprint !== fingerprint) negative.delete(key);

    trimRegistry();
    persistRegistry();
    return { key, url: `/api/search-cover/${key}` };
  }

  async function resolve(key, { retry = false } = {}) {
    if (!/^[a-f0-9]{32}$/.test(String(key || ''))) return null;
    const cached = await validCachedCover(key);
    if (cached) return cached;
    await registryReady;

    const entry = registry.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      registry.delete(key);
      return null;
    }
    const resolvedKey = stableCoverKey(entry.descriptor) || key;
    const sharedCached = resolvedKey === key ? null : await validCachedCover(resolvedKey);
    if (sharedCached) return sharedCached;
    if (!retry && (negative.get(resolvedKey) || 0) > Date.now()) return null;
    if (retry) negative.delete(resolvedKey);
    if (inflight.has(resolvedKey)) return inflight.get(resolvedKey);

    const promise = resolveFresh(resolvedKey, entry.descriptor)
      .then(result => {
        if (!result) negative.set(resolvedKey, Date.now() + negativeTtlMs);
        return result;
      })
      .finally(() => inflight.delete(resolvedKey));
    inflight.set(resolvedKey, promise);
    return promise;
  }

  async function copyTo(key, outputPath, options = {}) {
    const cover = await resolve(key, options);
    if (!cover) return false;
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.part`;
    try {
      await fs.writeFile(temporaryPath, cover.buffer);
      await fs.rename(temporaryPath, outputPath);
      return true;
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  async function flush() {
    await registryReady;
    await persistence;
    await Promise.all([...inflight.values()]);
    await persistence;
    if (persistenceError) throw new Error('Unable to persist search-cover descriptor registry');
  }

  return { register, resolve, copyTo, flush };
}

module.exports = {
  createSearchCoverService,
  imageType,
  isSafeRemoteCoverUrl,
  normalizeIsbns
};
