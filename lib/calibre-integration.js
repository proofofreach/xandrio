const crypto = require('crypto');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_CONNECTIONS_PER_USER = 20;
// A 6-digit code is only 20 bits, and `/claim` is unauthenticated in every
// deployment mode. Entropy alone cannot carry that, so the code is spent under
// a strict attempt budget instead: the SMS/TOTP convention. Ten wrong guesses
// burn every outstanding pairing, which costs a brute-forcer the whole window
// after 1e-5 of the keyspace and costs a legitimate operator one new code.
const MAX_FAILED_CLAIMS = 10;

function cleanText(value, maxLength = 500) {
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function cleanIdentity(value, label) {
  const cleaned = cleanText(value, 160);
  if (!cleaned || !/^[A-Za-z0-9._:@+-]+$/.test(cleaned)) {
    throw new TypeError(`Calibre ${label} is required and must be a stable identifier`);
  }
  return cleaned;
}

function cleanList(value, { maxItems = 100, maxLength = 120 } = {}) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function sanitizeCalibreMetadata(input = {}) {
  const has = key => Object.prototype.hasOwnProperty.call(input, key);
  const libraryUuid = cleanIdentity(input.libraryUuid, 'library UUID');
  const bookUuid = cleanIdentity(input.bookUuid, 'book UUID');
  const authors = has('authors') ? cleanList(input.authors, { maxItems: 20, maxLength: 180 }) : undefined;
  const author = cleanText(input.author, 500) || (authors?.length ? authors.join(' & ') : (has('author') || has('authors') ? null : undefined));
  const language = has('language') ? (cleanText(input.language, 24)?.toLowerCase() || null) : undefined;
  const seriesIndex = Number(input.seriesIndex);
  const metadata = {
    libraryUuid,
    bookUuid,
    calibreId: has('calibreId') ? (cleanText(input.calibreId, 80) || null) : undefined,
    title: has('title') ? (cleanText(input.title, 500) || null) : undefined,
    authors,
    author,
    language,
    isbn: has('isbn') ? (cleanText(input.isbn, 64) || null) : undefined,
    publisher: has('publisher') ? (cleanText(input.publisher, 240) || null) : undefined,
    publishedDate: has('publishedDate') ? (cleanText(input.publishedDate, 64) || null) : undefined,
    description: has('description') ? (cleanText(input.description, 20_000) || null) : undefined,
    tags: has('tags') ? cleanList(input.tags, { maxItems: 100, maxLength: 120 }) : undefined,
    series: has('series') ? (cleanText(input.series, 240) || null) : undefined,
    seriesIndex: has('seriesIndex') ? (input.seriesIndex === null || input.seriesIndex === ''
      ? null
      : (Number.isFinite(seriesIndex) ? seriesIndex : null)) : undefined,
    lastModified: has('lastModified') ? (cleanText(input.lastModified, 64) || null) : undefined
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function stableCalibreBookId(libraryUuid, bookUuid) {
  const library = cleanIdentity(libraryUuid, 'library UUID');
  const book = cleanIdentity(bookUuid, 'book UUID');
  return crypto.createHash('sha256').update(`calibre\0${library}\0${book}`).digest('hex').slice(0, 40);
}

function normalizeAccessStore(raw) {
  const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!store.pairings || typeof store.pairings !== 'object' || Array.isArray(store.pairings)) store.pairings = {};
  if (!store.connections || typeof store.connections !== 'object' || Array.isArray(store.connections)) store.connections = {};
  if (!Number.isFinite(store.failedClaims) || store.failedClaims < 0) store.failedClaims = 0;
  return store;
}

function validateCalibreAccessStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'top level must be an object';
  if (raw.pairings !== undefined && (!raw.pairings || typeof raw.pairings !== 'object' || Array.isArray(raw.pairings))) {
    return 'pairings must be an object';
  }
  if (raw.connections !== undefined && (!raw.connections || typeof raw.connections !== 'object' || Array.isArray(raw.connections))) {
    return 'connections must be an object';
  }
  for (const [id, connection] of Object.entries(raw.connections || {})) {
    if (!connection || typeof connection !== 'object' || connection.id !== id ||
        typeof connection.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(connection.tokenHash) ||
        typeof connection.userId !== 'string' || !connection.userId) {
      return `connection ${id} is invalid`;
    }
  }
  for (const [hash, pairing] of Object.entries(raw.pairings || {})) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !pairing || typeof pairing.userId !== 'string' ||
        !Number.isFinite(pairing.expiresAtMs)) return `pairing ${hash} is invalid`;
  }
  return true;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function pairingHash(code) {
  return crypto.createHash('sha256').update(String(code || '').replace(/\D/g, '')).digest('hex');
}

function publicConnection(connection) {
  if (!connection) return null;
  const { tokenHash: _tokenHash, ...publicValue } = connection;
  return publicValue;
}

function createCalibreAccessStore({
  filePath,
  jsonStore,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  randomInt = crypto.randomInt,
  isUserActive = async () => true
}) {
  if (!filePath || !jsonStore) throw new TypeError('Calibre access store requires filePath and jsonStore');
  const persistence = typeof jsonStore.createCriticalStore === 'function'
    ? jsonStore.createCriticalStore({
        filePath,
        defaultValue: {},
        validate: validateCalibreAccessStore,
        maxBackups: 5
      })
    : {
        load: () => jsonStore.load(filePath, {}),
        update: mutator => jsonStore.update(filePath, mutator, {})
      };

  function prune(store, nowMs) {
    for (const [hash, pairing] of Object.entries(store.pairings)) {
      if (!pairing || pairing.expiresAtMs <= nowMs) delete store.pairings[hash];
    }
  }

  async function issuePairingCode({ userId }) {
    const safeUserId = cleanText(userId, 64) || 'default';
    const nowMs = now();
    let code;
    await persistence.update(data => {
      const store = normalizeAccessStore(data);
      prune(store, nowMs);
      // Every extra live code linearly multiplies a guesser's hit probability,
      // and the UI only ever shows the newest one. Retire this user's older
      // pairings rather than leaving them claimable for their full TTL.
      for (const [hash, pairing] of Object.entries(store.pairings)) {
        if (pairing?.userId === safeUserId) delete store.pairings[hash];
      }
      // Issuing a fresh code is the operator-driven reset for the budget.
      store.failedClaims = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
        if (!store.pairings[pairingHash(candidate)]) {
          code = candidate;
          break;
        }
      }
      if (!code) throw new Error('Could not allocate a Calibre pairing code');
      store.pairings[pairingHash(code)] = {
        userId: safeUserId,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + PAIRING_TTL_MS).toISOString(),
        expiresAtMs: nowMs + PAIRING_TTL_MS
      };
    });
    return { code, expiresInSeconds: Math.floor(PAIRING_TTL_MS / 1000) };
  }

  async function claimPairingCode(code, { clientName = 'Calibre' } = {}) {
    const normalizedCode = String(code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(normalizedCode)) return null;
    const nowMs = now();
    const token = `xcal_${randomBytes(32).toString('base64url')}`;
    let claimed = null;
    await persistence.update(data => {
      const store = normalizeAccessStore(data);
      prune(store, nowMs);
      const hash = pairingHash(normalizedCode);
      const pairing = store.pairings[hash];
      if (!pairing || pairing.expiresAtMs <= nowMs) {
        // A wrong guess must cost the attacker something. It cannot be charged
        // to a specific code -- the guesser never names one -- so the budget is
        // counted across the instance and spends the live pairings when it runs
        // out. Only failures against a well-formed code are counted.
        store.failedClaims = (store.failedClaims || 0) + 1;
        if (store.failedClaims >= MAX_FAILED_CLAIMS) {
          for (const key of Object.keys(store.pairings)) delete store.pairings[key];
        }
        return;
      }
      const existingForUser = Object.values(store.connections).filter(item => item.userId === pairing.userId);
      if (existingForUser.length >= MAX_CONNECTIONS_PER_USER) {
        throw new Error('Too many Calibre connections; revoke an old connection first');
      }
      const id = `cal_${randomBytes(12).toString('hex')}`;
      const connection = {
        id,
        userId: pairing.userId,
        clientName: cleanText(clientName, 80) || 'Calibre',
        tokenHash: tokenHash(token),
        createdAt: new Date(nowMs).toISOString(),
        lastUsedAt: new Date(nowMs).toISOString()
      };
      store.connections[id] = connection;
      delete store.pairings[hash];
      claimed = publicConnection(connection);
    });
    return claimed ? { token, connection: claimed } : null;
  }

  async function resolveToken(token) {
    if (typeof token !== 'string' || !token.startsWith('xcal_')) return null;
    const hash = tokenHash(token);
    const loaded = normalizeAccessStore(await persistence.load());
    const loadedConnection = Object.values(loaded.connections).find(item => item.tokenHash === hash);
    if (!loadedConnection || !await isUserActive(loadedConnection.userId)) return null;
    let resolved = null;
    await persistence.update(data => {
      const store = normalizeAccessStore(data);
      const connection = Object.values(store.connections).find(item => item.tokenHash === hash);
      if (!connection) return;
      connection.lastUsedAt = new Date(now()).toISOString();
      resolved = publicConnection(connection);
    });
    return resolved;
  }

  async function listConnections(userId) {
    const store = normalizeAccessStore(await persistence.load());
    return Object.values(store.connections)
      .filter(item => item.userId === userId)
      .map(publicConnection)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function revokeConnection(userId, id) {
    let revoked = false;
    await persistence.update(data => {
      const store = normalizeAccessStore(data);
      const connection = store.connections[id];
      if (!connection || connection.userId !== userId) return;
      delete store.connections[id];
      revoked = true;
    });
    return revoked;
  }

  return { issuePairingCode, claimPairingCode, resolveToken, listConnections, revokeConnection };
}

module.exports = {
  MAX_CONNECTIONS_PER_USER,
  PAIRING_TTL_MS,
  createCalibreAccessStore,
  normalizeAccessStore,
  sanitizeCalibreMetadata,
  stableCalibreBookId,
  validateCalibreAccessStore
};
