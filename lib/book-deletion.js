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

  function scheduleSweeps(bookId, book = {}) {
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
            if (remaining === 0) onSweepsComplete(bookId);
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

        if (actor?.role === 'member' && book.addedBy !== actor.id) {
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
    rememberDeletedBookId(bookId);
    const cancelledJobs = await cancelBookJobs(bookId);
    await stopPremiumPrep(bookId);

    const artifactCleanup = await cleanupBookArtifacts(bookId, book);
    scheduleArtifactSweeps(bookId, book);
    if (artifactCleanup.failed.length > 0) {
      log.warn(`Book deletion left ${artifactCleanup.failed.length} artifact(s):`, artifactCleanup.failed);
    }

    await updateJSON(positionsFile, (positions) => {
      removeBookPositions(positions, bookId);
    });
    await updateJSON(bookmarksFile, (bookmarks) => {
      removeBookBookmarks(bookmarks, bookId);
    });
    await updateJSON(shelvesFile, (shelvesStore) => {
      removeBookFromAllShelves(shelvesStore, bookId);
    });
    if (listeningQueueFile && removeBookFromAllQueues) {
      await updateJSON(listeningQueueFile, (queueStore) => {
        removeBookFromAllQueues(queueStore, bookId);
      });
    }

    return {
      status: DELETE_BOOK_RESULT.DELETED,
      cancelledJobs,
      artifactCleanup
    };
  }

  return { deleteBook };
}

module.exports = {
  DELETE_BOOK_RESULT,
  createBookArtifactCleaner,
  createBookDeletionService
};
