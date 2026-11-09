const path = require('path');
const { isManagedArtifactName } = require('./book-artifact-paths');

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

  return { cleanup, scheduleSweeps };
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
  rememberDeletedBookId,
  cancelBookJobs,
  stopPremiumPrep,
  cleanupBookArtifacts,
  scheduleArtifactSweeps,
  removeBookPositions,
  removeBookBookmarks,
  removeBookFromAllShelves,
  removeBookFromAllQueues,
  log = console
}) {
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

    if (forbidden || removal === skipSave) {
      await abortBookDeletion(deletionToken);
      return {
        status: forbidden ? DELETE_BOOK_RESULT.FORBIDDEN : DELETE_BOOK_RESULT.NOT_FOUND
      };
    }

    const { book } = removal;
    try {
      await commitBookDeletion(deletionToken);
    } catch (error) {
      // The pending transaction is intentionally retained. Reconciliation
      // publishes it once the deletion feed is next requested.
      log.warn(`Could not commit deletion tombstone for ${bookId}:`, error);
    }
    const tombstone = rememberDeletedBookId(bookId);
    const cancelledJobs = await cancelBookJobs(bookId);
    await stopPremiumPrep(bookId);

    const artifactCleanup = await cleanupBookArtifacts(bookId, book);
    scheduleArtifactSweeps(bookId, book, tombstone);
    if (artifactCleanup.failed.length > 0) {
      log.warn(`Book deletion left ${artifactCleanup.failed.length} artifact(s):`, artifactCleanup.failed);
    }

    // Each library-state store is cleaned independently: one failing write
    // must not leave the later stores pointing at a book that no longer
    // exists. Failures are reported, and reconcileLibraryState() at the next
    // startup drops whatever was left behind.
    const libraryStateErrors = [];
    const steps = [
      ['positions', () => updateJSON(positionsFile, positions => { removeBookPositions(positions, bookId); })],
      ['bookmarks', () => updateJSON(bookmarksFile, bookmarks => { removeBookBookmarks(bookmarks, bookId); })],
      ['shelves', () => updateJSON(shelvesFile, shelvesStore => { removeBookFromAllShelves(shelvesStore, bookId); })]
    ];
    if (listeningQueueFile && removeBookFromAllQueues) {
      steps.push(['listeningQueues', () => updateJSON(listeningQueueFile, queueStore => { removeBookFromAllQueues(queueStore, bookId); })]);
    }
    for (const [store, run] of steps) {
      try {
        await run();
      } catch (error) {
        libraryStateErrors.push({ store, error: error.message });
        log.warn(`Book deletion could not clean ${store} for ${bookId}:`, error);
      }
    }

    return {
      status: DELETE_BOOK_RESULT.DELETED,
      cancelledJobs,
      artifactCleanup,
      ...(libraryStateErrors.length ? { libraryStateErrors } : {})
    };
  }

  // Startup repair for the fan-out above: drops library-state entries whose
  // book is no longer in the catalog. Runs only against a catalog that loaded
  // and is non-empty, so a missing or empty books.json never empties the
  // listening state of a library that still exists.
  async function reconcileLibraryState({ loadBooks }) {
    let books;
    try {
      books = await loadBooks();
    } catch (error) {
      log.warn('Library-state reconcile skipped: catalog unavailable:', error.message);
      return { skipped: 'catalog-unavailable', removed: {} };
    }
    const bookIds = new Set(Object.keys(books || {}));
    if (bookIds.size === 0) return { skipped: 'empty-catalog', removed: {} };
    const removed = {};
    const stores = [
      ['positions', positionsFile, referencedPositionBooks, removeBookPositions],
      ['bookmarks', bookmarksFile, referencedUserMapBooks, removeBookBookmarks],
      ['shelves', shelvesFile, referencedShelfBooks, removeBookFromAllShelves]
    ];
    if (listeningQueueFile && removeBookFromAllQueues) {
      stores.push(['listeningQueues', listeningQueueFile, referencedQueueBooks, removeBookFromAllQueues]);
    }
    for (const [store, file, referenced, remove] of stores) {
      try {
        await updateJSON(file, data => {
          const orphans = [...referenced(data)].filter(bookId => !bookIds.has(bookId));
          if (orphans.length === 0) return skipSave;
          for (const bookId of orphans) remove(data, bookId);
          removed[store] = orphans.length;
        });
      } catch (error) {
        log.warn(`Library-state reconcile failed for ${store}:`, error);
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
  createBookDeletionService
};
