const crypto = require('crypto');
const { SKIP_SAVE } = require('./json-store');

const LOG_VERSION = 1;

function emptyLog() {
  return {
    version: LOG_VERSION,
    revision: 0,
    pending: {},
    deletions: {}
  };
}

function normalizeLog(value) {
  const fallback = emptyLog();
  if (!value || typeof value !== 'object') return fallback;
  value.version = LOG_VERSION;
  value.revision = Math.max(0, Number(value.revision) || 0);
  if (!value.pending || typeof value.pending !== 'object') value.pending = {};
  if (!value.deletions || typeof value.deletions !== 'object') value.deletions = {};
  return value;
}

function createBookDeletionLog({
  filePath,
  loadJSON,
  updateJSON,
  now = () => new Date().toISOString(),
  createToken = () => crypto.randomUUID()
}) {
  async function begin(bookId) {
    const token = createToken();
    await updateJSON(filePath, (raw) => {
      const log = normalizeLog(raw);
      log.pending[token] = {
        bookId: String(bookId),
        requestedAt: now()
      };
    }, emptyLog());
    return token;
  }

  async function commit(token) {
    return updateJSON(filePath, (raw) => {
      const log = normalizeLog(raw);
      const pending = log.pending[token];
      if (!pending) return SKIP_SAVE;
      const revision = ++log.revision;
      log.deletions[pending.bookId] = {
        bookId: pending.bookId,
        revision,
        deletedAt: pending.requestedAt || now()
      };
      delete log.pending[token];
      return true;
    }, emptyLog());
  }

  async function abort(token) {
    return updateJSON(filePath, (raw) => {
      const log = normalizeLog(raw);
      if (!log.pending[token]) return SKIP_SAVE;
      delete log.pending[token];
      return true;
    }, emptyLog());
  }

  async function reconcile(books = {}) {
    return updateJSON(filePath, (raw) => {
      const log = normalizeLog(raw);
      let changed = false;
      for (const [token, pending] of Object.entries(log.pending)) {
        if (books[pending.bookId]) {
          delete log.pending[token];
          changed = true;
          continue;
        }
        const revision = ++log.revision;
        log.deletions[pending.bookId] = {
          bookId: pending.bookId,
          revision,
          deletedAt: pending.requestedAt || now()
        };
        delete log.pending[token];
        changed = true;
      }
      return changed ? true : SKIP_SAVE;
    }, emptyLog());
  }

  async function listSince(since = 0) {
    const cursor = Math.max(0, Number(since) || 0);
    const log = normalizeLog(await loadJSON(filePath, emptyLog()));
    const deletions = Object.values(log.deletions)
      .filter(item => Number(item?.revision) > cursor)
      .sort((a, b) => a.revision - b.revision)
      .map(item => ({
        bookId: item.bookId,
        revision: item.revision,
        deletedAt: item.deletedAt
      }));
    return { revision: log.revision, deletions };
  }

  return { begin, commit, abort, reconcile, listSince };
}

module.exports = { createBookDeletionLog };
