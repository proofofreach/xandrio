/** Username/password accounts, server-side sessions, and account-mode auth tests. */

const assert = require('assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const realJsonStore = require('../lib/json-store');
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

test('hashPassword round-trips and rejects wrong passwords', async () => {
  const record = await hashPassword('correct horse');
  assert.strictEqual(record.algo, 'scrypt');
  assert(await verifyPassword('correct horse', record));
  assert(!await verifyPassword('wrong horse', record));
  assert(!await verifyPassword('correct horse', null));
  assert(!await verifyPassword('correct horse', { ...record, hash: record.salt }));
});

test('hashPassword salts every record', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.hash, b.hash);
});

test('password derivation never blocks the event loop', async () => {
  // The login route is unauthenticated, so a synchronous derivation here is a
  // remote stall primitive: this asserts the loop keeps turning during one.
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 1);
  try {
    await hashPassword('a password worth deriving');
  } finally {
    clearInterval(ticker);
  }
  assert(ticks > 0, 'the event loop advanced while scrypt ran');
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

test('verifyLogin performs exactly one derivation whether or not the username exists', async () => {
  // Counting calls through the injectable crypto seam rather than timing the
  // wall clock -- a timing assertion would be flaky. The dummy record built
  // once at store construction must not add a second derivation to any
  // individual verifyLogin call, and concurrent unknown-username logins must
  // share it rather than each deriving their own.
  const nodeCrypto = require('crypto');
  let scryptCalls = 0;
  const countingCrypto = {
    randomBytes: nodeCrypto.randomBytes,
    timingSafeEqual: nodeCrypto.timingSafeEqual,
    scrypt(...args) { scryptCalls++; return nodeCrypto.scrypt(...args); }
  };
  const jsonStore = memoryJsonStore();
  const accounts = createAccountsStore({ filePath: 'accounts.json', jsonStore, crypto: countingCrypto });
  // The constructor's own dummy-record derivation (from crypto.randomBytes,
  // not a literal string) happens here, before any login, so it never counts
  // against a login's own cost.
  await accounts.createAccount({ username: 'reader', password: 'password123' });

  scryptCalls = 0;
  await accounts.verifyLogin('reader', 'wrong-password');
  assert.strictEqual(scryptCalls, 1, 'a known username performs exactly one derivation');

  scryptCalls = 0;
  await accounts.verifyLogin('nobody', 'wrong-password');
  assert.strictEqual(scryptCalls, 1, 'an unknown username performs exactly one derivation, matching a known one');

  scryptCalls = 0;
  await Promise.all([
    accounts.verifyLogin('nobody-a', 'wrong-password'),
    accounts.verifyLogin('nobody-b', 'wrong-password')
  ]);
  assert.strictEqual(scryptCalls, 2, 'two concurrent unknown-username logins share the cached dummy record: one derivation each, not one each plus a duplicated dummy build');
});

test('a failed dummy derivation does not become a username oracle of its own', async () => {
  // The precomputed dummy is built at construction. If that derivation fails
  // and the rejection is left to propagate, every unknown-username login
  // throws (500) while a known one still returns 401 -- restoring, in a louder
  // form, exactly the oracle the dummy record exists to remove.
  const nodeCrypto = require('crypto');
  let rejections = 0;
  const onRejection = () => { rejections += 1; };
  process.on('unhandledRejection', onRejection);
  try {
    const failingCrypto = {
      randomBytes: nodeCrypto.randomBytes,
      timingSafeEqual: nodeCrypto.timingSafeEqual,
      scrypt(_password, _salt, _keylen, _options, callback) {
        callback(new Error('derivation unavailable'));
      }
    };
    const accounts = createAccountsStore({
      filePath: 'accounts.json',
      jsonStore: memoryJsonStore(),
      crypto: failingCrypto
    });
    assert.strictEqual(await accounts.verifyLogin('nobody', 'password123'), null,
      'an unknown username still fails closed rather than throwing');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(rejections, 0, 'the failed dummy derivation is handled, not left unhandled');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('verifyLogin transparently rehashes a stale record to current scrypt cost', async () => {
  const { jsonStore, accounts } = makeAccounts();
  const staleRecord = await hashPassword('password123', { N: 16384, r: 8, p: 1 });
  await jsonStore.update('accounts.json', (data) => {
    data.accounts = { usr_stale: { id: 'usr_stale', username: 'reader', displayName: 'Reader', role: 'member', password: staleRecord, disabled: false, createdAt: '2026-01-01T00:00:00.000Z', passwordChangedAt: '2026-01-01T00:00:00.000Z' } };
  }, {});

  const before = (await accounts.verifyLogin('reader', 'password123'));
  assert.strictEqual(before?.id, 'usr_stale');
  const storedAfter = (await jsonStore.load('accounts.json', {})).accounts.usr_stale;
  assert.strictEqual(storedAfter.password.N, 131072, 'record must be rehashed to the current N');
  assert.notStrictEqual(storedAfter.password.hash, staleRecord.hash);
  assert.strictEqual(storedAfter.passwordChangedAt, '2026-01-01T00:00:00.000Z', 'a maintenance rehash is not a user-initiated password change');

  // The rehashed record must still verify correctly and not be re-rehashed again.
  assert((await accounts.verifyLogin('reader', 'password123')));
  const storedTwice = (await jsonStore.load('accounts.json', {})).accounts.usr_stale;
  assert.strictEqual(storedTwice.password.hash, storedAfter.password.hash, 'an already-current record is left alone');

  // A wrong password against a stale record must still fail and must not rehash.
  await jsonStore.update('accounts.json', (data) => {
    data.accounts.usr_stale.password = staleRecord;
  }, {});
  assert.strictEqual(await accounts.verifyLogin('reader', 'wrong-password'), null);
  const storedAfterWrong = (await jsonStore.load('accounts.json', {})).accounts.usr_stale;
  assert.strictEqual(storedAfterWrong.password.N, 16384, 'a failed login must not rehash');
});

test('changePassword rotates the hash', async () => {
  const { accounts } = makeAccounts();
  const created = await accounts.createAccount({ username: 'reader', password: 'password123' });
  assert.strictEqual(await accounts.changePassword(created.id, 'new-password-9'), true);
  assert.strictEqual(await accounts.verifyLogin('reader', 'password123'), null);
  assert.strictEqual((await accounts.verifyLogin('reader', 'new-password-9')).id, created.id);
  assert.strictEqual(await accounts.changePassword('usr_missing', 'irrelevant-1'), false);
});

test('__proto__/constructor ids never resolve to a prototype-chain object', async () => {
  const { accounts } = makeAccounts();
  await accounts.createAccount({ username: 'reader', password: 'password123' });

  // (a) lookups must fail closed instead of returning Object.prototype /
  // the Object constructor for an id that was never created.
  assert.strictEqual(await accounts.findById('__proto__'), null);
  assert.strictEqual(await accounts.findById('constructor'), null);

  // (b) a write through the __proto__ alias must not land on Object.prototype.
  assert.strictEqual(await accounts.changePassword('__proto__', 'irrelevant-pw'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'password'), false);
  assert.strictEqual(await accounts.setDisabled('__proto__', true), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'disabled'), false);

  // (c) creating an account with id '__proto__' must not re-parent the map
  // via the accessor (store.accounts has no prototype, so there is no
  // accessor to trigger) -- it must genuinely create and persist that
  // account like any other id, not silently report success without storing.
  const created = await accounts.createAccount({ username: 'proto-user', password: 'password123', id: '__proto__' });
  assert.strictEqual(created.id, '__proto__');
  const stored = await accounts.findById('__proto__');
  assert.strictEqual(stored?.username, 'proto-user');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'username'), false, 'Object.prototype must stay clean');
});

test('a legitimate account literally named "__proto__" still behaves normally', async () => {
  // JSON.parse would have created this as an *own* data property that
  // shadows the accessor; Object.assign onto a null-prototype target must
  // preserve that same own-property behaviour.
  const { jsonStore, accounts } = makeAccounts();
  await jsonStore.update('accounts.json', async (data) => {
    // JSON.parse always creates an *own* data property, never triggers the
    // __proto__ accessor -- reproduce that with a computed key rather than
    // an object-literal `{ __proto__: ... }`, which would re-parent the
    // object instead of adding a key.
    data.accounts = JSON.parse(JSON.stringify({ ['__proto__']: { id: '__proto__', username: 'legacyname', role: 'member', password: await hashPassword('password123'), disabled: false, createdAt: '2026-01-01T00:00:00.000Z' } }));
  }, {});
  const found = await accounts.findById('__proto__');
  assert.strictEqual(found?.username, 'legacyname');
});

test('production accounts store refuses corrupt or invalid state without replacing it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'accounts-critical-test-'));
  try {
    const corruptPath = path.join(dir, 'corrupt-accounts.json');
    const corruptRaw = '{"accounts":';
    await fsp.writeFile(corruptPath, corruptRaw);
    const corruptStore = createAccountsStore({ filePath: corruptPath, jsonStore: realJsonStore });
    await assert.rejects(
      corruptStore.createAccount({ username: 'reader', password: 'password123' }),
      error => error.code === 'JSON_STORE_CORRUPT'
    );
    assert.strictEqual(await fsp.readFile(corruptPath, 'utf8'), corruptRaw);

    const invalidPath = path.join(dir, 'invalid-accounts.json');
    const invalidRaw = '{"accounts":[]}';
    await fsp.writeFile(invalidPath, invalidRaw);
    const invalidStore = createAccountsStore({ filePath: invalidPath, jsonStore: realJsonStore });
    await assert.rejects(
      invalidStore.createAccount({ username: 'reader', password: 'password123' }),
      error => error.code === 'JSON_STORE_VALIDATION_FAILED'
    );
    assert.strictEqual(await fsp.readFile(invalidPath, 'utf8'), invalidRaw);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('account validation rejects malformed records without overwriting them', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'accounts-record-validation-'));
  const valid = {
    id: 'usr_valid',
    username: 'reader',
    displayName: 'Reader',
    role: 'member',
    password: await hashPassword('password123'),
    disabled: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  const cases = [
    ['null record', null],
    ['mismatched id', { ...valid, id: 'usr_other' }],
    ['invalid username', { ...valid, username: 'Reader Name' }],
    ['invalid role', { ...valid, role: 'owner' }],
    ['invalid disabled flag', { ...valid, disabled: 'false' }],
    ['missing password', { ...valid, password: null }],
    ['malformed password', { ...valid, password: { ...valid.password, hash: 'not base64!' } }]
  ];
  try {
    for (const [name, record] of cases) {
      const filePath = path.join(dir, `${name.replaceAll(' ', '-')}.json`);
      const raw = JSON.stringify({ accounts: { usr_valid: record } });
      await fsp.writeFile(filePath, raw);
      const accounts = createAccountsStore({ filePath, jsonStore: realJsonStore });
      await assert.rejects(
        accounts.count(),
        error => error.code === 'JSON_STORE_VALIDATION_FAILED',
        name
      );
      assert.strictEqual(await fsp.readFile(filePath, 'utf8'), raw, name);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('production accounts store backs up valid state before mutation', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'accounts-backup-test-'));
  try {
    const filePath = path.join(dir, 'accounts.json');
    const accounts = createAccountsStore({ filePath, jsonStore: realJsonStore });
    const account = await accounts.createAccount({
      username: 'reader',
      password: 'password123'
    });
    await accounts.setDisabled(account.id, true);

    const backupDir = `${filePath}.backups`;
    const names = await fsp.readdir(backupDir);
    assert.strictEqual(names.length, 1);
    const backup = JSON.parse(await fsp.readFile(path.join(backupDir, names[0]), 'utf8'));
    assert.strictEqual(backup.accounts[account.id].disabled, false);
    assert.strictEqual((await accounts.findById(account.id)).disabled, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
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

test('production sessions store validates old state and backs up mutations', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sessions-critical-test-'));
  try {
    const invalidPath = path.join(dir, 'invalid-sessions.json');
    const invalidRaw = '{"sessions":[]}';
    await fsp.writeFile(invalidPath, invalidRaw);
    const invalidStore = createSessionStore({
      filePath: invalidPath,
      jsonStore: realJsonStore,
      ttlMs: 60_000
    });
    await assert.rejects(
      invalidStore.create('usr_a'),
      error => error.code === 'JSON_STORE_VALIDATION_FAILED'
    );
    assert.strictEqual(await fsp.readFile(invalidPath, 'utf8'), invalidRaw);

    const filePath = path.join(dir, 'sessions.json');
    await fsp.writeFile(filePath, '{}');
    const sessions = createSessionStore({
      filePath,
      jsonStore: realJsonStore,
      ttlMs: 60_000
    });
    const first = await sessions.create('usr_a');
    const second = await sessions.create('usr_b');
    assert((await sessions.resolve(first.token)).userId === 'usr_a');
    assert((await sessions.resolve(second.token)).userId === 'usr_b');

    const names = await fsp.readdir(`${filePath}.backups`);
    assert.strictEqual(names.length, 2);
    const snapshots = await Promise.all(names.map(async name =>
      JSON.parse(await fsp.readFile(path.join(`${filePath}.backups`, name), 'utf8'))
    ));
    assert(snapshots.some(snapshot => Object.keys(snapshot.sessions || {}).length === 1));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
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

// ─── Sliding session renewal ───────────────────────────────────────────────

test('touch extends a live session and reports the new expiry', async () => {
  let clock = 1_000_000;
  const jsonStore = memoryJsonStore();
  const sessionStore = createSessionStore({ filePath: 'sessions.json', jsonStore, ttlMs: 60_000, now: () => clock });
  const { token } = await sessionStore.create('usr_1');
  clock += 50_000;
  const renewed = await sessionStore.touch(token);
  assert.strictEqual(renewed, clock + 60_000);
  clock += 55_000; // Past the original expiry, inside the renewed one.
  assert.strictEqual((await sessionStore.resolve(token)).userId, 'usr_1');
  assert.strictEqual(await sessionStore.touch('missing-token'), null);
});

test('an aged account session slides: store extended and cookie re-issued', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let clock = 1_000_000;
  const jsonStore = memoryJsonStore();
  const accounts = createAccountsStore({ filePath: 'accounts.json', jsonStore });
  const sessionStore = createSessionStore({ filePath: 'sessions.json', jsonStore, ttlMs: 30 * DAY, now: () => clock });
  const member = await accounts.createAccount({ username: 'member', password: 'password123' });
  const middleware = createAuthMiddleware({ token: 'legacy-token', accounts, sessionStore, sessionTtlMs: 30 * DAY, now: () => clock });
  const { token } = await sessionStore.create(member.id);

  // Within the renewal window: no store write, no Set-Cookie.
  const fresh = await runMiddleware(middleware, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert(fresh.nextCalled);
  assert.strictEqual(fresh.res.cookies.length, 0);

  // Past the window: expiry slides to a full TTL and the cookie is refreshed.
  clock += 2 * DAY;
  const aged = await runMiddleware(middleware, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert(aged.nextCalled);
  assert.strictEqual(aged.res.cookies.length, 1);
  assert.strictEqual(aged.res.cookies[0].name, SESSION_COOKIE);
  assert.strictEqual(aged.res.cookies[0].value, token);
  assert.strictEqual((await sessionStore.resolve(token)).expiresAtMs, clock + 30 * DAY);
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
  assert.deepStrictEqual(anonymous.body, {
    authenticationRequired: true,
    accountsConfigured: true,
    authenticated: false,
    user: null
  });
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

// ─── Admin account-management routes ───────────────────────────────────────

const { registerAccountRoutes } = require('../lib/routes/accounts-routes');

function routerStub() {
  const routes = {};
  const record = method => (path, ...handlers) => { routes[`${method} ${path}`] = handlers; };
  return { routes, get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE') };
}

async function invoke(handlers, req) {
  const res = response();
  let index = 0;
  const next = async () => {
    const handler = handlers[index++];
    if (handler) await handler(req, res, next);
  };
  await next();
  return res;
}

async function adminRoutesFixture() {
  const fixture = await accountModeFixture();
  const app = routerStub();
  registerAccountRoutes(app, { accounts: fixture.accounts, sessionStore: fixture.sessionStore, requireAdmin });
  return { ...fixture, routes: { ...fixture.routes, ...app.routes }, adminRoutes: app.routes };
}

test('account routes are admin-gated', async () => {
  const { adminRoutes, member } = await adminRoutesFixture();
  const asMember = await invoke(adminRoutes['GET /api/accounts'], { user: { id: member.id, role: 'member' }, headers: {} });
  assert.strictEqual(asMember.statusCode, 403);
  const asAdmin = await invoke(adminRoutes['GET /api/accounts'], { user: { role: 'admin' }, headers: {} });
  assert.strictEqual(asAdmin.body.accounts.length, 2);
  assert(!asAdmin.body.accounts.some(account => 'password' in account), 'listing must not expose hashes');
});

test('admin can create accounts; duplicates and short passwords rejected', async () => {
  const { adminRoutes, accounts } = await adminRoutesFixture();
  const adminReq = body => ({ user: { role: 'admin' }, body, headers: {} });
  const created = await invoke(adminRoutes['POST /api/accounts'], adminReq({ username: 'newbie', password: 'long-enough-1', role: 'member' }));
  assert.strictEqual(created.body.account.username, 'newbie');
  assert((await accounts.verifyLogin('newbie', 'long-enough-1')));
  const short = await invoke(adminRoutes['POST /api/accounts'], adminReq({ username: 'x2', password: 'short' }));
  assert.strictEqual(short.statusCode, 400);
  const duplicate = await invoke(adminRoutes['POST /api/accounts'], adminReq({ username: 'newbie', password: 'long-enough-1' }));
  assert.strictEqual(duplicate.statusCode, 400);
});

test('admin password reset revokes the target sessions', async () => {
  const { adminRoutes, accounts, sessionStore, member } = await adminRoutesFixture();
  const session = await sessionStore.create(member.id);
  const reset = await invoke(adminRoutes['POST /api/accounts/:id/password'], {
    user: { role: 'admin' }, params: { id: member.id }, body: { newPassword: 'fresh-password-1' }, headers: {}
  });
  assert.strictEqual(reset.body.success, true);
  assert.strictEqual(await sessionStore.resolve(session.token), null);
  assert((await accounts.verifyLogin('member', 'fresh-password-1')));
  const missing = await invoke(adminRoutes['POST /api/accounts/:id/password'], {
    user: { role: 'admin' }, params: { id: 'usr_missing' }, body: { newPassword: 'fresh-password-1' }, headers: {}
  });
  assert.strictEqual(missing.statusCode, 404);
});

test('disable guards: not yourself, never the last admin', async () => {
  const { adminRoutes, accounts, sessionStore, admin, member } = await adminRoutesFixture();
  const self = await invoke(adminRoutes['POST /api/accounts/:id/disabled'], {
    user: { id: admin.id, role: 'admin' }, params: { id: admin.id }, body: { disabled: true }, headers: {}
  });
  assert.strictEqual(self.statusCode, 400);
  const lastAdmin = await invoke(adminRoutes['POST /api/accounts/:id/disabled'], {
    user: { id: 'usr_other', role: 'admin' }, params: { id: admin.id }, body: { disabled: true }, headers: {}
  });
  assert.strictEqual(lastAdmin.statusCode, 400);
  const memberSession = await sessionStore.create(member.id);
  const ok = await invoke(adminRoutes['POST /api/accounts/:id/disabled'], {
    user: { id: admin.id, role: 'admin' }, params: { id: member.id }, body: { disabled: true }, headers: {}
  });
  assert.strictEqual(ok.body.success, true);
  assert.strictEqual((await accounts.findById(member.id)).disabled, true);
  assert.strictEqual(await sessionStore.resolve(memberSession.token), null);
  const reEnable = await invoke(adminRoutes['POST /api/accounts/:id/disabled'], {
    user: { id: admin.id, role: 'admin' }, params: { id: member.id }, body: { disabled: false }, headers: {}
  });
  assert.strictEqual(reEnable.body.success, true);
  assert.strictEqual((await accounts.findById(member.id)).disabled, false);
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
