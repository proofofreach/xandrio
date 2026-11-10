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

// Missing or corrupt book-deletions.json fails closed in json-store (it is a
// registered critical store), so normalizeLog only fills absent fields.
function normalizeLog(value) {
  const fallback = emptyLog();
  if (!value || typeof value !== 'object') return fallback;
  value.version = LOG_VERSION;
  value.revision = Math.max(0, Number(value.revision) || 0);
  if (!value.pending || typeof value.pending !== 'object') value.pending = {};
  if (!value.deletions || typeof value.deletions !== 'object') value.deletions = {};
  return value;
}

// The feed's lineage. A log created afresh (a new or wiped DATA_DIR) gets a
// new epoch, so a client whose cursor came from the old log rereads from 0
// even after the new log's revision has passed that cursor. A restore keeps
// the epoch; the revision floor and the client's `revision < cursor` check
// cover that case.
function ensureEpoch(log) {
  if (typeof log.epoch !== 'string' || !log.epoch) log.epoch = crypto.randomUUID();
  return log;
}

function floorRevision(value) {
  return Math.max(0, Number(value?.revision) || 0);
}

// Revisions are sync cursors: a client that has seen revision N asks only
// for later ones. Restoring an older book-deletions.json (operator recovery
// from a backup) would hand out N again for a new deletion, and clients past
// N would skip it. A sidecar high-water mark, written before each revision is
// used, keeps issued revisions strictly increasing across such restores.
// Limit: restoring the whole data directory, sidecar included, still rewinds;
// only a client-side guard can detect that.
function createBookDeletionLog({
  filePath,
  loadJSON,
  updateJSON,
  revisionFloorFile = filePath ? `${filePath}.revision-floor` : null,
  now = () => new Date().toISOString(),
  createToken = () => crypto.randomUUID()
}) {
  async function readFloor() {
    if (!revisionFloorFile) return 0;
    return floorRevision(await loadJSON(revisionFloorFile, { revision: 0 }));
  }

  // Called inside the log's lock, so allocations are serialized.
  async function allocateRevisions(log, count) {
    const start = Math.max(log.revision, await readFloor());
    const last = start + count;
    if (revisionFloorFile) {
      await updateJSON(revisionFloorFile, floor => {
        floor.revision = Math.max(floorRevision(floor), last);
      }, { revision: 0 });
    }
    log.revision = start;
    return () => ++log.revision;
  }

  // Transactions begun by this process and not yet committed or aborted.
  // Reconciliation exists to settle transactions a crash interrupted; a live
  // one belongs to its deletion, which is still deciding the outcome.
  const inFlight = new Map();

  async function begin(bookId) {
    const token = createToken();
    inFlight.set(token, String(bookId));
    try {
      await updateJSON(filePath, (raw) => {
        const log = ensureEpoch(normalizeLog(raw));
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
      return await updateJSON(filePath, async (raw) => {
        const log = ensureEpoch(normalizeLog(raw));
        const pending = log.pending[token];
        // The book is already gone when commit runs, so record the deletion even
        // if the pending entry was lost; only an unknown token is a no-op.
        const bookId = pending?.bookId || inFlight.get(token);
        if (!bookId) return SKIP_SAVE;
        const revision = (await allocateRevisions(log, 1))();
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
    return updateJSON(filePath, async (raw) => {
      const log = normalizeLog(raw);
      let changed = false;
      const settled = Object.entries(log.pending).filter(([token]) => !inFlight.has(token));
      const committing = settled.filter(([, pending]) => !books[pending.bookId]).length;
      const nextRevision = committing ? await allocateRevisions(log, committing) : null;
      for (const [token, pending] of settled) {
        if (books[pending.bookId]) {
          delete log.pending[token];
          changed = true;
          continue;
        }
        const revision = nextRevision();
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
    // Report the high-water mark so a restored, older log never moves a
    // client's cursor backwards.
    const revision = Math.max(log.revision, await readFloor());
    const deletions = Object.values(log.deletions)
      .filter(item => Number(item?.revision) > cursor)
      .filter(item => !supersededBy(books, item))
      .sort((a, b) => a.revision - b.revision)
      .map(item => ({
        bookId: item.bookId,
        revision: item.revision,
        deletedAt: item.deletedAt
      }));
    return log.epoch ? { revision, epoch: log.epoch, deletions } : { revision, deletions };
  }

  return { begin, commit, abort, reconcile, listSince };
}

module.exports = { createBookDeletionLog };
