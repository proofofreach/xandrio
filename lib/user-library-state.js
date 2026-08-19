const crypto = require('crypto');

const DEFAULT_USER_ID = 'default';

// An offline device may sync a genuinely old position; nothing legitimate is
// more than a year stale, and nothing legitimate is ahead of the server by
// more than a few minutes of clock drift.
const POSITION_TIMESTAMP_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const POSITION_TIMESTAMP_MAX_SKEW_MS = 5 * 60 * 1000;
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

// Matches MAX_CONNECTIONS_PER_USER in lib/calibre-integration.js. Without a
// cap, upsertDevice() appends one permanent record per distinct device id an
// account has ever presented, and the id is client-suppliable, so this was an
// unbounded, unauthenticated growth path for the shared users.json file.
const MAX_DEVICES_PER_USER = 20;

// Identifiers that reach a plain-object property lookup, e.g. store.users[id].
// The character class below permits leading underscores, so '__proto__' passed
// validation; `if (!users[id]) users[id] = {}` then read Object.prototype
// (truthy), skipped the guard, and wrote through the prototype chain, leaking
// attacker data into every object in the process that lacked its own key.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafeObjectKey(value) {
  return UNSAFE_OBJECT_KEYS.has(String(value).toLowerCase());
}

function createUserLibraryState(options = {}) {
  const clock = options.now || Date.now;
  const cryptoApi = options.crypto || crypto;
  const pairingCodeTtlMs = options.pairingCodeTtlMs || PAIRING_CODE_TTL_MS;

  function sanitizeSyncId(value, fallback = '') {
    const id = String(value || '').trim();
    if (isUnsafeObjectKey(id)) return fallback;
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : fallback;
  }

  function userIdFromRequest(req) {
    // An authenticated account session is the identity; clients cannot
    // override it. The self-asserted header/query/body path survives only
    // for trusted-LAN mode and the admin-equivalent shared-token Bearer
    // credential (req.user.id is null there), where it preserves the
    // historical sync-profile behavior.
    if (req.user?.id) return sanitizeSyncId(req.user.id, DEFAULT_USER_ID);
    const raw = req.headers['x-xandrio-user-id'] || req.query?.userId || req.body?.userId || DEFAULT_USER_ID;
    return sanitizeSyncId(raw, DEFAULT_USER_ID);
  }

  function clientAddress(req) {
    return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  }

  function deviceIdFromRequest(req) {
    const raw = req.headers['x-xandrio-device-id'] || req.body?.deviceId || req.query.deviceId;
    const sanitized = sanitizeSyncId(raw, '');
    if (sanitized) return sanitized;
    // A client that sends no device id still needs a *stable* id: this value
    // is used as a de-duplication and capacity key downstream (playback
    // look-ahead prefetch sessions, push-notification owner buckets), not
    // just a display label. Minting a fresh random id per call turned every
    // one of those into a permanent, unretireable entry (see
    // playback-runway-prefetch-session-key-random-per-request.md). Derive the
    // fallback from the caller's real identity instead, so repeat requests
    // from the same caller collapse onto the same id. Hash it so the result
    // still satisfies sanitizeSyncId's charset regardless of what an IP
    // address or account id looks like.
    const identity = req.user?.id || clientAddress(req);
    const digest = cryptoApi.createHash('sha256').update(String(identity)).digest('hex').slice(0, 16);
    return `anon_${digest}`;
  }

  function syncDisplayName(value, fallback, maxLength = 80) {
    return String(value || fallback || '').replace(/\s+/g, ' ').trim().slice(0, maxLength) || fallback;
  }

  function newUserId() {
    return `usr_${cryptoApi.randomBytes(12).toString('hex')}`;
  }

  function normalizeUsersStore(raw) {
    const store = raw && typeof raw === 'object' ? raw : {};
    if (!store.users || typeof store.users !== 'object') store.users = {};
    return store;
  }

  function upsertDevice(user, deviceId, deviceName) {
    if (!user.devices || typeof user.devices !== 'object') user.devices = {};
    const now = new Date(clock()).toISOString();
    const existing = user.devices[deviceId] || {};
    if (!user.devices[deviceId]) {
      const entries = Object.entries(user.devices);
      if (entries.length >= MAX_DEVICES_PER_USER) {
        // Evict the least-recently-seen devices to make room for the new
        // one, oldest first, so a caller that keeps presenting new ids can't
        // grow this map without bound.
        entries.sort((a, b) => String(a[1]?.lastSeenAt || '').localeCompare(String(b[1]?.lastSeenAt || '')));
        const toEvict = entries.length - MAX_DEVICES_PER_USER + 1;
        for (let index = 0; index < toEvict; index += 1) delete user.devices[entries[index][0]];
      }
    }
    user.devices[deviceId] = {
      id: deviceId,
      name: syncDisplayName(deviceName, existing.name || 'This device', 60),
      createdAt: existing.createdAt || now,
      lastSeenAt: now
    };
    user.updatedAt = now;
    return user.devices[deviceId];
  }

  function publicProfile(user, deviceId = null) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deviceId,
      devices: Object.values(user.devices || {}).map(device => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt
      }))
    };
  }

  function normalizePairingCode(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 6);
  }

  function hashPairingCode(code) {
    return cryptoApi.createHash('sha256').update(String(code)).digest('hex');
  }

  function createPairingCode() {
    return String(cryptoApi.randomInt(0, 1000000)).padStart(6, '0');
  }

  function prunePairingCodes(pairings, now = clock()) {
    pairings.codes = (pairings.codes || []).filter(entry => entry.expiresAtMs > now && !entry.usedAt);
    return pairings;
  }

  function issuePairingCode(pairings, userId) {
    const now = clock();
    const code = createPairingCode();
    prunePairingCodes(pairings, now);
    pairings.codes.push({
      codeHash: hashPairingCode(code),
      userId,
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      expiresAt: new Date(now + pairingCodeTtlMs).toISOString(),
      expiresAtMs: now + pairingCodeTtlMs
    });
    return { code, expiresInSeconds: Math.floor(pairingCodeTtlMs / 1000) };
  }

  function findPairingClaim(pairings, value) {
    const code = normalizePairingCode(value);
    if (code.length !== 6) return null;
    const now = clock();
    const entry = (pairings.codes || []).find(item =>
      item.codeHash === hashPairingCode(code) && !item.usedAt && item.expiresAtMs > now
    );
    if (!entry) {
      prunePairingCodes(pairings, now);
      return null;
    }
    return entry;
  }

  function consumePairingClaim(entry) {
    const now = clock();
    entry.usedAt = new Date(now).toISOString();
    entry.usedAtMs = now;
    return entry;
  }

  function normalizePositionsStore(raw) {
    // Normalizes in place so updateJSON callers continue writing the same
    // object they received from their persistence adapter.
    const store = raw && typeof raw === 'object' ? raw : {};
    if (store.users && typeof store.users === 'object') return store;
    const legacy = { ...store };
    Object.keys(store).forEach(key => delete store[key]);
    store.users = { [DEFAULT_USER_ID]: legacy };
    return store;
  }

  function removeBookPositions(rawPositions, bookId) {
    const positions = normalizePositionsStore(rawPositions);
    Object.values(positions.users || {}).forEach(userPositions => {
      if (userPositions && typeof userPositions === 'object') delete userPositions[bookId];
    });
    return positions;
  }

  function setBookPositionsStructureKey(rawPositions, bookId, chapterStructureKey) {
    const positions = normalizePositionsStore(rawPositions);
    Object.values(positions.users || {}).forEach(userPositions => {
      const position = userPositions?.[bookId];
      if (position && typeof position === 'object') position.chapterStructureKey = chapterStructureKey;
    });
    return positions;
  }

  // Shallow-merges one user's entry into another's in any {users: {...}}
  // store (bookmarks, client settings, shelves); existing target keys win,
  // mirroring migratePositions semantics.
  function migrateUserScopedStore(rawStore, fromUserId, toUserId) {
    const store = rawStore && typeof rawStore === 'object' ? rawStore : {};
    if (!store.users || typeof store.users !== 'object') store.users = {};
    if (fromUserId === toUserId) return store;
    const source = store.users[fromUserId];
    if (!source || typeof source !== 'object') return store;
    store.users[toUserId] = { ...source, ...(store.users[toUserId] || {}) };
    return store;
  }

  function migratePositions(rawPositions, fromUserId, toUserId) {
    const positions = normalizePositionsStore(rawPositions);
    const source = positions.users[fromUserId] || {};
    if (!positions.users[toUserId]) positions.users[toUserId] = {};
    positions.users[toUserId] = { ...source, ...positions.users[toUserId] };
    return positions;
  }

  function positionsForUser(rawPositions, userId) {
    const positions = normalizePositionsStore(rawPositions);
    return positions.users?.[userId] || {};
  }

  function positionForBook(rawPositions, userId, bookId) {
    return positionsForUser(rawPositions, userId)[bookId] || null;
  }

  function positionsForBooks(rawPositions, userId, bookIds) {
    const userPositions = positionsForUser(rawPositions, userId);
    return Object.fromEntries(bookIds.map(bookId => [bookId, userPositions[bookId] || null]));
  }

  function comparePositions(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    if ((a.chapterIndex || 0) !== (b.chapterIndex || 0)) return (a.chapterIndex || 0) - (b.chapterIndex || 0);
    return (a.timestamp || 0) - (b.timestamp || 0);
  }

  function recordPosition(rawPositions, input) {
    const positions = normalizePositionsStore(rawPositions);
    const userId = input.userId;
    const bookId = input.bookId;
    if (!positions.users[userId]) positions.users[userId] = {};
    const existing = positions.users[userId][bookId] || null;
    // The client supplies updatedAtMs and it is the sole conflict-resolution
    // key, so an unbounded value is a permanent denial of service: one request
    // carrying a timestamp far in the future makes every later real update
    // compare as "older" and be discarded, freezing that book's position for
    // good. Values past the Date range would also throw on toISOString()
    // below. Accept only a plausible clock -- a generous backward window for
    // offline devices syncing late, and a small forward skew.
    const suppliedUpdatedAtMs = Number(input.updatedAtMs);
    const nowMs = clock();
    const hasSuppliedUpdatedAt = Number.isFinite(suppliedUpdatedAtMs)
      && suppliedUpdatedAtMs > nowMs - POSITION_TIMESTAMP_MAX_AGE_MS
      && suppliedUpdatedAtMs < nowMs + POSITION_TIMESTAMP_MAX_SKEW_MS;
    // Keep the historical route behavior: an absent client timestamp reads
    // the clock independently for the ISO field and numeric conflict field.
    const updatedAt = hasSuppliedUpdatedAt ? suppliedUpdatedAtMs : clock();
    const updatedAtMs = hasSuppliedUpdatedAt ? suppliedUpdatedAtMs : clock();
    const candidate = {
      userId,
      bookId,
      chapterIndex: input.chapterIndex,
      timestamp: input.timestamp,
      chunkIndex: input.chunkIndex ?? undefined,
      chunkTime: input.chunkTime ?? undefined,
      characterOffset: Number.isInteger(input.characterOffset) ? input.characterOffset : undefined,
      positionApproximate: input.positionApproximate === true || undefined,
      chapterStructureKey: input.chapterStructureKey || undefined,
      playbackRate: Number.isFinite(Number(input.playbackRate)) ? Number(input.playbackRate) : undefined,
      wasPlaying: Boolean(input.wasPlaying),
      finished: input.finished === true || (Boolean(existing?.finished) && !input.allowBackward),
      updatedAt: new Date(updatedAt).toISOString(),
      updatedAtMs
    };

    const isOlder = existing && existing.updatedAtMs && candidate.updatedAtMs < existing.updatedAtMs;
    const movesBackward = existing && comparePositions(candidate, existing) < -1;
    if (!input.allowBackward && (isOlder || movesBackward)) {
      return { success: true, ignored: true, position: existing };
    }

    positions.users[userId][bookId] = candidate;
    return { success: true, position: candidate };
  }

  return {
    DEFAULT_USER_ID,
    PAIRING_CODE_TTL_MS: pairingCodeTtlMs,
    sanitizeSyncId,
    userIdFromRequest,
    deviceIdFromRequest,
    syncDisplayName,
    newUserId,
    normalizeUsersStore,
    upsertDevice,
    publicProfile,
    normalizePairingCode,
    hashPairingCode,
    createPairingCode,
    prunePairingCodes,
    issuePairingCode,
    findPairingClaim,
    consumePairingClaim,
    normalizePositionsStore,
    removeBookPositions,
    setBookPositionsStructureKey,
    migrateUserScopedStore,
    migratePositions,
    positionsForUser,
    positionForBook,
    positionsForBooks,
    comparePositions,
    recordPosition
  };
}

module.exports = { createUserLibraryState };
