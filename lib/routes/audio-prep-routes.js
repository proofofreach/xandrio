const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');
const { createBookRouteHelpers } = require('./book-route-helpers');

function registerAudioPrepRoutes(app, {
  booksFile, shelvesFile, positionsFile, settingsFile, loadJSON, updateJSON, fs,
  shelves, positionsForUser, ttsQueue, premiumPrep, offlinePreparationCoordinator,
  getChaptersCached, chunkedTTS, getTTSVariantKey, getActiveInstantVoice,
  isPremiumPrepEnabled, isPremiumVoiceActive, updateSettingsCache, userIdFromRequest,
  getAvailableVoices, transformNarrationText, getChunkSizeForVoice,
  getTTSVariantKeyForVoice, getTtsOutputFormatForVoice, sendServerError
}) {
  const { userIdFor, requireBook } = createBookRouteHelpers({ loadJSON, booksFile, isSafeBookId, userIdFromRequest });
app.get('/api/voice-cache/:bookId/:chapterIndex', async (req, res) => {
  try {
    const { bookId } = req.params;
    const chapterIndex = parseNonNegativeInteger(req.params.chapterIndex);
    if (!isSafeBookId(bookId) || chapterIndex === null) {
      return res.status(400).json({ error: 'Invalid book or chapter identifier' });
    }
    const books = await loadJSON(booksFile, {});
    const book = books[bookId];

    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const chapters = await getChaptersCached(book.path);
    const chapter = chapters[chapterIndex];

    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found' });
    }

    const voices = await getAvailableVoices();
    const narrationText = await transformNarrationText({ text: chapter.text, bookId });
    const summaries = await Promise.all(voices.map(async voice => {
      const chunkSize = getChunkSizeForVoice(voice.id);
      const chunkTexts = chunkedTTS.splitIntoChunks(narrationText, chunkSize);
      const variantKey = getTTSVariantKeyForVoice(voice.id);
      let readyChunks = 0;

      await Promise.all(chunkTexts.map(async (_text, index) => {
        const chunkPath = chunkedTTS.chunkPathForVariant(
          bookId,
          chapterIndex,
          index,
          variantKey,
          getTtsOutputFormatForVoice(voice.id)
        );
        try {
          await fs.access(chunkPath);
          readyChunks++;
        } catch {}
      }));

      return {
        voiceId: voice.id,
        totalChunks: chunkTexts.length,
        readyChunks,
        status: readyChunks === 0 ? 'uncached' : (readyChunks === chunkTexts.length ? 'ready' : 'partial')
      };
    }));

    res.json({ bookId, chapterIndex, voices: summaries });
  } catch (err) {
    console.error('Voice cache status error:', err);
    sendServerError(res, err, "Failed to read voice cache status");
  }
});


// --- Progressive premium audio: book-level background prep -----------------

// Status for the book prep panel and chapter-sheet readiness dots.
app.get('/api/premium-prep/:bookId/status', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const context = await requireBook(req, res);
    if (!context) return;
    const { book } = context;

    const enabled = isPremiumPrepEnabled();
    const premiumActive = isPremiumVoiceActive();
    if (!premiumActive) {
      return res.json({ enabled, premiumActive, status: 'idle' });
    }

    const chapters = await getChaptersCached(book.path);
    // Chapter-file existence only: cheap stats, and the prep pipeline always
    // concatenates, so this is the authoritative "fully premium" signal.
    const readiness = await Promise.all(chapters.map(async (_, index) => {
      try {
        const stat = await fs.stat(chunkedTTS.chapterPath(bookId, index));
        return stat.size > 0;
      } catch {
        return false;
      }
    }));
    const readyChapters = readiness.filter(Boolean).length;

    const state = premiumPrep.getState(bookId);
    let status = state && state.variantKey === getTTSVariantKey() ? state.status : 'idle';
    if (readyChapters === chapters.length) status = 'ready';

    res.json({
      enabled,
      premiumActive,
      instantVoice: getActiveInstantVoice(),
      status,
      readyChapters,
      totalChapters: chapters.length,
      currentChapter: state?.currentChapter ?? null,
      error: state?.error || null,
      chapters: readiness
    });
  } catch (err) {
    console.error('Premium prep status error:', err);
    sendServerError(res, err, "Failed to get premium prep status");
  }
});

// Start, reposition, or retry book prep (also the panel's Retry action).
app.post('/api/premium-prep/:bookId/start', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    if (!isPremiumVoiceActive()) {
      return res.status(409).json({ error: 'Active voice has no premium tier' });
    }
    const fromChapter = parseNonNegativeInteger(String(req.body?.fromChapter ?? 0)) ?? 0;
    const retry = Boolean(req.body?.retry);
    const state = retry
      ? premiumPrep.retry(bookId, fromChapter)
      : premiumPrep.ensureBookPrep(bookId, fromChapter);
    res.json({ started: Boolean(state), status: state?.status || 'idle' });
  } catch (err) {
    console.error('Premium prep start error:', err);
    sendServerError(res, err, "Failed to start premium prep");
  }
});

app.get('/api/premium-prep/settings', (req, res) => {
  res.json({ enabled: isPremiumPrepEnabled() });
});

// Single settings toggle: "Prepare premium audio in background" (default on).
app.post('/api/premium-prep/settings', async (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    const settings = await updateJSON(settingsFile, current => {
      current.premiumPrepEnabled = enabled;
      return current;
    });
    updateSettingsCache(settings);
    res.json({ enabled });
  } catch (err) {
    console.error('Premium prep settings error:', err);
    sendServerError(res, err, "Failed to save premium prep settings");
  }
});

// API: Get reader-facing audio activity. Raw global queue counts remain in
// operator diagnostics; this endpoint only exposes books relevant to the
// requesting account.
app.get('/api/queue/status', async (req, res) => {
  try {
    const userId = userIdFor(req);
    const [books, shelvesStore, positionsStore] = await Promise.all([
      loadJSON(booksFile, {}),
      loadJSON(shelvesFile, {}),
      loadJSON(positionsFile, {})
    ]);
    const relevantBookIds = new Set([
      ...shelves.shelfForUser(shelvesStore, userId),
      ...Object.keys(positionsForUser(positionsStore, userId))
    ]);
    const activity = ttsQueue.getQueueActivity({ bookIds: relevantBookIds });
    const activityBooks = await Promise.all(activity.books.map(async item => {
      const book = books[item.bookId];
      if (!book) return null;
      const chapters = await getChaptersCached(book.path).catch(() => []);
      return {
        id: item.bookId,
        title: book.title || 'Untitled',
        author: book.author || 'Unknown Author',
        hasCover: Boolean(book.coverPath),
        active: item.active,
        queued: item.queued,
        origins: item.origins || {},
        chapters: item.chapters.map(chapter => ({
          ...chapter,
          title: String(chapters[chapter.chapterIndex]?.title || '').trim() || undefined
        }))
      };
    }));
    res.json({
      active: activity.active,
      queued: activity.queued,
      books: activityBooks.filter(Boolean)
    });
  } catch (err) {
    sendServerError(res, err, 'Failed to load audio activity');
  }
});

// API: Move one title through the audio generation order.
//
// The order is a tie-break inside each priority band, never across them, so
// this can rearrange a backlog but can never put speculative work in front of
// the chapter someone is listening to. The move is expressed relative to the
// list the reader is looking at: the account's own activity order is what gets
// seeded, so a reader can only reposition titles they can already see.
app.post('/api/queue/order', async (req, res) => {
  try {
    const bookId = String(req.body?.bookId || '');
    const direction = req.body?.direction;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: "Direction must be 'up' or 'down'" });
    }
    const userId = userIdFor(req);
    const [shelvesStore, positionsStore] = await Promise.all([
      loadJSON(shelvesFile, {}),
      loadJSON(positionsFile, {})
    ]);
    const relevantBookIds = new Set([
      ...shelves.shelfForUser(shelvesStore, userId),
      ...Object.keys(positionsForUser(positionsStore, userId))
    ]);
    if (!relevantBookIds.has(bookId)) {
      return res.status(404).json({ error: 'Book is not in this library' });
    }
    const visible = ttsQueue
      .getQueueActivity({ bookIds: relevantBookIds })
      .books.map(item => item.bookId);
    const movedPreparation = offlinePreparationCoordinator.move(bookId, direction);
    const order = ttsQueue.moveBook(bookId, direction, visible);
    if (!order && !movedPreparation) {
      // Nothing to reorder: either the title holds no queued work, or it is
      // already at the end it was moved towards.
      return res.status(409).json({
        error: 'This title cannot move any further',
        code: 'QUEUE_ORDER_UNCHANGED',
        order: ttsQueue.bookOrder()
      });
    }
    res.json({ bookId, direction, order: order || ttsQueue.bookOrder() });
  } catch (err) {
    sendServerError(res, err, 'Failed to reorder audio activity');
  }
});


}

module.exports = { registerAudioPrepRoutes };
