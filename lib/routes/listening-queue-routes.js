const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');
const { badRequest, notFound, invalidBookId, storageError } = require('../http-error');
const { createUserLibraryState } = require('../user-library-state');
const {
  normalizeUserQueue,
  addToQueue,
  removeFromQueue,
  moveQueueItem,
  advanceQueue,
  sanitizeBookPlaybackSettings,
  suggestNextSeriesBook
} = require('../listening-queue');

const userLibraryState = createUserLibraryState();

function normalizeStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  if (!store.users || typeof store.users !== 'object') store.users = {};
  return store;
}

function registerListeningQueueRoutes(app, {
  listeningQueueFile,
  booksFile,
  positionsFile,
  loadJSON,
  updateJSON
}) {
  const userIdFor = req => userLibraryState.userIdFromRequest(req);

  async function queueContext(req) {
    const userId = userIdFor(req);
    const [store, books] = await Promise.all([
      loadJSON(listeningQueueFile, {}),
      loadJSON(booksFile, {})
    ]);
    const queue = normalizeUserQueue(normalizeStore(store).users[userId] || {});
    queue.bookIds = queue.bookIds.filter(bookId => books[bookId]);
    return { userId, queue, books };
  }

  app.get('/api/listening-queue', async (req, res) => {
    try {
      const { userId, queue, books } = await queueContext(req);
      res.json({
        userId,
        queue,
        books: queue.bookIds.map(bookId => {
          const book = books[bookId];
          return { id: bookId, title: book.title, author: book.author, series: book.series, seriesIndex: book.seriesIndex };
        })
      });
    } catch (error) {
      return storageError(res, error, 'Failed to load listening queue', 'Listening queue load failed:');
    }
  });

  app.put('/api/listening-queue', async (req, res) => {
    try {
      const userId = userIdFor(req);
      const books = await loadJSON(booksFile, {});
      const requested = normalizeUserQueue(req.body?.queue || req.body || {});
      requested.bookIds = requested.bookIds.filter(bookId => books[bookId]);
      await updateJSON(listeningQueueFile, data => {
        const store = normalizeStore(data);
        const existing = normalizeUserQueue(store.users[userId] || {});
        store.users[userId] = {
          ...existing,
          bookIds: requested.bookIds,
          autoContinue: requested.autoContinue
        };
      });
      res.json({ success: true, queue: requested });
    } catch (error) {
      return storageError(res, error, 'Failed to save listening queue', 'Listening queue save failed:');
    }
  });

  app.post('/api/listening-queue/items', async (req, res) => {
    try {
      const { bookId, position } = req.body || {};
      if (!isSafeBookId(bookId)) return invalidBookId(res);
      const books = await loadJSON(booksFile, {});
      if (!books[bookId]) return notFound(res, 'Book not found');
      const userId = userIdFor(req);
      let queue;
      await updateJSON(listeningQueueFile, data => {
        const store = normalizeStore(data);
        queue = addToQueue(store.users[userId], bookId, position === 'next' ? 'next' : 'last');
        store.users[userId] = queue;
      });
      res.json({ success: true, queue });
    } catch (error) {
      return storageError(res, error, 'Failed to update listening queue', 'Listening queue update failed:');
    }
  });

  app.patch('/api/listening-queue/items/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      const toIndex = parseNonNegativeInteger(req.body?.toIndex);
      if (!isSafeBookId(bookId) || toIndex === null) return badRequest(res, 'Invalid queue move');
      const userId = userIdFor(req);
      let queue;
      await updateJSON(listeningQueueFile, data => {
        const store = normalizeStore(data);
        queue = moveQueueItem(store.users[userId], bookId, toIndex);
        store.users[userId] = queue;
      });
      res.json({ success: true, queue });
    } catch (error) {
      return storageError(res, error, 'Failed to move queue item', 'Listening queue move failed:');
    }
  });

  app.delete('/api/listening-queue/items/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      if (!isSafeBookId(bookId)) return invalidBookId(res);
      const userId = userIdFor(req);
      let queue;
      await updateJSON(listeningQueueFile, data => {
        const store = normalizeStore(data);
        queue = removeFromQueue(store.users[userId], bookId);
        store.users[userId] = queue;
      });
      res.json({ success: true, queue });
    } catch (error) {
      return storageError(res, error, 'Failed to update listening queue', 'Listening queue update failed:');
    }
  });

  app.get('/api/listening-queue/books/:bookId/settings', async (req, res) => {
    try {
      const { bookId } = req.params;
      if (!isSafeBookId(bookId)) return invalidBookId(res);
      const { queue, books } = await queueContext(req);
      if (!books[bookId]) return notFound(res, 'Book not found');
      res.json({ bookId, settings: queue.bookSettings[bookId] || {} });
    } catch (error) {
      return storageError(res, error, 'Failed to load book playback settings', 'Listening queue settings load failed:');
    }
  });

  app.put('/api/listening-queue/books/:bookId/settings', async (req, res) => {
    try {
      const { bookId } = req.params;
      if (!isSafeBookId(bookId)) return invalidBookId(res);
      const books = await loadJSON(booksFile, {});
      if (!books[bookId]) return notFound(res, 'Book not found');
      const input = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
      const settings = sanitizeBookPlaybackSettings(input);
      const resetKeys = ['playbackSpeed', 'smartRewindEnabled', 'rollingOfflineEnabled']
        .filter(key => input[key] === null);
      const userId = userIdFor(req);
      let savedSettings;
      await updateJSON(listeningQueueFile, data => {
        const store = normalizeStore(data);
        const queue = normalizeUserQueue(store.users[userId]);
        const merged = { ...(queue.bookSettings[bookId] || {}), ...settings };
        for (const key of resetKeys) delete merged[key];
        if (Object.keys(merged).length) queue.bookSettings[bookId] = merged;
        else delete queue.bookSettings[bookId];
        savedSettings = queue.bookSettings[bookId] || {};
        store.users[userId] = queue;
      });
      res.json({ success: true, bookId, settings: savedSettings });
    } catch (error) {
      return storageError(res, error, 'Failed to save book playback settings', 'Listening queue settings save failed:');
    }
  });

  app.post('/api/listening-queue/advance', async (req, res) => {
    try {
      const { finishedBookId } = req.body || {};
      if (!isSafeBookId(finishedBookId)) return invalidBookId(res);
      const userId = userIdFor(req);
      const [books, positionsStore] = await Promise.all([
        loadJSON(booksFile, {}),
        loadJSON(positionsFile, {})
      ]);
      const positions = userLibraryState.positionsForUser(positionsStore, userId);
      let result;
      await updateJSON(listeningQueueFile, data => {
        const store = normalizeStore(data);
        result = advanceQueue(store.users[userId], finishedBookId);
        result.queue.bookIds = result.queue.bookIds.filter(bookId =>
          books[bookId] && positions[bookId]?.finished !== true
        );
        result.nextBookId = result.queue.autoContinue ? (result.queue.bookIds[0] || null) : null;
        if (!result.nextBookId && result.queue.autoContinue) {
          const suggested = suggestNextSeriesBook(books[finishedBookId], books, positions);
          if (suggested) {
            result.queue = addToQueue(result.queue, suggested);
            result.nextBookId = suggested;
            result.seriesSuggested = true;
          }
        }
        store.users[userId] = result.queue;
      });
      res.json({ success: true, ...result });
    } catch (error) {
      return storageError(res, error, 'Failed to advance listening queue', 'Listening queue advance failed:');
    }
  });
}

module.exports = { registerListeningQueueRoutes, normalizeStore };
