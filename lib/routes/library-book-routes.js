const { isSafeBookId } = require('../request-guards');
const { createBookRouteHelpers } = require('./book-route-helpers');

function registerLibraryBookRoutes(app, {
  booksFile, shelvesFile, loadJSON, updateJSON, jsonStore, shelves, userIdFromRequest,
  publicBookRecord, publicBookRecordWithCoverArtifact, bookMutationLocks,
  bookDeletionService, DELETE_BOOK_RESULT, bookMetadataRefreshService,
  REFRESH_BOOK_RESULT, chapterRebuildService, getChaptersCached,
  normalizeChapterTitleForDisplay, isXBookPath, xbookStore, canonicalBookCoverPath,
  readValidatedLibraryCover, shouldRefreshCachedCover, removeFileIfExists,
  ensureBookCover, persistCanonicalCoverPath, coverRefreshGate,
  coverRefreshRateLimit, coverRefreshJobs = new Map(), sendServerError
}) {
  const { userIdFor, requireBook } = createBookRouteHelpers({ loadJSON, booksFile, isSafeBookId, userIdFromRequest });
app.get('/api/library', async (req, res) => {
  try {
    const userId = userIdFor(req);
    const [books, shelvesStore] = await Promise.all([
      loadJSON(booksFile, {}),
      loadJSON(shelvesFile, {})
    ]);
    const shelf = new Set(shelves.shelfForUser(shelvesStore, userId));
    res.json({
      userId,
      shelf: [...shelf].filter(bookId => books[bookId]),
      books: await Promise.all(Object.values(books).map(book => publicBookRecordWithCoverArtifact(book)))
    });
  } catch (err) {
    sendServerError(res, err, "Failed to load library");
  }
});

app.post('/api/shelf/:bookId', async (req, res) => {
  try {
    const context = await requireBook(req, res);
    if (!context) return;
    const { bookId } = context;
    const userId = userIdFor(req);
    await updateJSON(shelvesFile, (data) => {
      shelves.addToShelf(data, userId, bookId);
    });
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err, "Failed to update shelf");
  }
});

app.delete('/api/shelf/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) return res.status(400).json({ error: 'Invalid book identifier' });
    const userId = userIdFor(req);
    const removed = await updateJSON(shelvesFile, (data) => {
      const found = shelves.removeFromShelf(data, userId, bookId);
      return found || jsonStore.SKIP_SAVE;
    });
    if (removed === jsonStore.SKIP_SAVE) return res.status(404).json({ error: 'Book is not on your shelf' });
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err, "Failed to update shelf");
  }
});

// API: Delete book
app.delete('/api/book/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const deletion = await bookMutationLocks.withBookMutationLock(bookId, () =>
      bookDeletionService.deleteBook({ bookId, actor: req.user })
    );
    if (deletion.status === DELETE_BOOK_RESULT.FORBIDDEN) {
      return res.status(403).json({ error: 'Only the book owner or an admin can delete this book' });
    }
    if (deletion.status === DELETE_BOOK_RESULT.NOT_FOUND) {
      return res.status(404).json({ error: 'Book not found' });
    }
    res.json({
      success: true,
      message: 'Book deleted successfully',
      deletedArtifacts: deletion.artifactCleanup.deleted.length,
      failedArtifacts: deletion.artifactCleanup.failed,
      cancelledJobs: deletion.cancelledJobs
    });
  } catch (err) {
    console.error('Delete book error:', err);
    sendServerError(res, err, "Failed to delete book");
  }
});

// API: Refresh metadata for a book
// DELETE /api/book/:bookId enforces "a member may only touch a book they added"
// (lib/book-deletion.js:118), but the other destructive routes did not: any
// member could rewrite another account's metadata or discard and rebuild their
// chapters. Same predicate, so the three routes agree. Returns an error string
// when refused, null when allowed.
async function refuseIfNotBookOwner(req, bookId) {
  const actor = req.user;
  if (actor?.role !== 'member') return null;
  const books = await loadJSON(booksFile, {});
  const book = books?.[bookId];
  if (!book) return null; // absent book: let the handler report 404 as before
  if (book.addedBy === actor.id) return null;
  return 'Only the book owner or an admin can modify this book';
}

app.post('/api/refresh-metadata/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const refusal = await refuseIfNotBookOwner(req, bookId);
    if (refusal) return res.status(403).json({ error: refusal });
    const refresh = await bookMutationLocks.withBookMutationLock(bookId, () =>
      bookMetadataRefreshService.refreshBook(bookId)
    );
    if (refresh.status === REFRESH_BOOK_RESULT.NOT_FOUND) {
      return res.status(404).json({ error: 'Book not found' });
    }
    res.json({ success: true, book: publicBookRecord(refresh.book) });
  } catch (err) {
    console.error('Metadata refresh error:', err);
    sendServerError(res, err, "Failed to refresh metadata");
  }
});

// API: Get book details and chapters
app.get('/api/book/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    await chapterRebuildService?.recoverBook(bookId);
    const details = await bookMutationLocks.withBookMutationLock(bookId, async () => {
      const books = await loadJSON(booksFile, {});
      const book = books[bookId];
      if (!book) return null;

      // Keep extraction and any resulting structure reconciliation under the
      // same per-book lock as rebuild, refresh, re-import, and deletion.
      const chapters = await getChaptersCached(book.path);
      const structureReconcile = await bookMetadataRefreshService
        .reconcileChapterStructure(bookId, chapters)
        .catch(err => {
          console.error(`Chapter structure reconciliation failed for ${bookId}: ${err.message}`);
          return null;
        });
      if (structureReconcile?.book) Object.assign(book, structureReconcile.book);
      const displayChapters = chapters.map(ch => ({
        ...ch,
        rawTitle: ch.rawTitle || ch.title,
        title: normalizeChapterTitleForDisplay(ch.title || `Chapter ${ch.index + 1}`)
      }));

      if (book.totalDuration === undefined || book.chapterCount === undefined) {
        if (book.totalDuration === undefined) {
          book.totalDuration = chapters.reduce((sum, ch) => sum + (ch.estimatedDuration || 0), 0);
        }
        if (book.chapterCount === undefined) book.chapterCount = chapters.length;
        const totalDuration = book.totalDuration;
        const chapterCount = book.chapterCount;
        await updateJSON(booksFile, (currentBooks) => {
          const current = currentBooks[bookId];
          if (!current) return jsonStore.SKIP_SAVE;
          let updated = false;
          if (current.totalDuration === undefined) {
            current.totalDuration = totalDuration;
            updated = true;
          }
          if (current.chapterCount === undefined) {
            current.chapterCount = chapterCount;
            updated = true;
          }
          if (!updated) return jsonStore.SKIP_SAVE;
        });
      }

      const publicBook = await publicBookRecordWithCoverArtifact(book);
      publicBook.canRebuildChapters = Boolean(
        book.canRebuildChapters ||
        chapters.sourceDocument?.pages?.length ||
        (isXBookPath(book.path) && await xbookStore.canRebuildXBookArtifact(book.path))
      ) || undefined;
      return { book: publicBook, chapters: displayChapters, hasCover: publicBook.hasCover };
    });
    if (!details) return res.status(404).json({ error: 'Book not found' });
    res.json(details);
  } catch (err) {
    console.error('Book details error:', err);
    sendServerError(res, err, "Failed to load book");
  }
});

async function handleRebuildChapters(req, res) {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const refusal = await refuseIfNotBookOwner(req, bookId);
    if (refusal) return res.status(403).json({ error: refusal });
    const result = await chapterRebuildService.rebuild(bookId);
    if (result.reason === 'book-not-found') return res.status(404).json({ error: 'Book not found' });
    if (result.reason === 'unsafe-rebuild') {
      return res.status(409).json({
        error: 'Chapters could not be rebuilt without changing narration text. The current chapters were kept.'
      });
    }

    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const chapters = await getChaptersCached(book.path);
    const displayChapters = chapters.map(chapter => ({
      ...chapter,
      rawTitle: chapter.rawTitle || chapter.title,
      title: normalizeChapterTitleForDisplay(chapter.title || `Chapter ${chapter.index + 1}`)
    }));
    res.json({
      success: true,
      changed: Boolean(result.changed),
      reason: result.changed ? undefined : result.reason,
      book: publicBookRecord(book),
      chapters: displayChapters
    });
  } catch (err) {
    if (err.code === 'PDF_SOURCE_DATA_UNAVAILABLE' || err.code === 'XBOOK_REPROCESS_UNSUPPORTED') {
      return res.status(409).json({
        error: 'This book does not contain a retained source document that can rebuild chapters.'
      });
    }
    console.error('Chapter rebuild error:', err);
    sendServerError(res, err, 'Failed to rebuild chapters');
  }
}

app.post('/api/book/:bookId/rebuild-chapters', handleRebuildChapters);
// Compatibility alias. Remove after 2026-12-31, once pre-capability clients
// have aged out. It executes the same generic rebuild transaction.
app.post('/api/book/:bookId/reprocess-pdf', (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Thu, 31 Dec 2026 23:59:59 GMT');
  res.setHeader('Link', `</api/book/${encodeURIComponent(req.params.bookId)}/rebuild-chapters>; rel="successor-version"`);
  return handleRebuildChapters(req, res);
});

// API: Get book cover image
async function refreshBookCover(bookId, force) {
  const existing = coverRefreshJobs.get(bookId);
  if (existing) return existing;
  const release = coverRefreshGate.tryAcquire();
  if (!release) {
    const error = new Error('Cover refresh is busy');
    error.code = 'CONCURRENCY_LIMIT';
    error.statusCode = 503;
    throw error;
  }
  const job = bookMutationLocks.withBookStateLock(bookId, async () => {
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) {
      const error = new Error('Book not found');
      error.statusCode = 404;
      throw error;
    }
    const coverPath = canonicalBookCoverPath(bookId);
    const cachedCover = await readValidatedLibraryCover(coverPath);
    if (!shouldRefreshCachedCover(book, force, cachedCover) && cachedCover) {
      await persistCanonicalCoverPath(bookId, coverPath);
      return cachedCover;
    }
    await removeFileIfExists(coverPath);
    console.log(`[cover] Fetching cover for: "${book.title}" by ${book.author}`);
    const fetchedCoverPath = await ensureBookCover(book, { coverPath, force });
    if (!fetchedCoverPath) return null;
    const fetchedCover = await readValidatedLibraryCover(fetchedCoverPath);
    if (!fetchedCover) {
      await removeFileIfExists(fetchedCoverPath);
      return null;
    }
    console.log(`[cover] Final cover: ${fetchedCover.dimensions.width}x${fetchedCover.dimensions.height} for "${book.title}"`);
    await persistCanonicalCoverPath(bookId, coverPath, book.coverSource);
    return fetchedCover;
  }).finally(() => {
    release();
    if (coverRefreshJobs.get(bookId) === job) coverRefreshJobs.delete(bookId);
  });
  coverRefreshJobs.set(bookId, job);
  return job;
}

app.get('/api/cover/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) return res.status(400).json({ error: 'Invalid book identifier' });
    const force = req.query.force === '1';
    if (force && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required for forced cover refresh' });
    }
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) return res.status(404).json({ error: 'Book not found' });
    const coverPath = canonicalBookCoverPath(bookId);
    const cachedCover = await readValidatedLibraryCover(coverPath);
    if (!shouldRefreshCachedCover(book, force, cachedCover) && cachedCover) {
      await persistCanonicalCoverPath(bookId, coverPath);
      return res.type(cachedCover.contentType).send(cachedCover.buffer);
    }
    let admitted = false;
    coverRefreshRateLimit(req, res, () => { admitted = true; });
    if (!admitted) return;
    const cover = await refreshBookCover(bookId, force);
    if (!cover) return res.status(404).json({ error: 'No cover found' });
    return res.type(cover.contentType).send(cover.buffer);
  } catch (err) {
    if (err?.code === 'CONCURRENCY_LIMIT') {
      res.setHeader('Retry-After', '1');
      return res.status(503).json({ error: 'Cover refresh is busy. Try again shortly.', code: err.code });
    }
    if (err?.statusCode === 404) return res.status(404).json({ error: err.message });
    console.error('Cover extraction error:', err);
    return sendServerError(res, err, "Failed to load cover");
  }
});


}

module.exports = { registerLibraryBookRoutes };
