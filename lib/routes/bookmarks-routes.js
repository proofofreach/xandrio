const crypto = require('crypto');
const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');
const { createUserLibraryState } = require('../user-library-state');
const { mapStateWriteToCurrent } = require('../chapter-transition-state');

const MAX_BOOKMARKS_PER_BOOK = 100;
const MAX_NOTE_LENGTH = 500;
const userLibraryState = createUserLibraryState();

function sendStorageError(res, error, message) {
  console.error('Bookmark/settings storage failed:', error);
  return res.status(500).json({ error: message });
}

function bookmarkUserId(req) {
  return userLibraryState.userIdFromRequest(req);
}

// `users` is keyed by a client-influenced id, so it is rebuilt without a
// prototype. On a plain object `users['__proto__'] = x` invokes the inherited
// setter: it reparents the map instead of storing a key, and the subsequent
// read returns the prototype. With a null prototype there is no such accessor
// and the id becomes an ordinary own property. JSON.parse always yields plain
// objects, so this has to be re-applied on every load.
function normalizeBookmarksStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  if (!store.users || typeof store.users !== 'object') {
    store.users = Object.create(null);
  } else if (Object.getPrototypeOf(store.users) !== null) {
    store.users = Object.assign(Object.create(null), store.users);
  }
  return store;
}

function removeBookBookmarks(bookmarks, bookId) {
  const normalized = normalizeBookmarksStore(bookmarks);
  Object.values(normalized.users || {}).forEach(userBookmarks => {
    if (userBookmarks && typeof userBookmarks === 'object') delete userBookmarks[bookId];
  });
  return normalized;
}

function sanitizeNote(value) {
  if (value === undefined || value === null) return undefined;
  const stripped = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!stripped) return undefined;
  return stripped.slice(0, MAX_NOTE_LENGTH);
}

function compareBookmarks(a, b) {
  if ((a.chapterIndex || 0) !== (b.chapterIndex || 0)) return (a.chapterIndex || 0) - (b.chapterIndex || 0);
  return (a.timestamp || 0) - (b.timestamp || 0);
}

const SEARCH_SOURCE_IDS = new Set(['standardebooks', 'gutenberg', 'annas', 'zlibrary', 'internetarchive', 'opds']);
const CLIENT_SETTINGS_ALLOWED_KEYS = ['defaultSpeed', 'skipIntervalSeconds', 'progressDisplayMode', 'defaultSearchSources', 'theme', 'smartRewindEnabled', 'rollingOfflineEnabled'];
const ALLOWED_SKIP_INTERVALS = new Set([10, 15, 30]);
const ALLOWED_PROGRESS_MODES = new Set(['elapsed', 'remaining']);

function sanitizeClientSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const sanitized = {};

  if ('defaultSpeed' in source) {
    const speed = Number(source.defaultSpeed);
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 3) sanitized.defaultSpeed = speed;
  }
  if ('skipIntervalSeconds' in source) {
    const interval = Number(source.skipIntervalSeconds);
    if (Number.isInteger(interval) && ALLOWED_SKIP_INTERVALS.has(interval)) sanitized.skipIntervalSeconds = interval;
  }
  if ('progressDisplayMode' in source) {
    if (ALLOWED_PROGRESS_MODES.has(source.progressDisplayMode)) sanitized.progressDisplayMode = source.progressDisplayMode;
  }
  if ('defaultSearchSources' in source && Array.isArray(source.defaultSearchSources)) {
    const sources = [...new Set(source.defaultSearchSources.filter(id => SEARCH_SOURCE_IDS.has(id)))];
    if (sources.length > 0) sanitized.defaultSearchSources = sources;
  }
  if ('theme' in source) {
    if (typeof source.theme === 'string' && source.theme.length <= 20) sanitized.theme = source.theme;
  }
  if ('smartRewindEnabled' in source && typeof source.smartRewindEnabled === 'boolean') {
    sanitized.smartRewindEnabled = source.smartRewindEnabled;
  }
  if ('rollingOfflineEnabled' in source && typeof source.rollingOfflineEnabled === 'boolean') {
    sanitized.rollingOfflineEnabled = source.rollingOfflineEnabled;
  }

  return sanitized;
}

function registerBookmarksRoutes(app, {
  bookmarksFile,
  booksFile = null,
  clientSettingsFile,
  jsonStore,
  loadJSON,
  transitionsFile = null,
  updateJSON,
  withBookStateLock = (_bookId, task) => task()
}) {
  app.post('/api/bookmarks', async (req, res) => {
    try {
      const { bookId, chapterIndex, timestamp, characterOffset, positionApproximate, note, chapterStructureKey } = req.body || {};
      const parsedChapterIndex = parseNonNegativeInteger(chapterIndex);
      const parsedTimestamp = Number(timestamp);
      const parsedCharacterOffset = characterOffset === undefined ? null : parseNonNegativeInteger(characterOffset);
      if (!isSafeBookId(bookId) || parsedChapterIndex === null || !Number.isFinite(parsedTimestamp) || parsedTimestamp < 0) {
        return res.status(400).json({ error: 'Invalid bookmark' });
      }
      if (characterOffset !== undefined && parsedCharacterOffset === null) {
        return res.status(400).json({ error: 'Invalid bookmark character offset' });
      }
      const sanitizedNote = sanitizeNote(note);

      const userId = bookmarkUserId(req);
      const outcome = await withBookStateLock(bookId, async () => {
        const books = booksFile ? await loadJSON(booksFile, {}) : { [bookId]: {} };
        const book = books[bookId];
        if (!book) return { status: 404, body: { error: 'Book not found' } };
        const transitions = transitionsFile ? await loadJSON(transitionsFile, {}) : {};
        const mapped = mapStateWriteToCurrent({
          bookId,
          suppliedStructureKey: chapterStructureKey,
          book,
          transitions,
          state: {
            chapterIndex: parsedChapterIndex,
            timestamp: parsedTimestamp,
            characterOffset: parsedCharacterOffset ?? undefined,
            positionApproximate: positionApproximate === true || undefined
          }
        });
        if (mapped.stale) {
          return { status: 409, body: { error: 'Chapter structure changed; reload the book and try again' } };
        }

        let writeOutcome;
        await updateJSON(bookmarksFile, (data) => {
          const store = normalizeBookmarksStore(data);
          // hasOwnProperty rather than truthiness: an inherited member makes
          // the guard read as "already present" and the following write lands
          // on the prototype instead of the store. sanitizeSyncId and
          // isSafeBookId now reject those keys, but this loop must not depend
          // on validation happening upstream.
          // hasOwnProperty rather than truthiness: an inherited member would
          // make the guard read as "already present" and send the write to the
          // prototype. store.users itself is prototype-free (see
          // normalizeBookmarksStore), so the id lands as an own property.
          if (!Object.prototype.hasOwnProperty.call(store.users, userId)) {
            store.users[userId] = Object.create(null);
          }
          if (!Object.prototype.hasOwnProperty.call(store.users[userId], bookId)) {
            store.users[userId][bookId] = [];
          }
          const bookBookmarks = store.users[userId][bookId];

          if (bookBookmarks.length >= MAX_BOOKMARKS_PER_BOOK) {
            writeOutcome = { status: 400, body: { error: 'Bookmark limit reached for this book' } };
            return jsonStore.SKIP_SAVE;
          }

          const now = Date.now();
          const bookmark = {
            id: `bm_${crypto.randomBytes(8).toString('hex')}`,
            chapterIndex: mapped.state.chapterIndex,
            timestamp: mapped.state.timestamp,
            characterOffset: mapped.state.characterOffset,
            positionApproximate: mapped.state.positionApproximate,
            chapterStructureKey: book.chapterStructureKey || undefined,
            note: sanitizedNote,
            createdAt: new Date(now).toISOString(),
            createdAtMs: now
          };
          bookBookmarks.push(bookmark);
          writeOutcome = { status: 200, body: { success: true, bookmark } };
        });
        return writeOutcome;
      });

      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      sendStorageError(res, err, 'Failed to save bookmark');
    }
  });

  app.get('/api/bookmarks', async (req, res) => {
    try {
      const userId = bookmarkUserId(req);
      const store = normalizeBookmarksStore(await loadJSON(bookmarksFile, {}));
      res.json({ userId, bookmarks: store.users?.[userId] || {} });
    } catch (err) {
      sendStorageError(res, err, 'Failed to load bookmarks');
    }
  });

  app.get('/api/bookmarks/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      if (!isSafeBookId(bookId)) {
        return res.status(400).json({ error: 'Invalid book identifier' });
      }
      const userId = bookmarkUserId(req);
      const store = normalizeBookmarksStore(await loadJSON(bookmarksFile, {}));
      const bookmarks = (store.users?.[userId]?.[bookId] || []).slice().sort(compareBookmarks);
      res.json({ userId, bookId, bookmarks });
    } catch (err) {
      sendStorageError(res, err, 'Failed to load bookmarks');
    }
  });

  app.delete('/api/bookmarks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = bookmarkUserId(req);
      const found = await updateJSON(bookmarksFile, (data) => {
        const store = normalizeBookmarksStore(data);
        const userBookmarks = store.users[userId] || {};
        for (const bookId of Object.keys(userBookmarks)) {
          const list = userBookmarks[bookId];
          const index = list.findIndex(bm => bm.id === id);
          if (index !== -1) {
            list.splice(index, 1);
            return true;
          }
        }
        return jsonStore.SKIP_SAVE;
      });

      if (found === jsonStore.SKIP_SAVE) {
        return res.status(404).json({ error: 'Bookmark not found' });
      }
      res.json({ success: true });
    } catch (err) {
      sendStorageError(res, err, 'Failed to delete bookmark');
    }
  });

  app.get('/api/settings/client', async (req, res) => {
    try {
      const userId = bookmarkUserId(req);
      const store = normalizeBookmarksStore(await loadJSON(clientSettingsFile, {}));
      res.json({ settings: store.users?.[userId] || {} });
    } catch (err) {
      sendStorageError(res, err, 'Failed to load client settings');
    }
  });

  app.put('/api/settings/client', async (req, res) => {
    try {
      const userId = bookmarkUserId(req);
      const sanitized = sanitizeClientSettings(req.body?.settings);
      let settings;
      await updateJSON(clientSettingsFile, (data) => {
        const store = normalizeBookmarksStore(data);
        settings = { ...(store.users[userId] || {}), ...sanitized };
        store.users[userId] = settings;
      });
      res.json({ success: true, settings });
    } catch (err) {
      sendStorageError(res, err, 'Failed to save client settings');
    }
  });
}

module.exports = {
  registerBookmarksRoutes,
  removeBookBookmarks,
  CLIENT_SETTINGS_ALLOWED_KEYS,
  sanitizeClientSettings
};
