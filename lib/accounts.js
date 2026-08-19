// Username/password accounts for a multi-user instance.
//
// Accounts live in data/accounts.json and reuse the usr_* id space of the
// sync profiles in users.json, so an account created with an existing
// profile id inherits that profile's positions, bookmarks, and settings
// without any data migration. Passwords are stored as scrypt hashes
// (node:crypto, no external dependencies); parameters ride along with each
// record so they can be raised later without invalidating old hashes.

const nodeCrypto = require('crypto');

// 2^17: current OWASP guidance minimum for scrypt (the 2009 paper's
// "interactive" 2^14 this replaced is 8x cheaper to brute-force).
const SCRYPT_DEFAULTS = Object.freeze({ N: 131072, r: 8, p: 1 });
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const USERNAME_PATTERN = /^[a-z0-9_-]{2,32}$/;

// node:crypto's scrypt refuses to run once the derivation's own working set
// (~128 * N * r bytes) exceeds `maxmem`, which defaults to 32MB. At the
// raised defaults above that working set is ~128MB, so every call must pass
// an explicit maxmem sized from the record's own N/r, or the derivation
// throws instead of running -- silently locking accounts (including ones
// hashed under older, cheaper parameters) out of login.
function scryptMaxMem(N, r) {
  return Math.max(32 * 1024 * 1024, 128 * N * r * 2);
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : '';
}

// scrypt is deliberately expensive -- roughly 100ms per derivation at these
// parameters. Run synchronously on the single Node event loop it is not a
// password control but a remote stall primitive: POST /api/auth/login is
// unauthenticated, and verifyLogin derives a hash even for unknown usernames,
// so a trickle of login attempts freezes playback, imports and every other
// request for everyone. The async form runs on the libuv threadpool instead,
// so the cost lands on a worker thread and concurrent attempts queue there.
function scryptAsync(crypto, password, salt, keyBytes, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyBytes, params, (error, derived) => {
      if (error) reject(error); else resolve(derived);
    });
  });
}

async function hashPassword(password, { N = SCRYPT_DEFAULTS.N, r = SCRYPT_DEFAULTS.r, p = SCRYPT_DEFAULTS.p, crypto = nodeCrypto } = {}) {
  if (typeof password !== 'string' || password.length < 1) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(crypto, password, salt, KEY_BYTES, { N, r, p, maxmem: scryptMaxMem(N, r) });
  return {
    algo: 'scrypt',
    N,
    r,
    p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64')
  };
}

async function verifyPassword(password, record, { crypto = nodeCrypto } = {}) {
  if (typeof password !== 'string' || !record || record.algo !== 'scrypt') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = await scryptAsync(crypto, password, salt, expected.length, {
      N: record.N, r: record.r, p: record.p, maxmem: scryptMaxMem(record.N, record.r)
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    disabled: Boolean(account.disabled),
    createdAt: account.createdAt
  };
}

function normalizeAccountsStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  // Rebuild the map with no prototype chain rather than trusting whatever
  // JSON.parse produced. store.accounts[id] would otherwise resolve
  // __proto__/constructor/etc. to inherited, truthy non-account values for
  // any id that was never actually created -- a null-prototype map makes
  // every lookup below (findById, changePassword, setDisabled, the
  // duplicate-id check in createAccount) correct with no per-call-site guard.
  const accounts = Object.assign(Object.create(null), store.accounts && typeof store.accounts === 'object' ? store.accounts : {});
  store.accounts = accounts;
  return store;
}

function validateAccountsStore(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'top level must be an object';
  }
  if (raw.accounts !== undefined &&
      (raw.accounts === null || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts))) {
    return 'accounts must be an object when present';
  }
  if (raw.accounts === undefined) return true;

  for (const [key, account] of Object.entries(raw.accounts)) {
    if (account === null || typeof account !== 'object' || Array.isArray(account)) {
      return `account ${key} must be an object`;
    }
    if (typeof account.id !== 'string' || !account.id || account.id !== key) {
      return `account ${key} must have an id matching its key`;
    }
    if (typeof account.username !== 'string' ||
        normalizeUsername(account.username) !== account.username) {
      return `account ${key} has an invalid username`;
    }
    if (account.role !== 'admin' && account.role !== 'member') {
      return `account ${key} has an invalid role`;
    }
    if (account.disabled !== undefined && typeof account.disabled !== 'boolean') {
      return `account ${key} has an invalid disabled flag`;
    }
    const password = account.password;
    if (password === null || typeof password !== 'object' || Array.isArray(password) ||
        password.algo !== 'scrypt' ||
        !Number.isInteger(password.N) || password.N < 2 || (password.N & (password.N - 1)) !== 0 ||
        password.N > 1_048_576 ||
        !Number.isInteger(password.r) || password.r < 1 || password.r > 64 ||
        !Number.isInteger(password.p) || password.p < 1 || password.p > 64 ||
        !isUsableBase64(password.salt) || !isUsableBase64(password.hash)) {
      return `account ${key} has an invalid password record`;
    }
  }
  return true;
}

function isUsableBase64(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length >= 16 && decoded.length <= 128;
  } catch {
    return false;
  }
}

function createAccountsStore({ filePath, jsonStore, crypto = nodeCrypto, now = Date.now }) {
  const persistence = typeof jsonStore.createCriticalStore === 'function'
    ? jsonStore.createCriticalStore({
        filePath,
        defaultValue: {},
        validate: validateAccountsStore,
        maxBackups: 5
      })
    : {
        // Keep lightweight injected stores compatible. Production uses the
        // critical-store path above.
        load: () => jsonStore.load(filePath, {}),
        update: mutator => jsonStore.update(filePath, mutator, {})
      };

  async function loadStore() {
    return normalizeAccountsStore(await persistence.load());
  }

  // Built once, here, rather than on every failed login (see
  // login-timing-oracle-inverted-dummy-hash.md): re-deriving a fresh dummy
  // hash per unknown-username attempt cost a SECOND scrypt derivation on top
  // of the one verifyLogin always performs, so an unknown username took
  // roughly twice as long as a known one -- exactly the timing oracle the
  // dummy hash was meant to close. Starting the derivation here, at
  // construction, means it is normally already resolved by the time the
  // first login request arrives over the network, and every caller of
  // verifyLogin -- including concurrent ones -- awaits this same promise
  // instead of deriving its own. crypto.randomBytes rather than a literal
  // string, so no publicly known password can ever verify against it.
  //
  // The rejection is swallowed to null rather than left to propagate: an
  // unhandled rejection here would be logged at startup, and -- worse -- every
  // later `await` on this promise would throw, turning each unknown-username
  // login into a 500 while a known username still returned 401. That is the
  // very oracle this dummy exists to remove. On failure verifyLogin derives a
  // throwaway record on demand instead, which is still exactly one derivation.
  let dummyRecordPromise = hashPassword(crypto.randomBytes(32).toString('hex'), { crypto })
    .catch(() => null);

  async function dummyPasswordRecord() {
    const precomputed = await dummyRecordPromise;
    if (precomputed) return precomputed;
    // Retry once and cache the result, so a transient startup failure does not
    // cost a fresh derivation on every subsequent unknown-username login.
    dummyRecordPromise = hashPassword(crypto.randomBytes(32).toString('hex'), { crypto })
      .catch(() => null);
    return dummyRecordPromise;
  }

  function findAccountByUsername(store, username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return null;
    return Object.values(store.accounts).find(account => account.username === normalized) || null;
  }

  return {
    async count() {
      return Object.keys((await loadStore()).accounts).length;
    },

    async list() {
      return Object.values((await loadStore()).accounts).map(publicAccount);
    },

    async findById(id) {
      const store = await loadStore();
      return store.accounts[id] || null;
    },

    async findByUsername(username) {
      return findAccountByUsername(await loadStore(), username);
    },

    async createAccount({ username, password, displayName, role = 'member', id = null }) {
      const normalized = normalizeUsername(username);
      if (!normalized) throw new Error('Username must be 2-32 characters: lowercase letters, digits, _ or -');
      if (role !== 'admin' && role !== 'member') throw new Error('Role must be admin or member');
      const passwordRecord = await hashPassword(password, { crypto });
      const accountId = id || `usr_${crypto.randomBytes(12).toString('hex')}`;
      const createdAt = new Date(now()).toISOString();
      const account = {
        id: accountId,
        username: normalized,
        displayName: String(displayName || '').trim().slice(0, 80) || normalized,
        role,
        password: passwordRecord,
        createdAt,
        passwordChangedAt: createdAt,
        disabled: false
      };
      await persistence.update((data) => {
        const store = normalizeAccountsStore(data);
        if (store.accounts[accountId]) throw new Error(`Account id already exists: ${accountId}`);
        if (findAccountByUsername(store, normalized)) throw new Error(`Username already exists: ${normalized}`);
        store.accounts[accountId] = account;
      });
      return publicAccount(account);
    },

    async verifyLogin(username, password) {
      const account = findAccountByUsername(await loadStore(), username);
      // Verify against the account's own record when it exists, or the
      // shared dummy record when it doesn't, so response timing does not
      // reveal which usernames exist -- either way this is exactly one
      // derivation.
      const record = account?.password || await dummyPasswordRecord();
      // With no usable dummy record there is nothing to compare against; fail
      // the login rather than skipping the derivation and leaking the timing.
      if (!record) return null;
      const valid = await verifyPassword(password, record, { crypto });
      if (!account || !valid || account.disabled) return null;
      // A successful login is the one moment the plaintext password is
      // available and a stale record is known to be stale -- raising
      // SCRYPT_DEFAULTS otherwise only protects accounts created or changed
      // *after* the raise (the operator's own long-lived admin account would
      // stay on the old, cheaper parameters forever). This is a maintenance
      // rehash, not a user-initiated change, so it does not touch
      // passwordChangedAt or revoke other sessions the way changePassword does.
      if (record.N < SCRYPT_DEFAULTS.N || record.r < SCRYPT_DEFAULTS.r || record.p < SCRYPT_DEFAULTS.p) {
        const rehashed = await hashPassword(password, { crypto });
        await persistence.update((data) => {
          const store = normalizeAccountsStore(data);
          const stored = store.accounts[account.id];
          if (!stored) return jsonStore.SKIP_SAVE;
          stored.password = rehashed;
          return true;
        });
      }
      return publicAccount(account);
    },

    async changePassword(id, newPassword) {
      const passwordRecord = await hashPassword(newPassword, { crypto });
      const changed = await persistence.update((data) => {
        const store = normalizeAccountsStore(data);
        const account = store.accounts[id];
        if (!account) return jsonStore.SKIP_SAVE;
        account.password = passwordRecord;
        account.passwordChangedAt = new Date(now()).toISOString();
        return true;
      });
      return changed === true;
    },

    async setDisabled(id, disabled) {
      const changed = await persistence.update((data) => {
        const store = normalizeAccountsStore(data);
        const account = store.accounts[id];
        if (!account) return jsonStore.SKIP_SAVE;
        account.disabled = Boolean(disabled);
        return true;
      });
      return changed === true;
    }
  };
}

module.exports = {
  SCRYPT_DEFAULTS,
  normalizeUsername,
  hashPassword,
  verifyPassword,
  publicAccount,
  normalizeAccountsStore,
  validateAccountsStore,
  createAccountsStore
};
