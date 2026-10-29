const { isSafeBookId } = require('../request-guards');
const { createBookRouteHelpers } = require('./book-route-helpers');
const { notFound, forbidden, conflict, invalidBookId, sendError } = require('../http-error');
const { compactPlaybackChapter, chapterPronunciationContext } = require('../playback-book-metadata');
const { chapterStructureKey } = require('../chapter-structure');

function registerLibraryBookRoutes(app, {
  booksFile, shelvesFile, loadJSON, updateJSON, jsonStore, shelves, userIdFromRequest,
  publicBookRecord, publicBookRecordWithCoverArtifact, bookMutationLocks,
  bookDeletionService, DELETE_BOOK_RESULT, bookMetadataRefreshService,
  REFRESH_BOOK_RESULT, chapterRebuildService, getChaptersCached, getCachedChapterStructure,
  normalizeChapterTitleForDisplay, canonicalBookCoverPath,
  readValidatedLibraryCover, shouldRefreshCachedCover, coverRecentlyChecked = () => false, removeFileIfExists,
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

// A single bounded structure read for resumed library rows. The same shared
// library visibility as /api/library applies; paths and narration text stay private.
app.get('/api/library/chapter-labels', async (req, res) => {
  const raw = typeof req.query.bookIds === 'string' ? req.query.bookIds.split(',') : [];
  if (!raw.length || raw.length > 50 || raw.some(id => !isSafeBookId(id))) {
    return sendError(res, 400, 'Request 1 to 50 valid book identifiers');
  }
  try {
    const books = await loadJSON(booksFile, {});
    const ids = [...new Set(raw)];
    const summaries = {};
    let cursor = 0;
    // Two readers keep a large resumed shelf from opening every artifact at once.
    await Promise.all([0, 1].map(async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        summaries[id] = null;
        if (!books[id] || !getCachedChapterStructure) continue;
        try {
          const summary = await getCachedChapterStructure(books[id].path);
          if (!summary || (books[id].chapterStructureKey && books[id].chapterStructureKey !== summary.structureKey)) continue;
          summaries[id] = {
            structureKey: summary.structureKey,
            chapters: summary.chapters.map(chapter => ({
              title: normalizeChapterTitleForDisplay(chapter.title),
              type: chapter.type,
              empty: chapter.empty
            }))
          };
        } catch {
          // Missing artifacts do not prevent the shelf from rendering.
        }
      }
    }));
    res.json({ summaries });
  } catch (err) {
    sendServerError(res, err, 'Failed to load chapter labels');
  }
});

app.post('/api/shelf/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) return invalidBookId(res);
    const userId = userIdFor(req);
    const added = await bookMutationLocks.withBookStateLock(bookId, async () => {
      const context = await requireBook(req, res);
      if (!context) return false;
      await updateJSON(shelvesFile, (data) => {
        shelves.addToShelf(data, userId, bookId);
      });
      return true;
    });
    if (!added) return;
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err, "Failed to update shelf");
  }
});

app.delete('/api/shelf/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) return invalidBookId(res);
    const userId = userIdFor(req);
    const removed = await updateJSON(shelvesFile, (data) => {
      const found = shelves.removeFromShelf(data, userId, bookId);
      return found || jsonStore.SKIP_SAVE;
    });
    if (removed === jsonStore.SKIP_SAVE) return notFound(res, 'Book is not on your shelf');
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
      return invalidBookId(res);
    }
    const deletion = await bookMutationLocks.withBookMutationLock(bookId, () =>
      bookDeletionService.deleteBook({ bookId, actor: req.user })
    );
    if (deletion.status === DELETE_BOOK_RESULT.FORBIDDEN) {
      return forbidden(res, 'Only the book owner or an admin can delete this book');
    }
    if (deletion.status === DELETE_BOOK_RESULT.NOT_FOUND) {
      return notFound(res, 'Book not found');
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
      return invalidBookId(res);
    }
    const refusal = await refuseIfNotBookOwner(req, bookId);
    if (refusal) return forbidden(res, refusal);
    const refresh = await bookMutationLocks.withBookMutationLock(bookId, () =>
      bookMetadataRefreshService.refreshBook(bookId)
    );
    if (refresh.status === REFRESH_BOOK_RESULT.NOT_FOUND) {
      return notFound(res, 'Book not found');
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
      return invalidBookId(res);
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
        await chapterRebuildService.canRebuild(book.path)
      ) || undefined;
      return {
        book: publicBook,
        chapters: req.query?.playback === '1'
          ? displayChapters.map(compactPlaybackChapter)
          : displayChapters,
        hasCover: publicBook.hasCover
      };
    });
    if (!details) return notFound(res, 'Book not found');
    res.json(details);
  } catch (err) {
    console.error('Book details error:', err);
    sendServerError(res, err, "Failed to load book");
  }
});

// A short, structure-scoped excerpt for the pronunciation sheet. The normal
// playback response can stay small without losing context near the playhead.
app.get('/api/book/:bookId/chapters/:chapterIndex/context', async (req, res) => {
  const { bookId } = req.params;
  if (!isSafeBookId(bookId)) return invalidBookId(res);
  const chapterIndex = Number(req.params.chapterIndex);
  const ratio = Number(req.query?.ratio ?? 0);
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return sendError(res, 400, 'Invalid chapter context position');
  }
  if (typeof req.query?.structureKey !== 'string' || !req.query.structureKey) {
    return sendError(res, 400, 'Chapter structure identity is required');
  }
  try {
    await chapterRebuildService?.recoverBook(bookId);
    await bookMutationLocks.withBookMutationLock(bookId, async () => {
      const book = (await loadJSON(booksFile, {}))[bookId];
      if (!book) return notFound(res, 'Book not found');
      if (req.query.structureKey !== book.chapterStructureKey) {
        return conflict(res, 'Chapter structure changed; reopen the book');
      }
      const chapters = await getChaptersCached(book.path);
      const actualStructureKey = chapterStructureKey(chapters);
      if (actualStructureKey !== req.query.structureKey) {
        return conflict(res, 'Chapter structure changed; reopen the book');
      }
      if (chapterIndex >= chapters.length) return notFound(res, 'Chapter not found');
      res.json({
        context: chapterPronunciationContext(chapters[chapterIndex], ratio),
        chapterStructureKey: actualStructureKey
      });
    });
  } catch (err) {
    sendServerError(res, err, 'Failed to load pronunciation context');
  }
});

async function handleRebuildChapters(req, res) {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return invalidBookId(res);
    }
    const refusal = await refuseIfNotBookOwner(req, bookId);
    if (refusal) return forbidden(res, refusal);
    const result = await chapterRebuildService.rebuild(bookId);
    if (result.reason === 'book-not-found') return notFound(res, 'Book not found');
    if (result.reason === 'unsafe-rebuild') {
      return conflict(res, 'Chapters could not be rebuilt without changing narration text. The current chapters were kept.');
    }

    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) return notFound(res, 'Book not found');
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
      return conflict(res, 'This book does not contain a retained source document that can rebuild chapters.');
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
      if (book.coverPath !== coverPath) await persistCanonicalCoverPath(bookId, coverPath);
      return cachedCover;
    }
    await removeFileIfExists(coverPath);
    console.log(`[cover] Fetching cover for: "${book.title}" by ${book.author}`);
    const fetchedCoverPath = await ensureBookCover(book, { coverPath, force });
    // Record the attempt whatever it found, so views do not repeat it.
    await updateJSON(booksFile, current => {
      if (!current[bookId]) return jsonStore.SKIP_SAVE;
      current[bookId] = { ...current[bookId], coverCheckedAt: new Date().toISOString() };
    });
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
    if (!isSafeBookId(bookId)) return invalidBookId(res);
    const force = req.query.force === '1';
    if (force && req.user?.role !== 'admin') {
      return forbidden(res, 'Administrator access required for forced cover refresh');
    }
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];
    if (!book) return notFound(res, 'Book not found');
    const coverPath = canonicalBookCoverPath(bookId);
    const cachedCover = await readValidatedLibraryCover(coverPath);
    if (!shouldRefreshCachedCover(book, force, cachedCover) && cachedCover) {
      if (book.coverPath !== coverPath) await persistCanonicalCoverPath(bookId, coverPath);
      return res.type(cachedCover.contentType).send(cachedCover.buffer);
    }
    // A book with no cover that was searched recently has none to find yet.
    if (!force && !cachedCover && coverRecentlyChecked(book)) return notFound(res, 'No cover found');
    let admitted = false;
    coverRefreshRateLimit(req, res, () => { admitted = true; });
    if (!admitted) return;
    const cover = await refreshBookCover(bookId, force);
    if (!cover) return notFound(res, 'No cover found');
    return res.type(cover.contentType).send(cover.buffer);
  } catch (err) {
    if (err?.code === 'CONCURRENCY_LIMIT') {
      res.setHeader('Retry-After', '1');
      return sendError(res, 503, 'Cover refresh is busy. Try again shortly.', err.code);
    }
    if (err?.statusCode === 404) return notFound(res, err.message);
    console.error('Cover extraction error:', err);
    return sendServerError(res, err, "Failed to load cover");
  }
});


}

module.exports = { registerLibraryBookRoutes };
