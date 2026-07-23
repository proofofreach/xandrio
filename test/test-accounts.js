/** Username/password accounts, server-side sessions, and account-mode auth tests. */

const assert = require('assert');
const {
  normalizeUsername,
  hashPassword,
  verifyPassword,
  createAccountsStore
} = require('../lib/accounts');
const {
  SESSION_COOKIE,
  createAuthMiddleware,
  createAuthRoutes,
  createSessionStore,
  requireAdmin,
  resolveRequestUser
} = require('../lib/auth');

let passed = 0;
let failed = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
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

// In-memory json-store with the same contract as lib/json-store.js.
function memoryJsonStore() {
  const SKIP_SAVE = Symbol('skip-save');
  const files = new Map();
  return {
    SKIP_SAVE,
    async load(filePath, defaultValue = {}) {
      if (!files.has(filePath)) return structuredClone(defaultValue);
      return structuredClone(files.get(filePath));
    },
    async update(filePath, mutator, defaultValue = {}) {
      const data = files.has(filePath) ? structuredClone(files.get(filePath)) : structuredClone(defaultValue);
      const result = await mutator(data);
      if (result !== SKIP_SAVE) files.set(filePath, data);
      return result;
    }
  };
}

function makeAccounts({ now = Date.now } = {}) {
  const jsonStore = memoryJsonStore();
  return { jsonStore, accounts: createAccountsStore({ filePath: 'accounts.json', jsonStore, now }) };
}

function makeSessions({ jsonStore = memoryJsonStore(), ttlMs = 60_000, now = Date.now } = {}) {
  return createSessionStore({ filePath: 'sessions.json', jsonStore, ttlMs, now });
}

// ─── Password hashing ──────────────────────────────────────────────────────

test('normalizeUsername lowercases and rejects invalid names', () => {
  assert.strictEqual(normalizeUsername('  Kirill '), 'kirill');
  assert.strictEqual(normalizeUsername('a'), '');
  assert.strictEqual(normalizeUsername('has space'), '');
  assert.strictEqual(normalizeUsername('ok_name-2'), 'ok_name-2');
  assert.strictEqual(normalizeUsername('x'.repeat(33)), '');
});

test('hashPassword round-trips and rejects wrong passwords', () => {
  const record = hashPassword('correct horse');
  assert.strictEqual(record.algo, 'scrypt');
  assert(verifyPassword('correct horse', record));
  assert(!verifyPassword('wrong horse', record));
  assert(!verifyPassword('correct horse', null));
  assert(!verifyPassword('correct horse', { ...record, hash: record.salt }));
});

test('hashPassword salts every record', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.hash, b.hash);
});

// ─── Accounts store ────────────────────────────────────────────────────────

test('createAccount, findByUsername, count, and duplicate rejection', async () => {
  const { accounts } = makeAccounts();
  assert.strictEqual(await accounts.count(), 0);
  const created = await accounts.createAccount({ username: 'Kirill', password: 'password123', role: 'admin' });
  assert.strictEqual(created.username, 'kirill');
  assert.strictEqual(created.role, 'admin');
  assert(created.id.startsWith('usr_'));
  assert.strictEqual(await accounts.count(), 1);
  const found = await accounts.findByUsername('KIRILL');
  assert.strictEqual(found.id, created.id);
  assert(!('password' in created), 'public account must not expose the password record');
  await assert.rejects(() => accounts.createAccount({ username: 'kirill', password: 'other-pass' }), /already exists/);
});

test('createAccount can bind an existing sync-profile id', async () => {
  const { accounts } = makeAccounts();
  const created = await accounts.createAccount({
    username: 'guest', password: 'password123', id: 'usr_39a85fb75cf0cc6a2e5b64ff'
  });
  assert.strictEqual(created.id, 'usr_39a85fb75cf0cc6a2e5b64ff');
  assert.strictEqual((await accounts.findById('usr_39a85fb75cf0cc6a2e5b64ff')).username, 'guest');
});

test('verifyLogin accepts correct credentials and rejects wrong/disabled', async () => {
  const { accounts } = makeAccounts();
  const created = await accounts.createAccount({ username: 'reader', password: 'password123' });
  assert.strictEqual((await accounts.verifyLogin('reader', 'password123')).id, created.id);
  assert.strictEqual(await accounts.verifyLogin('reader', 'wrong'), null);
  assert.strictEqual(await accounts.verifyLogin('nobody', 'password123'), null);
  await accounts.setDisabled(created.id, true);
  assert.strictEqual(await accounts.verifyLogin('reader', 'password123'), null);
});

test('changePassword rotates the hash', async () => {
  const { accounts } = makeAccounts();
  const created = await accounts.createAccount({ username: 'reader', password: 'password123' });
  assert.strictEqual(await accounts.changePassword(created.id, 'new-password-9'), true);
  assert.strictEqual(await accounts.verifyLogin('reader', 'password123'), null);
  assert.strictEqual((await accounts.verifyLogin('reader', 'new-password-9')).id, created.id);
  assert.strictEqual(await accounts.changePassword('usr_missing', 'irrelevant-1'), false);
});

// ─── Session store ─────────────────────────────────────────────────────────

test('sessions create, resolve, expire, and destroy', async () => {
  let nowMs = 1_000_000;
  const sessions = makeSessions({ ttlMs: 10_000, now: () => nowMs });
  const { token } = await sessions.create('usr_a', { deviceId: 'dev_1' });
  assert((await sessions.resolve(token)).userId === 'usr_a');
  assert.strictEqual((await sessions.resolve(token)).deviceId, 'dev_1');
  assert.strictEqual(await sessions.resolve('bogus'), null);
  nowMs += 10_001;
  assert.strictEqual(await sessions.resolve(token), null, 'expired session must not resolve');
  nowMs -= 10_001;
  await sessions.destroy(token);
  assert.strictEqual(await sessions.resolve(token), null);
});

test('destroyAllForUser keeps only the excepted session', async () => {
  const sessions = makeSessions();
  const a = await sessions.create('usr_a');
  const b = await sessions.create('usr_a');
  const other = await sessions.create('usr_b');
  await sessions.destroyAllForUser('usr_a', { exceptToken: b.token });
  assert.strictEqual(await sessions.resolve(a.token), null);
  assert((await sessions.resolve(b.token)).userId === 'usr_a');
  assert((await sessions.resolve(other.token)).userId === 'usr_b');
});

// ─── resolveRequestUser + middleware ───────────────────────────────────────

async function accountModeFixture({ token = 'legacy-token' } = {}) {
  const jsonStore = memoryJsonStore();
  const accounts = createAccountsStore({ filePath: 'accounts.json', jsonStore });
  const sessionStore = createSessionStore({ filePath: 'sessions.json', jsonStore, ttlMs: 60_000 });
  const admin = await accounts.createAccount({ username: 'admin', password: 'password123', role: 'admin' });
  const member = await accounts.createAccount({ username: 'member', password: 'password123' });
  const middleware = createAuthMiddleware({ token, accounts, sessionStore });
  const routes = createAuthRoutes({ token, sessionTtlMs: 60_000, accounts, sessionStore });
  return { jsonStore, accounts, sessionStore, admin, member, middleware, routes, token };
}

async function runMiddleware(middleware, { method = 'GET', path = '/api/library', headers = {} } = {}) {
  const req = { method, path, headers };
  const res = response();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('zero accounts and no token resolves a trusted-LAN admin', async () => {
  const { jsonStore } = makeAccounts();
  const accounts = createAccountsStore({ filePath: 'accounts.json', jsonStore });
  const user = await resolveRequestUser({ headers: {} }, { token: '', accounts, sessionStore: null });
  assert.deepStrictEqual(user, { id: null, role: 'admin', lan: true });
});

test('zero accounts with a token keeps shared-token semantics', async () => {
  const { jsonStore } = makeAccounts();
  const accounts = createAccountsStore({ filePath: 'accounts.json', jsonStore });
  const sessionStore = createSessionStore({ filePath: 'sessions.json', jsonStore });
  const middleware = createAuthMiddleware({ token: 'secret', accounts, sessionStore });
  assert.strictEqual((await runMiddleware(middleware, {})).res.statusCode, 401);
  const ok = await runMiddleware(middleware, { headers: { authorization: 'Bearer secret' } });
  assert(ok.nextCalled);
  assert.strictEqual(ok.req.user.role, 'admin');
  assert.strictEqual(ok.req.user.id, null);
});

test('account session resolves to the account and sets req.user', async () => {
  const { middleware, sessionStore, member } = await accountModeFixture();
  const { token } = await sessionStore.create(member.id);
  const result = await runMiddleware(middleware, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert(result.nextCalled);
  assert.strictEqual(result.req.user.id, member.id);
  assert.strictEqual(result.req.user.username, 'member');
  assert.strictEqual(result.req.user.role, 'member');
});

test('with accounts present, missing or bogus credentials get 401', async () => {
  const { middleware } = await accountModeFixture();
  assert.strictEqual((await runMiddleware(middleware, {})).res.statusCode, 401);
  const bogus = await runMiddleware(middleware, { headers: { cookie: `${SESSION_COOKIE}=nope` } });
  assert.strictEqual(bogus.res.statusCode, 401);
});

test('with accounts present, the shared token stays valid as Bearer only', async () => {
  const { middleware, token } = await accountModeFixture();
  const bearer = await runMiddleware(middleware, { headers: { authorization: `Bearer ${token}` } });
  assert(bearer.nextCalled);
  assert.strictEqual(bearer.req.user.role, 'admin');
  assert.strictEqual(bearer.req.user.legacy, true);
});

test('disabled accounts lose their sessions', async () => {
  const { middleware, sessionStore, accounts, member } = await accountModeFixture();
  const { token } = await sessionStore.create(member.id);
  await accounts.setDisabled(member.id, true);
  const result = await runMiddleware(middleware, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.strictEqual(result.res.statusCode, 401);
});

test('requireAdmin gates on role', () => {
  const allowed = response();
  let nextCalled = false;
  requireAdmin({ user: { role: 'admin' } }, allowed, () => { nextCalled = true; });
  assert(nextCalled);
  const denied = response();
  requireAdmin({ user: { role: 'member' } }, denied, () => { throw new Error('should not pass'); });
  assert.strictEqual(denied.statusCode, 403);
  const anonymous = response();
  requireAdmin({}, anonymous, () => { throw new Error('should not pass'); });
  assert.strictEqual(anonymous.statusCode, 403);
});

// ─── Auth routes in account mode ───────────────────────────────────────────

test('login issues a revocable session cookie and returns the user', async () => {
  const { routes, sessionStore, member } = await accountModeFixture();
  const res = response();
  await routes.login({ body: { username: 'member', password: 'password123' }, headers: {}, secure: true }, res);
  assert.strictEqual(res.body.user.id, member.id);
  const [cookie] = res.cookies;
  assert.strictEqual(cookie.name, SESSION_COOKIE);
  assert.strictEqual(cookie.options.httpOnly, true);
  assert.strictEqual(cookie.options.secure, true);
  assert.strictEqual((await sessionStore.resolve(cookie.value)).userId, member.id);
});

test('login rejects bad credentials without a cookie', async () => {
  const { routes } = await accountModeFixture();
  const res = response();
  await routes.login({ body: { username: 'member', password: 'wrong' }, headers: {}, secure: false }, res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.cookies.length, 0);
});

test('login falls back to shared-token bootstrap while no accounts exist', async () => {
  const jsonStore = memoryJsonStore();
  const accounts = createAccountsStore({ filePath: 'accounts.json', jsonStore });
  const sessionStore = createSessionStore({ filePath: 'sessions.json', jsonStore });
  const routes = createAuthRoutes({ token: 'secret', accounts, sessionStore });
  const res = response();
  await routes.login({ body: { token: 'secret' }, headers: {}, secure: false }, res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.cookies.length, 1);
});

test('logout destroys the server-side session', async () => {
  const { routes, sessionStore, member } = await accountModeFixture();
  const { token } = await sessionStore.create(member.id);
  const res = response();
  await routes.logout({ headers: { cookie: `${SESSION_COOKIE}=${token}` }, secure: true }, res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(await sessionStore.resolve(token), null);
});

test('status reports authentication state and the current user', async () => {
  const { routes, sessionStore, admin } = await accountModeFixture();
  const anonymous = response();
  await routes.status({ headers: {} }, anonymous);
  assert.deepStrictEqual(anonymous.body, { authenticationRequired: true, authenticated: false, user: null });
  const { token } = await sessionStore.create(admin.id);
  const authed = response();
  await routes.status({ headers: { cookie: `${SESSION_COOKIE}=${token}` } }, authed);
  assert.strictEqual(authed.body.authenticated, true);
  assert.strictEqual(authed.body.user.id, admin.id);
  assert.strictEqual(authed.body.user.role, 'admin');
});

test('changePassword verifies the current password and revokes other sessions', async () => {
  const { routes, sessionStore, accounts, member } = await accountModeFixture();
  const keep = await sessionStore.create(member.id);
  const revoke = await sessionStore.create(member.id);
  const user = { id: member.id, username: member.username, sessionToken: keep.token };

  const wrong = response();
  await routes.changePassword({ user, body: { currentPassword: 'nope', newPassword: 'brand-new-pass' } }, wrong);
  assert.strictEqual(wrong.statusCode, 401);

  const short = response();
  await routes.changePassword({ user, body: { currentPassword: 'password123', newPassword: 'short' } }, short);
  assert.strictEqual(short.statusCode, 400);

  const ok = response();
  await routes.changePassword({ user, body: { currentPassword: 'password123', newPassword: 'brand-new-pass' } }, ok);
  assert.strictEqual(ok.statusCode, 204);
  assert.strictEqual((await accounts.verifyLogin('member', 'brand-new-pass')).id, member.id);
  assert((await sessionStore.resolve(keep.token)).userId === member.id, 'current session survives');
  assert.strictEqual(await sessionStore.resolve(revoke.token), null, 'other sessions are revoked');

  const legacy = response();
  await routes.changePassword({ user: { id: null, legacy: true }, body: {} }, legacy);
  assert.strictEqual(legacy.statusCode, 400);
});

// ─── Runner ────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
    }
  }
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`accounts tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
