const path = require('path');
const { BOOK_ARTIFACT_FIELDS, isManagedArtifactName } = require('./book-artifact-paths');

const DELETE_BOOK_RESULT = Object.freeze({
  DELETED: 'deleted',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found'
});

function createBookArtifactCleaner({
  cacheDir,
  fs,
  invalidateChapterCache,
  isBookDeleted,
  // Optional. The in-memory tombstone `isBookDeleted` consults can be evicted
  // (count cap) or stale (only some import paths clear it) well before a
  // deferred sweep fires. When provided, `bookStillExists` re-checks the
  // authoritative catalog immediately before a sweep runs, so a book that was
  // re-imported (or whose tombstone survived past a legitimate re-import)
  // does not have its fresh artifacts swept away.
  bookStillExists,
  // Optional. Serializes a deferred sweep with other mutations on the same
  // book id (e.g. a concurrent re-import), so the existence re-check above
  // cannot race an in-flight write.
  withSweepLock,
  onSweepsComplete = () => {},
  setTimer = setTimeout,
  log = console
}) {
  async function cleanup(bookId, book = {}) {
    const deleted = [];
    const failed = [];
    const paths = new Set();
    const cacheRoot = path.resolve(cacheDir);

    const addPath = (candidate) => {
      if (!candidate || typeof candidate !== 'string') return;
      const resolved = path.resolve(candidate);
      if (resolved === cacheRoot || !resolved.startsWith(`${cacheRoot}${path.sep}`)) return;
      paths.add(resolved);
    };

    addPath(book.path);
    addPath(book.sourcePath);
    addPath(book.retainedSourcePath);
    addPath(book.extractedArtifact);
    addPath(book.coverPath);

    const cacheFiles = await fs.readdir(cacheDir).catch(() => []);
    for (const file of cacheFiles) {
      // Ownership shares the anchored suffix grammar with book-artifact-paths.js
      // rather than re-testing a bare string prefix, so a book whose id is a
      // proper prefix of a sibling's id (e.g. "abc" vs "abc_2") cannot sweep
      // the sibling's artifacts.
      if (file === bookId || isManagedArtifactName(bookId, file)) {
        addPath(path.join(cacheDir, file));
      }
    }

    for (const target of paths) {
      try {
        await fs.rm(target, { force: true, recursive: true });
        deleted.push(target);
        invalidateChapterCache(target);
      } catch (error) {
        failed.push({ path: target, error: error.message });
      }
    }

    return { deleted, failed };
  }

  // `tombstone` identifies the deletion that scheduled these sweeps. It is
  // handed back to onSweepsComplete so a later deletion of the same id keeps
  // its own guard when this deletion's last sweep settles.
  function scheduleSweeps(bookId, book = {}, tombstone) {
    const delays = [2000, 10000, 30000];
    let remaining = delays.length;
    for (const delay of delays) {
      setTimer(() => {
        const runSweep = async () => {
          if (!isBookDeleted(bookId)) return;
          if (bookStillExists && await bookStillExists(bookId)) return;
          const result = await cleanup(bookId, book);
          if (result.deleted.length > 0 || result.failed.length > 0) {
            log.log(`Post-delete sweep for ${bookId}: removed ${result.deleted.length}, failed ${result.failed.length}`);
          }
        };
        const sweep = withSweepLock ? withSweepLock(bookId, runSweep) : runSweep();
        sweep.catch(error => log.error(`Post-delete sweep failed for ${bookId}:`, error))
          .finally(() => {
            remaining -= 1;
            if (remaining === 0) onSweepsComplete(bookId, tombstone);
          });
      }, delay);
    }
  }

  // Durable completion of artifact cleanup. A deletion commits its record
  // removal before it cancels jobs and removes files, so a crash or a failing
  // step in that window leaves files that no record reaches. This sweep
  // removes files whose owner (by the anchored deletion grammar) is a book id
  // the deletion log has committed and the catalog no longer holds.
  //
  // Safety rules, as for the import-claims sweep: nothing runs unless the
  // catalog is positively readable; a file any live record could own (by
  // grammar, by stored path or by basename) is never touched; each id is
  // re-checked against the catalog under its book lock immediately before
  // its files are removed.
  async function sweepDeletedBooks({ loadBooks, deletedBookIds }) {
    let books;
    try {
      books = await loadBooks();
    } catch (error) {
      log.warn?.(`Deleted-book artifact sweep skipped: catalog unavailable (${error.code || error.message})`);
      return { skipped: 'catalog-unavailable', removed: 0, failed: [] };
    }
    if (!books || typeof books !== 'object' || Array.isArray(books)) {
      log.warn?.('Deleted-book artifact sweep skipped: catalog is not a library object');
      return { skipped: 'catalog-unavailable', removed: 0, failed: [] };
    }
    const liveIds = new Set(Object.keys(books));
    const deleted = new Set([...(deletedBookIds || [])].map(String).filter(id => id && !liveIds.has(id)));
    if (deleted.size === 0) return { removed: 0, failed: [] };

    const liveNames = new Set();
    for (const book of Object.values(books)) {
      if (!book || typeof book !== 'object') continue;
      for (const field of BOOK_ARTIFACT_FIELDS) {
        if (typeof book[field] === 'string' && book[field]) liveNames.add(path.basename(book[field]));
      }
    }

    const cacheFiles = await fs.readdir(cacheDir).catch(() => []);
    const byBook = new Map();
    for (const file of cacheFiles) {
      if (liveNames.has(file)) continue;
      const owners = artifactOwnerCandidates(file);
      if (owners.some(id => liveIds.has(id) && (file === id || isManagedArtifactName(id, file)))) continue;
      const owner = owners.find(id => deleted.has(id) && (file === id || isManagedArtifactName(id, file)));
      if (!owner) continue;
      if (!byBook.has(owner)) byBook.set(owner, []);
      byBook.get(owner).push(path.join(cacheDir, file));
    }

    let removed = 0;
    const failed = [];
    for (const [bookId, targets] of byBook) {
      const run = async () => {
        if (bookStillExists && await bookStillExists(bookId)) return;
        for (const target of targets) {
          try {
            await fs.rm(target, { force: true, recursive: true });
            invalidateChapterCache(target);
            removed += 1;
          } catch (error) {
            failed.push({ path: target, error: error.message });
          }
        }
      };
      try {
        await (withSweepLock ? withSweepLock(bookId, run) : run());
      } catch (error) {
        failed.push({ bookId, error: error.message });
      }
    }
    return { removed, failed };
  }

  return { cleanup, scheduleSweeps, sweepDeletedBooks };
}

// Every id that could own `file` under the deletion grammar: the whole name and
// each prefix that ends before a `.` or `_` (the grammar's suffixes all start
// with one of the two). Checking prefixes keeps the sweep linear in the number
// of files instead of files x deleted ids.
function artifactOwnerCandidates(file) {
  const candidates = [file];
  for (let index = 1; index < file.length; index += 1) {
    if (file[index] === '.' || file[index] === '_') candidates.push(file.slice(0, index));
  }
  return candidates;
}

// A catalog that is positively readable. A missing books.json would otherwise
// read as an empty library, and an empty library makes every per-book entry
// look orphaned. A corrupt one throws from `load` itself.
async function loadCatalogStrict({ access, load, filePath }) {
  await access(filePath);
  const books = await load();
  if (!books || typeof books !== 'object' || Array.isArray(books)) {
    throw new Error('books.json is not a library object');
  }
  return books;
}

function createBookDeletionService({
  booksFile,
  positionsFile,
  bookmarksFile,
  shelvesFile,
  listeningQueueFile,
  updateJSON,
  skipSave,
  beginBookDeletion = async () => null,
  commitBookDeletion = async () => {},
  abortBookDeletion = async () => {},
  // Resolves true when the deletion log holds a committed deletion of this
  // id. A delete request for a book that is already gone then finishes the
  // cleanup an interrupted or failed deletion left, instead of answering
  // NOT_FOUND and leaving the leftovers forever.
  isDeletionCommitted = async () => false,
  rememberDeletedBookId,
  cancelBookJobs,
  stopPremiumPrep,
  cleanupBookArtifacts,
  scheduleArtifactSweeps,
  removeBookPositions,
  removeBookBookmarks,
  removeBookFromAllShelves,
  removeBookFromAllQueues,
  // Further per-book stores: { store, file, referenced(data) -> Set of book
  // ids, remove(data, bookId), defaultValue?, onSaved?(data) }. Deletion and
  // startup reconciliation both walk the same list, so a store added here can
  // never be cleaned by one and forgotten by the other.
  bookStateStores = [],
  log = console
}) {
  const stores = [
    { store: 'positions', file: positionsFile, referenced: referencedPositionBooks, remove: removeBookPositions },
    { store: 'bookmarks', file: bookmarksFile, referenced: referencedUserMapBooks, remove: removeBookBookmarks },
    { store: 'shelves', file: shelvesFile, referenced: referencedShelfBooks, remove: removeBookFromAllShelves }
  ];
  if (listeningQueueFile && removeBookFromAllQueues) {
    stores.push({ store: 'listeningQueues', file: listeningQueueFile, referenced: referencedQueueBooks, remove: removeBookFromAllQueues });
  }
  stores.push(...bookStateStores);

  async function updateStore({ file, defaultValue }, mutator, onSaved) {
    let saved = null;
    await updateJSON(file, data => {
      const result = mutator(data);
      if (result === skipSave) return skipSave;
      saved = data;
      return result;
    }, defaultValue);
    if (saved && onSaved) onSaved(saved);
  }

  async function deleteBook({ bookId, actor }) {
    const deletionToken = await beginBookDeletion(bookId);
    let forbidden = false;
    let removal;
    try {
      removal = await updateJSON(booksFile, (books) => {
        const book = books[bookId];
        if (!book) return skipSave;

        // Positive admin test: a missing or unknown role is not privileged.
        if (actor?.role !== 'admin' && !(actor?.id && book.addedBy === actor.id)) {
          forbidden = true;
          return skipSave;
        }

        delete books[bookId];
        return { book };
      });
    } catch (error) {
      await abortBookDeletion(deletionToken).catch(() => {});
      throw error;
    }

    if (forbidden) {
      await abortBookDeletion(deletionToken);
      return { status: DELETE_BOOK_RESULT.FORBIDDEN };
    }
    if (removal === skipSave) {
      await abortBookDeletion(deletionToken);
      // The record is gone. If a committed deletion removed it, finish that
      // deletion's cleanup; ownership was checked when it was committed, and
      // the steps below only touch state no live record refers to.
      if (!(await isDeletionCommitted(bookId))) return { status: DELETE_BOOK_RESULT.NOT_FOUND };
      return { ...(await finishDeletion(bookId, {})), resumed: true };
    }

    const { book } = removal;
    try {
      await commitBookDeletion(deletionToken);
    } catch (error) {
      // The pending transaction is intentionally retained. Reconciliation
      // publishes it once the deletion feed is next requested.
      log.warn(`Could not commit deletion tombstone for ${bookId}:`, error);
    }
    return finishDeletion(bookId, book);
  }

  // Every step runs even when an earlier one throws: a failing job cancel
  // must not leave files and per-book state behind. Leftovers are reported;
  // the deferred sweeps, a retried DELETE and the startup sweeps finish them.
  async function finishDeletion(bookId, book) {
    const cleanupErrors = [];
    const step = async (name, run, fallback) => {
      try {
        return await run();
      } catch (error) {
        cleanupErrors.push({ step: name, error: error.message });
        log.warn(`Book deletion step ${name} failed for ${bookId}:`, error);
        return fallback;
      }
    };
    const tombstone = rememberDeletedBookId(bookId);
    const cancelledJobs = await step('jobs', () => cancelBookJobs(bookId), 0);
    await step('premiumPrep', () => stopPremiumPrep(bookId));

    const artifactCleanup = await step('artifacts', () => cleanupBookArtifacts(bookId, book), { deleted: [], failed: [] });
    await step('sweeps', () => scheduleArtifactSweeps(bookId, book, tombstone));
    if (artifactCleanup.failed.length > 0) {
      log.warn(`Book deletion left ${artifactCleanup.failed.length} artifact(s):`, artifactCleanup.failed);
    }

    // Each library-state store is cleaned independently: one failing write
    // must not leave the later stores pointing at a book that no longer
    // exists. Failures are reported, and reconcileLibraryState() at the next
    // startup drops whatever was left behind.
    const libraryStateErrors = [];
    for (const entry of stores) {
      try {
        await updateStore(entry, data => { entry.remove(data, bookId); }, entry.onSaved);
      } catch (error) {
        libraryStateErrors.push({ store: entry.store, error: error.message });
        log.warn(`Book deletion could not clean ${entry.store} for ${bookId}:`, error);
      }
    }

    return {
      status: DELETE_BOOK_RESULT.DELETED,
      cancelledJobs,
      artifactCleanup,
      ...(libraryStateErrors.length ? { libraryStateErrors } : {}),
      ...(cleanupErrors.length ? { cleanupErrors } : {})
    };
  }

  // Startup repair for the fan-out above: drops per-book entries whose book
  // is no longer in the catalog. `loadBooks` must throw unless the catalog is
  // positively readable (see loadCatalogStrict): a missing or corrupt
  // books.json never empties the state of a library that still exists. A
  // readable, empty catalog is a real empty library, so its orphans go too.
  async function reconcileLibraryState({ loadBooks }) {
    let books;
    try {
      books = await loadBooks();
    } catch (error) {
      log.warn('Library-state reconcile skipped: catalog unavailable:', error.message);
      return { skipped: 'catalog-unavailable', removed: {} };
    }
    if (!books || typeof books !== 'object' || Array.isArray(books)) {
      log.warn('Library-state reconcile skipped: catalog is not a library object');
      return { skipped: 'catalog-unavailable', removed: {} };
    }
    const bookIds = new Set(Object.keys(books));
    const removed = {};
    for (const entry of stores) {
      try {
        await updateStore(entry, data => {
          const orphans = [...entry.referenced(data)].filter(bookId => !bookIds.has(bookId));
          if (orphans.length === 0) return skipSave;
          for (const bookId of orphans) entry.remove(data, bookId);
          removed[entry.store] = orphans.length;
        }, entry.onSaved);
      } catch (error) {
        log.warn(`Library-state reconcile failed for ${entry.store}:`, error);
      }
    }
    return { removed };
  }

  return { deleteBook, reconcileLibraryState };
}

// Book ids referenced by each store, in the shapes their own modules write:
// positions and bookmarks are { users: { [userId]: { [bookId]: ... } } },
// shelves are { users: { [userId]: { books: { [bookId]: ... } } } }, and
// listening queues are { users: { [userId]: { bookIds: [], bookSettings: {} } } }.
function userEntries(store) {
  const users = store && typeof store === 'object' && store.users && typeof store.users === 'object' ? store.users : {};
  return Object.values(users).filter(value => value && typeof value === 'object');
}

function referencedUserMapBooks(store) {
  const ids = new Set();
  for (const perUser of userEntries(store)) {
    for (const bookId of Object.keys(perUser)) ids.add(bookId);
  }
  return ids;
}

function referencedPositionBooks(store) {
  return referencedUserMapBooks(store);
}

function referencedShelfBooks(store) {
  const ids = new Set();
  for (const shelf of userEntries(store)) {
    if (shelf.books && typeof shelf.books === 'object') {
      for (const bookId of Object.keys(shelf.books)) ids.add(bookId);
    }
  }
  return ids;
}

function referencedQueueBooks(store) {
  const ids = new Set();
  for (const queue of userEntries(store)) {
    for (const bookId of Array.isArray(queue.bookIds) ? queue.bookIds : []) ids.add(String(bookId));
    if (queue.bookSettings && typeof queue.bookSettings === 'object') {
      for (const bookId of Object.keys(queue.bookSettings)) ids.add(bookId);
    }
  }
  return ids;
}

module.exports = {
  DELETE_BOOK_RESULT,
  createBookArtifactCleaner,
  createBookDeletionService,
  loadCatalogStrict
};
