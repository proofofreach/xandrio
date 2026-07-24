// Username/password accounts for a multi-user instance.
//
// Accounts live in data/accounts.json and reuse the usr_* id space of the
// sync profiles in users.json, so an account created with an existing
// profile id inherits that profile's positions, bookmarks, and settings
// without any data migration. Passwords are stored as scrypt hashes
// (node:crypto, no external dependencies); parameters ride along with each
// record so they can be raised later without invalidating old hashes.

const nodeCrypto = require('crypto');

const SCRYPT_DEFAULTS = Object.freeze({ N: 16384, r: 8, p: 1 });
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const USERNAME_PATTERN = /^[a-z0-9_-]{2,32}$/;

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : '';
}

function hashPassword(password, { N = SCRYPT_DEFAULTS.N, r = SCRYPT_DEFAULTS.r, p = SCRYPT_DEFAULTS.p, crypto = nodeCrypto } = {}) {
  if (typeof password !== 'string' || password.length < 1) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, KEY_BYTES, { N, r, p });
  return {
    algo: 'scrypt',
    N,
    r,
    p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64')
  };
}

function verifyPassword(password, record, { crypto = nodeCrypto } = {}) {
  if (typeof password !== 'string' || !record || record.algo !== 'scrypt') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: record.N, r: record.r, p: record.p
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
  if (!store.accounts || typeof store.accounts !== 'object') store.accounts = {};
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
      const passwordRecord = hashPassword(password, { crypto });
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
      // Hash even when the user is unknown so response timing does not
      // reveal which usernames exist.
      const record = account?.password || hashPassword('invalid-placeholder', { crypto });
      const valid = verifyPassword(password, record, { crypto });
      if (!account || !valid || account.disabled) return null;
      return publicAccount(account);
    },

    async changePassword(id, newPassword) {
      const passwordRecord = hashPassword(newPassword, { crypto });
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
