/** Shared-token sessions and private-route middleware tests. */

const assert = require('assert');
const {
  SESSION_COOKIE,
  createAuthMiddleware,
  createAuthRoutes,
  createSession,
  parseCookies,
  requestToken,
  verifySession
} = require('../lib/auth');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    cookies: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.cookies.push({ name, value: '', options, cleared: true }); return this; }
  };
}

function run(middleware, { method = 'GET', path = '/api/library', headers = {} } = {}) {
  const req = { method, path, headers };
  const res = response();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

const secured = createAuthMiddleware({ token: 'secret-token' });
const open = createAuthMiddleware({ token: '' });

test('no configured token preserves trusted-LAN behavior', () => {
  assert(run(open, { method: 'GET', path: '/api/library' }).nextCalled);
  assert(run(open, { method: 'DELETE', path: '/api/book/a' }).nextCalled);
});

test('static assets and health remain public', () => {
  assert(run(secured, { path: '/js/api.js' }).nextCalled);
  assert(run(secured, { path: '/health' }).nextCalled);
});

test('private GET, HEAD, Range audio, and mutations require auth', () => {
  for (const input of [
    { method: 'GET', path: '/api/library' },
    { method: 'HEAD', path: '/api/audio/book/0' },
    { method: 'GET', path: '/api/audio/book/0', headers: { range: 'bytes=0-99' } },
    { method: 'POST', path: '/api/upload' }
  ]) {
    const result = run(secured, input);
    assert.strictEqual(result.res.statusCode, 401, `${input.method} ${input.path} should 401`);
    assert(!result.nextCalled, `${input.method} ${input.path} should not reach a handler`);
  }
});

test('authentication bootstrap endpoints and OPTIONS remain public', () => {
  assert(run(secured, { method: 'POST', path: '/api/auth/login' }).nextCalled);
  assert(run(secured, { method: 'GET', path: '/api/auth/status' }).nextCalled);
  assert(run(secured, { method: 'OPTIONS', path: '/api/library' }).nextCalled);
});

test('valid bearer token grants private route access', () => {
  const result = run(secured, { headers: { authorization: 'Bearer secret-token' } });
  assert(result.nextCalled);
});

test('signed session grants private route access without storing the shared token', () => {
  const now = Date.now();
  const session = createSession('secret-token', { now, ttlMs: 10_000 });
  assert(verifySession(session, 'secret-token', { now: now + 1 }));
  assert(!verifySession(session, 'wrong-token', { now: now + 1 }));
  assert(!session.includes('secret-token'));
  const result = run(secured, { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  assert(result.nextCalled);
  assert.strictEqual(requestToken({ headers: { cookie: `${SESSION_COOKIE}=${session}` } }, 'secret-token'), 'secret-token');
});

test('an aged shared-token session cookie is re-signed with a fresh TTL', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const middleware = createAuthMiddleware({ token: 'secret-token', sessionTtlMs: 30 * DAY });
  // One hour of life left — well past the renewal window.
  const aged = createSession('secret-token', { ttlMs: 60 * 60 * 1000 });
  const renewed = run(middleware, { headers: { cookie: `${SESSION_COOKIE}=${aged}` } });
  assert(renewed.nextCalled);
  assert.strictEqual(renewed.res.cookies.length, 1);
  assert.strictEqual(renewed.res.cookies[0].name, SESSION_COOKIE);
  assert(verifySession(renewed.res.cookies[0].value, 'secret-token'));
  // A fresh session is left untouched.
  const fresh = createSession('secret-token', { ttlMs: 30 * DAY });
  const kept = run(middleware, { headers: { cookie: `${SESSION_COOKIE}=${fresh}` } });
  assert(kept.nextCalled);
  assert.strictEqual(kept.res.cookies.length, 0);
  // Bearer clients hold no cookie and never receive one.
  const bearer = run(middleware, { headers: { authorization: 'Bearer secret-token' } });
  assert(bearer.nextCalled);
  assert.strictEqual(bearer.res.cookies.length, 0);
});

test('expired or malformed sessions are rejected', () => {
  const expired = createSession('secret-token', { now: 1_000, ttlMs: 1 });
  assert(!verifySession(expired, 'secret-token', { now: 1_001 }));
  assert(!verifySession('not-a-session', 'secret-token'));
  assert.strictEqual(run(secured, { headers: { cookie: `${SESSION_COOKIE}=${expired}` } }).res.statusCode, 401);
});

test('login sets an HttpOnly Lax cookie and never returns the token', () => {
  const routes = createAuthRoutes({ token: 'secret-token', sessionTtlMs: 60_000 });
  const req = { body: { token: 'secret-token' }, secure: true };
  const res = response();
  routes.login(req, res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.body, null);
  assert.strictEqual(res.cookies.length, 1);
  const [cookie] = res.cookies;
  assert.strictEqual(cookie.name, SESSION_COOKIE);
  assert.strictEqual(cookie.options.httpOnly, true);
  assert.strictEqual(cookie.options.sameSite, 'lax');
  assert.strictEqual(cookie.options.secure, true);
  assert(verifySession(cookie.value, 'secret-token'));
});

test('invalid login is redacted and does not issue a cookie', () => {
  const routes = createAuthRoutes({ token: 'secret-token' });
  const res = response();
  routes.login({ body: { token: 'wrong' }, secure: false }, res);
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: 'Unauthorized' });
  assert.strictEqual(res.cookies.length, 0);
});

test('logout clears the session without issuing a new positive lifetime', () => {
  const routes = createAuthRoutes({ token: 'secret-token' });
  const res = response();
  routes.logout({ secure: true }, res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.cookies[0].name, SESSION_COOKIE);
  assert.strictEqual(res.cookies[0].cleared, true);
  assert.strictEqual('maxAge' in res.cookies[0].options, false);
});

test('parseCookies handles empty and malformed headers', () => {
  assert.deepStrictEqual(parseCookies(''), {});
  assert.deepStrictEqual(parseCookies(undefined), {});
  assert.deepStrictEqual(parseCookies('noequals; =bare; a=1'), { a: '1' });
});

console.log(`\n${'═'.repeat(50)}`);
console.log(`auth tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
