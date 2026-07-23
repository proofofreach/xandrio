const crypto = require('crypto');

const DEFAULT_USER_ID = 'default';
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

function createUserLibraryState(options = {}) {
  const clock = options.now || Date.now;
  const cryptoApi = options.crypto || crypto;
  const pairingCodeTtlMs = options.pairingCodeTtlMs || PAIRING_CODE_TTL_MS;

  function sanitizeSyncId(value, fallback = '') {
    const id = String(value || '').trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : fallback;
  }

  function userIdFromRequest(req) {
    const raw = req.headers['x-xandrio-user-id'] || req.query.userId || req.body?.userId || DEFAULT_USER_ID;
    return sanitizeSyncId(raw, DEFAULT_USER_ID);
  }

  function deviceIdFromRequest(req) {
    const raw = req.headers['x-xandrio-device-id'] || req.body?.deviceId || req.query.deviceId;
    return sanitizeSyncId(raw, `dev_${cryptoApi.randomBytes(8).toString('hex')}`);
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
    const suppliedUpdatedAtMs = Number(input.updatedAtMs);
    const hasSuppliedUpdatedAt = Number.isFinite(suppliedUpdatedAtMs);
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
    migratePositions,
    positionsForUser,
    positionForBook,
    positionsForBooks,
    comparePositions,
    recordPosition
  };
}

module.exports = { createUserLibraryState };
