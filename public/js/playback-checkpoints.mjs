// Device-local playback checkpoints, partitioned by account.
//
// A checkpoint is compared with the server position when a book opens, and a
// newer one is force-saved back to the server. An unpartitioned checkpoint
// would therefore let one account's progress overwrite another account's on
// a shared device. Every read and write here takes the storage scope
// explicitly (api.js getOfflineStorageScopeId), and a record must name that
// scope to be returned.

const SCOPED_PREFIX = 'xandrio_account_checkpoint:';
// Builds before account scoping wrote one unattributed key per book.
const LEGACY_PREFIX = 'xandrio_playback_checkpoint:';
const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Keys other modules partition by the same scope. Any of them naming another
// scope proves a second account has used this device.
const SCOPED_EVIDENCE_PREFIXES = [
  SCOPED_PREFIX,
  'xandrio_offline_books:',
  'xandrio_pending_positions:'
];
const LEGACY_PENDING_POSITIONS_KEY = 'xandrio_pending_positions';
const LEGACY_CACHE_OWNER_KEY = 'xandrio_offline_legacy_cache_owner';

function storage() {
  return globalThis.localStorage || null;
}

function validScope(scopeId) {
  const scope = String(scopeId || '');
  return LOCAL_ID_PATTERN.test(scope) ? scope : null;
}

function parse(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function storageKeys() {
  const store = storage();
  if (!store) return [];
  const keys = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key != null) keys.push(key);
  }
  return keys;
}

export function playbackCheckpointKey(scopeId, bookId) {
  const scope = validScope(scopeId);
  return scope && bookId ? `${SCOPED_PREFIX}${scope}:${bookId}` : null;
}

function legacyCheckpointKey(bookId) {
  return bookId ? `${LEGACY_PREFIX}${bookId}` : null;
}

// Old checkpoints carry no owner. They are adopted only while nothing on the
// device shows a second account; otherwise their owner is unknowable.
export function deviceHasOtherScope(scope) {
  for (const key of storageKeys()) {
    for (const prefix of SCOPED_EVIDENCE_PREFIXES) {
      if (!key.startsWith(prefix)) continue;
      const owner = key.slice(prefix.length).split(':')[0];
      if (owner && owner !== scope) return true;
    }
  }
  const owner = storage()?.getItem(LEGACY_CACHE_OWNER_KEY);
  if (owner && owner !== scope) return true;
  const legacyPending = parse(LEGACY_PENDING_POSITIONS_KEY);
  return Array.isArray(legacyPending) &&
    legacyPending.some(position => position?.userId && String(position.userId) !== scope);
}

function withoutOwner(record) {
  const { userId, ...checkpoint } = record;
  return checkpoint;
}

function claimLegacyCheckpoint(scope, bookId) {
  const legacyKey = legacyCheckpointKey(bookId);
  const legacy = parse(legacyKey);
  if (!legacy) return null;
  if (legacy.bookId !== bookId || deviceHasOtherScope(scope)) {
    storage()?.removeItem(legacyKey);
    return null;
  }
  if (!writePlaybackCheckpoint(scope, legacy)) return null;
  storage()?.removeItem(legacyKey);
  return withoutOwner(legacy);
}

/**
 * The checkpoint this scope saved for bookId, or null. `claimLegacy` lets the
 * caller adopt a pre-scoping checkpoint once the account is settled
 * (api.js canClaimLegacyOfflineStorage).
 */
export function readPlaybackCheckpoint(scopeId, bookId, { claimLegacy = false } = {}) {
  const scope = validScope(scopeId);
  const key = playbackCheckpointKey(scope, bookId);
  if (!key) return null;
  const record = parse(key);
  if (record && typeof record === 'object') {
    if (record.bookId === bookId && record.userId === scope) return withoutOwner(record);
    storage()?.removeItem(key);
    return null;
  }
  return claimLegacy ? claimLegacyCheckpoint(scope, bookId) : null;
}

export function writePlaybackCheckpoint(scopeId, checkpoint) {
  const scope = validScope(scopeId);
  const key = playbackCheckpointKey(scope, checkpoint?.bookId);
  if (!key) return false;
  try {
    storage()?.setItem(key, JSON.stringify({ ...checkpoint, userId: scope }));
    return true;
  } catch {
    return false;
  }
}

export function removePlaybackCheckpoint(scopeId, bookId) {
  const key = playbackCheckpointKey(scopeId, bookId);
  if (key) storage()?.removeItem(key);
  const legacyKey = legacyCheckpointKey(bookId);
  if (legacyKey) storage()?.removeItem(legacyKey);
}

/**
 * Sign-out cleanup: the account's own checkpoints, and every unattributed
 * legacy checkpoint, which the next account to sign in could otherwise adopt.
 */
export function clearPlaybackCheckpoints(scopeId) {
  const scope = validScope(scopeId);
  const scopedPrefix = scope ? `${SCOPED_PREFIX}${scope}:` : null;
  for (const key of storageKeys()) {
    if ((scopedPrefix && key.startsWith(scopedPrefix)) || key.startsWith(LEGACY_PREFIX)) {
      storage()?.removeItem(key);
    }
  }
}
