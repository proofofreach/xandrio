// Irreplaceable per-user and operator stores. Each is registered as a
// json-store critical store, so a corrupt file, a file of the wrong shape, or
// a file missing after it once held data makes reads and writes throw instead
// of resetting to defaults and then overwriting the evidence.
//
// Validators check structure only. The module normalizers (lib/shelves.js,
// lib/user-library-state.js, lib/listening-queue.js, ...) still repair
// details; a validator rejects only what no normalizer could have read as
// data, and accepts every legacy shape those normalizers accept.

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function topLevelObject(raw) {
  return isPlainObject(raw) ? true : 'top level must be an object';
}

// { users: { <userId>: {...} } }. Legacy single-user files without `users`
// are still objects keyed by book id; normalizers migrate them in place.
function validateUsersKeyedStore(raw) {
  const top = topLevelObject(raw);
  if (top !== true) return top;
  if (raw.users !== undefined && !isPlainObject(raw.users)) return 'users must be an object';
  return true;
}

function validateSettingsStore(raw) {
  return topLevelObject(raw);
}

function validatePronunciationsStore(raw) {
  const top = topLevelObject(raw);
  if (top !== true) return top;
  if (raw.global !== undefined && !Array.isArray(raw.global)) return 'global must be an array';
  if (raw.books !== undefined && !isPlainObject(raw.books)) return 'books must be an object';
  return true;
}

function validateBookDeletionsStore(raw) {
  const top = topLevelObject(raw);
  if (top !== true) return top;
  if (raw.revision !== undefined) {
    const revision = Number(raw.revision);
    if (!Number.isFinite(revision) || revision < 0) return 'revision must be a non-negative number';
  }
  if (raw.pending !== undefined && !isPlainObject(raw.pending)) return 'pending must be an object';
  if (raw.deletions !== undefined && !isPlainObject(raw.deletions)) return 'deletions must be an object';
  return true;
}

// custom-voices.json: { voices: [{ id, name, ... }] }. Cloned voices are
// user uploads; a reset would orphan every reference clip and book pin.
function validateCustomVoicesStore(raw) {
  const top = topLevelObject(raw);
  if (top !== true) return top;
  if (raw.voices !== undefined && !Array.isArray(raw.voices)) return 'voices must be an array';
  return true;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// files: { positions, shelves, bookmarks, listeningQueues, users,
// clientSettings, settings, pronunciations, bookDeletions, customVoices } -> absolute paths.
function userDataStoreDefinitions(files) {
  return [
    // Position sync writes every few seconds per listener; back up at most
    // every five minutes so a sync storm does not double the disk I/O.
    { filePath: files.positions, validate: validateUsersKeyedStore, minBackupIntervalMs: FIVE_MINUTES_MS },
    { filePath: files.shelves, validate: validateUsersKeyedStore },
    { filePath: files.bookmarks, validate: validateUsersKeyedStore },
    { filePath: files.listeningQueues, validate: validateUsersKeyedStore, minBackupIntervalMs: FIVE_MINUTES_MS },
    { filePath: files.users, validate: validateUsersKeyedStore },
    { filePath: files.clientSettings, validate: validateUsersKeyedStore, minBackupIntervalMs: FIVE_MINUTES_MS },
    { filePath: files.settings, validate: validateSettingsStore },
    { filePath: files.pronunciations, validate: validatePronunciationsStore },
    { filePath: files.bookDeletions, validate: validateBookDeletionsStore },
    { filePath: files.customVoices, validate: validateCustomVoicesStore }
  ].filter(definition => definition.filePath);
}

function registerUserDataStores({ jsonStore, files, maxBackups = 5 }) {
  return userDataStoreDefinitions(files).map(definition => jsonStore.registerCriticalStore({
    defaultValue: {},
    maxBackups,
    ...definition
  }));
}

module.exports = {
  registerUserDataStores,
  userDataStoreDefinitions,
  validateBookDeletionsStore,
  validatePronunciationsStore,
  validateSettingsStore,
  validateUsersKeyedStore
};
