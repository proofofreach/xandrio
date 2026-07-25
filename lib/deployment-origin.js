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

function registerDeploymentRoute(app, { canonicalOrigin = '' } = {}) {
  app.get('/api/deployment', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      canonicalOrigin,
      pwaRequiresSecureContext: true
    });
  });
}

module.exports = {
  isLoopbackHostname,
  normalizeCanonicalOrigin,
  registerDeploymentRoute
};
