// Bounded, in-memory rate limiting for expensive and sensitive endpoints.
// It is intentionally per-process: self-hosted deployments normally run one
// Node process, and a reverse proxy can provide distributed protection when
// an operator scales beyond that.

const { canonicalRequestPath } = require('./auth');
const { isTtsRoute } = require('./tts-route-patterns');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientAddress(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function defaultGroups(max) {
  const capped = value => Math.max(1, Math.min(max, value));
  return [
    {
      name: 'auth', max: capped(10),
      // /api/integrations/calibre/pairing-code issues a pairing code through a
      // full critical-store cycle (2 reads, 2 writes, 5 fsyncs per call) and
      // matched no group at all -- see
      // json-store-critical-write-amplification-dos.md.
      match: path => path.startsWith('/api/auth/') || path === '/api/integrations/calibre/claim' ||
        path === '/api/integrations/calibre/pairing-code'
    },
    { name: 'search', max: capped(30), match: path => path === '/api/search' },
    {
      name: 'import', max: capped(10),
      match: path => path === '/api/download' || path === '/api/upload' || path === '/api/integrations/calibre/import'
    },
    { name: 'metadata', max: capped(20), match: path => path.startsWith('/api/refresh-metadata/') },
    {
      name: 'tts',
      max,
      match: path => isTtsRoute(path)
    },
    { name: 'voice', max: capped(10), match: path => path.startsWith('/api/voices/clone') },
    // Registers/refreshes sync identity (device id, profile name). Cheap
    // individually but reached with no auth in trusted-LAN mode and mutates
    // the shared users.json on every call, so it needs a ceiling like every
    // other mutating endpoint (see
    // upsertdevice-unbounded-device-records-grow-users-json-forever.md).
    {
      name: 'sync', max: capped(30),
      match: path => path === '/api/sync/device' || path === '/api/sync/profile'
    }
  ];
}

function createRateLimitMiddleware({
  windowMs = 60_000,
  max = 60,
  groups = defaultGroups(max),
  now = () => Date.now(),
  maxEntries = 10_000
} = {}) {
  const boundedWindowMs = positiveInteger(windowMs, 60_000);
  const boundedMax = positiveInteger(max, 60);
  const buckets = new Map();
  let calls = 0;

  function clearExpired(current) {
    if (++calls % 128 !== 0 && buckets.size <= maxEntries) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= current || buckets.size > maxEntries) buckets.delete(key);
    }
  }

  function middleware(req, res, next) {
    // Same canonical form the auth gate uses. The group predicates below match
    // lowercase literals, so a case- or encoding-varied path would otherwise
    // match no group and skip its bucket entirely.
    const pathname = canonicalRequestPath(req);
    const group = groups.find(candidate => candidate.match(pathname, req));
    if (!group) return next();

    const current = now();
    clearExpired(current);
    const limit = positiveInteger(group.max, boundedMax);
    const key = `${group.name}:${clientAddress(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + boundedWindowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, limit - bucket.count);
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - current) / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(retryAfter));
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    return next();
  }

  middleware.buckets = buckets;
  return middleware;
}

module.exports = { clientAddress, createRateLimitMiddleware, defaultGroups, positiveInteger };
