// Shared-token authentication for a self-hosted instance.
//
// A configured XANDRIO_TOKEN protects every /api route except the small
// authentication bootstrap surface.  Browser clients exchange the shared
// token once for a signed, HttpOnly session cookie; non-browser clients can
// keep using Authorization: Bearer <token>.  This deliberately leaves the
// application shell and /health public so service-worker installation and
// uptime checks do not require credentials.

const crypto = require('crypto');

const SESSION_COOKIE = 'xandrio_session';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status'
]);

function timingSafeEqualStrings(a, b) {
  // Hash both sides to fixed length so timingSafeEqual cannot throw on a
  // length mismatch or reveal either value's length.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      cookies[name] = part.slice(idx + 1).trim();
    }
  }
  return cookies;
}

function requestBearerToken(req) {
  const header = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function sessionSignature(payload, token) {
  return crypto.createHmac('sha256', token).update(payload).digest('base64url');
}

function createSession(token, { now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  const expiresAt = now + Math.min(Math.max(Number(ttlMs) || DEFAULT_SESSION_TTL_MS, 1), MAX_SESSION_TTL_MS);
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: expiresAt })).toString('base64url');
  return `${payload}.${sessionSignature(payload, token)}`;
}

function verifySession(session, token, { now = Date.now() } = {}) {
  if (typeof session !== 'string') return false;
  const [payload, signature, ...extra] = session.split('.');
  if (!payload || !signature || extra.length) return false;
  if (!timingSafeEqualStrings(signature, sessionSignature(payload, token))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed?.v === 1 && Number.isFinite(parsed.exp) && parsed.exp > now;
  } catch {
    return false;
  }
}

function requestToken(req, token) {
  const bearer = requestBearerToken(req);
  if (bearer) return bearer;
  const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  // The configured token stays server-side; this internal helper returns it
  // only after a valid signed session has been verified.
  return token && verifySession(session, token) ? token : null;
}

function isPublicRequest(req) {
  if (!req.path.startsWith('/api/')) return true;
  return PUBLIC_API_PATHS.has(req.path);
}

/**
 * @param {Object} options
 * @param {string|null} options.token Shared secret; falsy enables trusted-LAN mode.
 * @returns Express middleware requiring auth for private API routes.
 */
function createAuthMiddleware({ token }) {
  return function requireAuth(req, res, next) {
    if (!token || req.method === 'OPTIONS' || isPublicRequest(req)) return next();
    const provided = requestToken(req, token);
    if (provided && timingSafeEqualStrings(provided, token)) return next();
    res.setHeader('WWW-Authenticate', 'Bearer realm="Xandrio"');
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

function sessionCookieOptions(req, { ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure),
    path: '/',
    maxAge: Math.min(Math.max(Number(ttlMs) || DEFAULT_SESSION_TTL_MS, 1), MAX_SESSION_TTL_MS)
  };
}

function createAuthRoutes({ token, sessionTtlMs = DEFAULT_SESSION_TTL_MS }) {
  return {
    login(req, res) {
      if (!token) return res.status(204).end();
      const provided = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!provided || !timingSafeEqualStrings(provided, token)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const options = sessionCookieOptions(req, { ttlMs: sessionTtlMs });
      res.cookie(SESSION_COOKIE, createSession(token, { ttlMs: options.maxAge }), options);
      return res.status(204).end();
    },
    logout(req, res) {
      const { maxAge: _maxAge, ...clearOptions } = sessionCookieOptions(req);
      res.clearCookie(SESSION_COOKIE, clearOptions);
      return res.status(204).end();
    },
    status(req, res) {
      return res.json({ authenticationRequired: Boolean(token) });
    }
  };
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  PUBLIC_API_PATHS,
  SESSION_COOKIE,
  createAuthMiddleware,
  createAuthRoutes,
  createSession,
  isPublicRequest,
  parseCookies,
  requestBearerToken,
  requestToken,
  sessionCookieOptions,
  timingSafeEqualStrings,
  verifySession
};
