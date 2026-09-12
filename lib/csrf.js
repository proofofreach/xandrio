'use strict';

/**
 * Cross-site request forgery gate for the API surface.
 *
 * Xandrio authenticates browsers with a cookie, so every state-changing API
 * route was reachable from any page the operator happened to visit: a hostile
 * site could POST to a default-port LAN instance and the browser would attach
 * the session cookie for it. `sameSite: 'lax'` blocks the easy cases but is not
 * a complete control -- it does not cover same-site subdomains, and it is a
 * cookie hint rather than a server-side check.
 *
 * The gate is deliberately a *rejection* filter rather than a token scheme:
 *
 *  - `Sec-Fetch-Site: cross-site` is a browser-asserted fact and is refused
 *    outright. Modern browsers always send it.
 *  - Otherwise, if an `Origin` header is present it must match the origin the
 *    request was actually addressed to (or an operator-configured extra
 *    origin). Browsers always send `Origin` on cross-origin state-changing
 *    requests, including form posts.
 *  - A request carrying neither header is not a browser request (curl, a
 *    native client, a scripted importer) and cannot be forged by a web page,
 *    so it passes. Blocking it would break every non-browser client for no
 *    security gain.
 *
 * Safe methods are never gated -- they must remain usable for navigation and
 * for the service worker's cache warming.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const { canonicalRequestPath } = require('./auth');

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.trim();
  // "null" is what a sandboxed iframe or a `data:`/`file:` document sends. It
  // is opaque, so it can never match a configured origin and must not be
  // normalized into one.
  if (!trimmed || trimmed === 'null') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredAllowedOrigins(raw) {
  const origins = new Set();
  for (const entry of String(raw || '').split(',')) {
    const origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * The origin the request was addressed to, as the browser would compute it.
 *
 * `req.protocol` only reflects X-Forwarded-Proto when Express's `trust proxy`
 * is enabled, and it is off by default -- but the default deployment still
 * terminates TLS at a proxy and forwards over loopback HTTP. Deriving the
 * scheme from req.protocol alone therefore produced "http://host" and compared
 * it against the browser's "https://host", refusing every state-changing
 * request in the default production setup.
 *
 * Consulting the forwarded scheme here cannot weaken the check: the host is
 * what identifies the origin, and a forged X-Forwarded-Proto only changes
 * "http" to "https" for the *same* host. A cross-site attacker's origin still
 * carries their own hostname and still fails to match.
 */
function requestOrigin(req) {
  const host = req.host || req.headers?.host;
  if (!host) return null;
  return normalizeOrigin(`${requestScheme(req)}://${host}`);
}

function requestScheme(req) {
  const forwarded = req.headers?.['x-forwarded-proto'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim().toLowerCase();
    if (first === 'https' || first === 'http') return first;
  }
  if (req.secure) return 'https';
  return req.protocol === 'https' ? 'https' : 'http';
}

function createCsrfMiddleware({
  allowedOrigins = configuredAllowedOrigins(process.env.XANDRIO_ALLOWED_ORIGINS),
  // Kept injectable so the API-surface tests can assert the gate directly.
  // Default uses the canonical path (lowercased, normalized) so the gate
  // cannot drift from auth/rate-limit if routing ever changes.
  isGuardedPath = path => path.startsWith('/api/')
} = {}) {
  const allowed = allowedOrigins instanceof Set ? allowedOrigins : configuredAllowedOrigins(allowedOrigins);
  return function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!isGuardedPath(canonicalRequestPath(req))) return next();

    const fetchSite = req.headers?.['sec-fetch-site'];
    if (fetchSite === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site request blocked', code: 'CSRF_BLOCKED' });
    }

    const origin = normalizeOrigin(req.headers?.origin);
    if (req.headers?.origin && !origin) {
      // An origin header the server cannot parse (including the opaque
      // "null" of a sandboxed frame) is never trustworthy.
      return res.status(403).json({ error: 'Cross-site request blocked', code: 'CSRF_BLOCKED' });
    }
    if (origin) {
      const expected = requestOrigin(req);
      if (origin !== expected && !allowed.has(origin)) {
        return res.status(403).json({ error: 'Cross-site request blocked', code: 'CSRF_BLOCKED' });
      }
    }
    return next();
  };
}

module.exports = { createCsrfMiddleware, configuredAllowedOrigins, normalizeOrigin, requestOrigin, requestScheme };
