// Authentication for a self-hosted instance.
//
// Two modes share this module:
//
// - Shared-token mode (legacy, and the bootstrap state before any account
//   exists): a configured XANDRIO_TOKEN protects every /api route except the
//   small authentication bootstrap surface. Browser clients exchange the
//   shared token once for a signed, HttpOnly session cookie; non-browser
//   clients can keep using Authorization: Bearer <token>.
//
// - Account mode (one or more username/password accounts in accounts.json):
//   browsers log in with credentials and receive an opaque random session
//   token stored server-side (data/sessions.json, hashed), so sessions are
//   revocable on logout and password change. The shared token, when still
//   configured, remains valid as an admin-equivalent Bearer credential for
//   scripts and monitoring. With zero accounts and no token, the documented
//   trusted-LAN mode applies.
//
// The application shell and /health deliberately stay public so
// service-worker installation and uptime checks do not require credentials.

const crypto = require('crypto');

const SESSION_COOKIE = 'xandrio_session';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;
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

function clampTtl(ttlMs) {
  return Math.min(Math.max(Number(ttlMs) || DEFAULT_SESSION_TTL_MS, 1), MAX_SESSION_TTL_MS);
}

// ─── Legacy stateless shared-token sessions ────────────────────────────────

function sessionSignature(payload, token) {
  return crypto.createHmac('sha256', token).update(payload).digest('base64url');
}

function createSession(token, { now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  const expiresAt = now + clampTtl(ttlMs);
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

// ─── Server-side account sessions ──────────────────────────────────────────

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normalizeSessionsStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  if (!store.sessions || typeof store.sessions !== 'object') store.sessions = {};
  return store;
}

/**
 * Revocable sessions backed by a json-store file. The cookie holds an opaque
 * random token; only its sha256 is persisted, so the store file never
 * contains a usable credential.
 */
function createSessionStore({ filePath, jsonStore, ttlMs = DEFAULT_SESSION_TTL_MS, now = Date.now }) {
  const sessionTtlMs = clampTtl(ttlMs);

  function prune(store, nowMs) {
    for (const [key, session] of Object.entries(store.sessions)) {
      if (!session || !Number.isFinite(session.expiresAtMs) || session.expiresAtMs <= nowMs) {
        delete store.sessions[key];
      }
    }
  }

  return {
    ttlMs: sessionTtlMs,

    async create(userId, { deviceId = null } = {}) {
      const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
      const nowMs = now();
      const session = {
        userId,
        deviceId: deviceId || null,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + sessionTtlMs).toISOString(),
        expiresAtMs: nowMs + sessionTtlMs
      };
      await jsonStore.update(filePath, (data) => {
        const store = normalizeSessionsStore(data);
        prune(store, nowMs);
        store.sessions[hashSessionToken(token)] = session;
      });
      return { token, expiresAtMs: session.expiresAtMs };
    },

    async resolve(token) {
      if (typeof token !== 'string' || !token) return null;
      const store = normalizeSessionsStore(await jsonStore.load(filePath, {}));
      const session = store.sessions[hashSessionToken(token)];
      if (!session || !Number.isFinite(session.expiresAtMs) || session.expiresAtMs <= now()) return null;
      return session;
    },

    async destroy(token) {
      if (typeof token !== 'string' || !token) return;
      await jsonStore.update(filePath, (data) => {
        const store = normalizeSessionsStore(data);
        prune(store, now());
        delete store.sessions[hashSessionToken(token)];
      });
    },

    async destroyAllForUser(userId, { exceptToken = null } = {}) {
      const keepKey = exceptToken ? hashSessionToken(exceptToken) : null;
      await jsonStore.update(filePath, (data) => {
        const store = normalizeSessionsStore(data);
        prune(store, now());
        for (const [key, session] of Object.entries(store.sessions)) {
          if (session.userId === userId && key !== keepKey) delete store.sessions[key];
        }
      });
    }
  };
}

/**
 * Resolves the requesting identity, or null when unauthenticated.
 *
 * Returned users carry `id` (account id) when a real account session is
 * present. Legacy shared-token and trusted-LAN callers get `id: null` plus a
 * `legacy`/`lan` marker — data routes then fall back to their historical
 * identity resolution.
 */
async function resolveRequestUser(req, { token, accounts, sessionStore }) {
  const accountCount = accounts ? await accounts.count() : 0;

  if (accountCount === 0) {
    if (!token) return { id: null, role: 'admin', lan: true };
    const provided = requestToken(req, token);
    if (provided && timingSafeEqualStrings(provided, token)) {
      return { id: null, role: 'admin', legacy: true };
    }
    return null;
  }

  // Accounts exist: the shared token (when configured) stays valid as an
  // admin-equivalent Bearer credential for scripts and monitoring.
  const bearer = requestBearerToken(req);
  if (token && bearer && timingSafeEqualStrings(bearer, token)) {
    return { id: null, role: 'admin', legacy: true };
  }

  const cookieToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookieToken && sessionStore) {
    const session = await sessionStore.resolve(cookieToken);
    if (session) {
      const account = await accounts.findById(session.userId);
      if (account && !account.disabled) {
        return {
          id: account.id,
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          sessionToken: cookieToken
        };
      }
    }
  }
  return null;
}

function isPublicRequest(req) {
  if (!req.path.startsWith('/api/')) return true;
  return PUBLIC_API_PATHS.has(req.path);
}

/**
 * @param {Object} options
 * @param {string|null} options.token Shared secret; falsy enables trusted-LAN
 *   mode while no accounts exist.
 * @param {Object} [options.accounts] Accounts store; enables account mode.
 * @param {Object} [options.sessionStore] Server-side session store.
 * @returns Express middleware requiring auth for private API routes.
 */
function createAuthMiddleware({ token, accounts = null, sessionStore = null }) {
  if (!accounts) {
    // Legacy shared-token middleware, unchanged.
    return function requireAuth(req, res, next) {
      if (!token || req.method === 'OPTIONS' || isPublicRequest(req)) return next();
      const provided = requestToken(req, token);
      if (provided && timingSafeEqualStrings(provided, token)) return next();
      res.setHeader('WWW-Authenticate', 'Bearer realm="Xandrio"');
      return res.status(401).json({ error: 'Unauthorized' });
    };
  }

  return async function requireAuth(req, res, next) {
    if (req.method === 'OPTIONS' || isPublicRequest(req)) return next();
    let user;
    try {
      user = await resolveRequestUser(req, { token, accounts, sessionStore });
    } catch (err) {
      return next(err);
    }
    if (user) {
      req.user = user;
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="Xandrio"');
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function sessionCookieOptions(req, { ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure),
    path: '/',
    maxAge: clampTtl(ttlMs)
  };
}

function createAuthRoutes({ token, sessionTtlMs = DEFAULT_SESSION_TTL_MS, accounts = null, sessionStore = null }) {
  function legacyLogin(req, res) {
    if (!token) return res.status(204).end();
    const provided = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!provided || !timingSafeEqualStrings(provided, token)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const options = sessionCookieOptions(req, { ttlMs: sessionTtlMs });
    res.cookie(SESSION_COOKIE, createSession(token, { ttlMs: options.maxAge }), options);
    return res.status(204).end();
  }

  function clearSessionCookie(res, req) {
    const { maxAge: _maxAge, ...clearOptions } = sessionCookieOptions(req);
    res.clearCookie(SESSION_COOKIE, clearOptions);
  }

  return {
    async login(req, res) {
      try {
        if (!accounts || (await accounts.count()) === 0) {
          // Bootstrap: the shared token remains the browser credential until
          // the first account exists.
          return legacyLogin(req, res);
        }
        const username = typeof req.body?.username === 'string' ? req.body.username : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const account = await accounts.verifyLogin(username, password);
        if (!account) {
          return res.status(401).json({ error: 'Invalid username or password' });
        }
        const options = sessionCookieOptions(req, { ttlMs: sessionTtlMs });
        const { token: sessionToken } = await sessionStore.create(account.id, {
          deviceId: req.headers['x-xandrio-device-id'] || null
        });
        res.cookie(SESSION_COOKIE, sessionToken, options);
        return res.json({
          success: true,
          user: { id: account.id, username: account.username, displayName: account.displayName, role: account.role }
        });
      } catch (err) {
        console.error('Login failed:', err);
        return res.status(500).json({ error: 'Login failed' });
      }
    },

    async logout(req, res) {
      try {
        if (sessionStore) {
          await sessionStore.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
        }
        clearSessionCookie(res, req);
        return res.status(204).end();
      } catch (err) {
        console.error('Logout failed:', err);
        return res.status(500).json({ error: 'Logout failed' });
      }
    },

    async status(req, res) {
      try {
        if (!accounts) {
          return res.json({ authenticationRequired: Boolean(token) });
        }
        const accountCount = await accounts.count();
        const user = await resolveRequestUser(req, { token, accounts, sessionStore });
        return res.json({
          authenticationRequired: accountCount > 0 || Boolean(token),
          accountsConfigured: accountCount > 0,
          authenticated: Boolean(user),
          user: user?.id
            ? { id: user.id, username: user.username, displayName: user.displayName, role: user.role }
            : null
        });
      } catch (err) {
        console.error('Auth status failed:', err);
        return res.status(500).json({ error: 'Failed to load authentication status' });
      }
    },

    // Mounted behind the auth middleware, so req.user is always present.
    async changePassword(req, res) {
      try {
        if (!req.user?.id) {
          return res.status(400).json({ error: 'Password changes require an account session' });
        }
        const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
        if (newPassword.length < 8) {
          return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }
        const verified = await accounts.verifyLogin(req.user.username, currentPassword);
        if (!verified) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
        await accounts.changePassword(req.user.id, newPassword);
        // Revoke every other session so a stolen device loses access.
        await sessionStore.destroyAllForUser(req.user.id, { exceptToken: req.user.sessionToken });
        return res.status(204).end();
      } catch (err) {
        console.error('Password change failed:', err);
        return res.status(500).json({ error: 'Failed to change password' });
      }
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
  createSessionStore,
  hashSessionToken,
  isPublicRequest,
  parseCookies,
  requestBearerToken,
  requestToken,
  requireAdmin,
  resolveRequestUser,
  sessionCookieOptions,
  timingSafeEqualStrings,
  verifySession
};
