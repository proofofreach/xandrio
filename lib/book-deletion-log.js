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
  // Transactions begun by this process and not yet committed or aborted.
  // Reconciliation exists to settle transactions a crash interrupted; a live
  // one belongs to its deletion, which is still deciding the outcome.
  const inFlight = new Map();

  async function begin(bookId) {
    const token = createToken();
    inFlight.set(token, String(bookId));
    try {
      await updateJSON(filePath, (raw) => {
        const log = normalizeLog(raw);
        log.pending[token] = {
          bookId: String(bookId),
          requestedAt: now()
        };
      }, emptyLog());
    } catch (error) {
      inFlight.delete(token);
      throw error;
    }
    return token;
  }

  async function commit(token) {
    try {
      return await updateJSON(filePath, (raw) => {
        const log = normalizeLog(raw);
        const pending = log.pending[token];
        // The book is already gone when commit runs, so record the deletion even
        // if the pending entry was lost; only an unknown token is a no-op.
        const bookId = pending?.bookId || inFlight.get(token);
        if (!bookId) return SKIP_SAVE;
        const revision = ++log.revision;
        log.deletions[bookId] = {
          bookId,
          revision,
          deletedAt: pending?.requestedAt || now()
        };
        delete log.pending[token];
        return true;
      }, emptyLog());
    } finally {
      // A failed commit leaves the pending entry for reconciliation to settle.
      inFlight.delete(token);
    }
  }

  async function abort(token) {
    try {
      return await updateJSON(filePath, (raw) => {
        const log = normalizeLog(raw);
        if (!log.pending[token]) return SKIP_SAVE;
        delete log.pending[token];
        return true;
      }, emptyLog());
    } finally {
      inFlight.delete(token);
    }
  }

  async function reconcile(books = {}) {
    return updateJSON(filePath, (raw) => {
      const log = normalizeLog(raw);
      let changed = false;
      for (const [token, pending] of Object.entries(log.pending)) {
        if (inFlight.has(token)) continue;
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

  // A deletion is superseded when the catalog holds a record of the same id
  // imported after it. Both stamps come from the server clock, so clients need
  // not compare a server deletion time with their own download times. The
  // cursor still advances past a superseded entry; a later deletion gets a new
  // revision. A record without an import time cannot be ordered, so its
  // deletion is kept.
  function supersededBy(books, item) {
    const book = books?.[item.bookId];
    if (!book) return false;
    const addedAt = Date.parse(book.addedAt);
    const deletedAt = Date.parse(item.deletedAt);
    return Number.isFinite(addedAt) && Number.isFinite(deletedAt) && addedAt > deletedAt;
  }

  async function listSince(since = 0, { books = null } = {}) {
    const cursor = Math.max(0, Number(since) || 0);
    const log = normalizeLog(await loadJSON(filePath, emptyLog()));
    const deletions = Object.values(log.deletions)
      .filter(item => Number(item?.revision) > cursor)
      .filter(item => !supersededBy(books, item))
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
