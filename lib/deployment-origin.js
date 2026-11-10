'use strict';

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeCanonicalOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('XANDRIO_CANONICAL_ORIGIN must be one absolute origin.');
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('XANDRIO_CANONICAL_ORIGIN must not include credentials, a path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('XANDRIO_CANONICAL_ORIGIN must use HTTPS except on localhost.');
  }
  return url.origin;
}

function registerDeploymentRoute(app, { canonicalOrigin = '', appBuild = null, appVersion = null } = {}) {
  app.get('/api/deployment', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...(appVersion ? { appVersion } : {}),
      ...(appBuild ? { appBuild } : {}),
      canonicalOrigin,
      pwaRequiresSecureContext: true
    });
  });
}

// Lowest shell build whose API contract this server still honours. Raise it
// only when a server change breaks older clients (for example a changed error
// contract an old handler would misread). Builds older than this receive 409
// CLIENT_STALE, and the client updates its worker and reloads.
const MIN_CLIENT_BUILD = 'xandrio-v226';
const CLIENT_BUILD_HEADER = 'X-Xandrio-Build';
// Requests a stale client must still complete: detecting the new build,
// signing in or out, and saving listening progress, which must never be lost
// to a version check.
const CLIENT_BUILD_EXEMPT_PATHS = [
  /^\/api\/deployment$/,
  /^\/api\/auth\//,
  /^\/api\/positions?(?:\/|$)/,
  /^\/api\/playback-health$/,
  // A stale build's crash trail is the evidence needed to diagnose it.
  /^\/api\/admin\/client-telemetry$/
];

function clientBuildNumber(value) {
  const match = /^xandrio-v(\d+)$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

// A missing or unrecognised header is always accepted: media elements, curl,
// the Calibre plugin and clients older than the header never send one.
function createClientBuildGate({ minClientBuild = MIN_CLIENT_BUILD } = {}) {
  const minimum = clientBuildNumber(minClientBuild);
  return (req, res, next) => {
    if (minimum === null || !req.path.startsWith('/api/')) return next();
    const build = clientBuildNumber(req.get(CLIENT_BUILD_HEADER));
    if (build === null || build >= minimum) return next();
    if (CLIENT_BUILD_EXEMPT_PATHS.some(pattern => pattern.test(req.path))) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Xandrio-Client-Stale', '1');
    res.status(409).json({
      error: 'This copy of Xandrio is out of date. Update to continue.',
      code: 'CLIENT_STALE',
      minClientBuild
    });
  };
}

module.exports = {
  CLIENT_BUILD_HEADER,
  MIN_CLIENT_BUILD,
  clientBuildNumber,
  createClientBuildGate,
  isLoopbackHostname,
  normalizeCanonicalOrigin,
  registerDeploymentRoute
};
