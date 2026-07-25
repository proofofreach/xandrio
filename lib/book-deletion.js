const path = require('path');

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
    addPath(book.extractedArtifact);
    addPath(book.coverPath);

    const cacheFiles = await fs.readdir(cacheDir).catch(() => []);
    for (const file of cacheFiles) {
      if (file === bookId || file.startsWith(`${bookId}.`) || file.startsWith(`${bookId}_`)) {
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
    for (const delay of [2000, 10000, 30000]) {
      setTimer(() => {
        if (!isBookDeleted(bookId)) return;
        cleanup(bookId, book)
          .then(result => {
            if (result.deleted.length > 0 || result.failed.length > 0) {
              log.log(`Post-delete sweep for ${bookId}: removed ${result.deleted.length}, failed ${result.failed.length}`);
            }
          })
          .catch(error => log.error(`Post-delete sweep failed for ${bookId}:`, error));
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
    const cancelledJobs = cancelBookJobs(bookId);
    stopPremiumPrep(bookId);

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
