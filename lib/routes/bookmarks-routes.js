const crypto = require('crypto');
const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');
const { createUserLibraryState } = require('../user-library-state');

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

function normalizeBookmarksStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  if (!store.users || typeof store.users !== 'object') store.users = {};
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
const CLIENT_SETTINGS_ALLOWED_KEYS = ['defaultSpeed', 'skipIntervalSeconds', 'progressDisplayMode', 'defaultSearchSources', 'theme'];
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

  return sanitized;
}

function registerBookmarksRoutes(app, {
  bookmarksFile,
  clientSettingsFile,
  jsonStore,
  loadJSON,
  updateJSON
}) {
  app.post('/api/bookmarks', async (req, res) => {
    try {
      const { bookId, chapterIndex, timestamp, note } = req.body || {};
      const parsedChapterIndex = parseNonNegativeInteger(chapterIndex);
      const parsedTimestamp = Number(timestamp);
      if (!isSafeBookId(bookId) || parsedChapterIndex === null || !Number.isFinite(parsedTimestamp) || parsedTimestamp < 0) {
        return res.status(400).json({ error: 'Invalid bookmark' });
      }
      const sanitizedNote = sanitizeNote(note);

      const userId = bookmarkUserId(req);
      let outcome;
      await updateJSON(bookmarksFile, (data) => {
        const store = normalizeBookmarksStore(data);
        if (!store.users[userId]) store.users[userId] = {};
        if (!store.users[userId][bookId]) store.users[userId][bookId] = [];
        const bookBookmarks = store.users[userId][bookId];

        if (bookBookmarks.length >= MAX_BOOKMARKS_PER_BOOK) {
          outcome = { status: 400, body: { error: 'Bookmark limit reached for this book' } };
          return jsonStore.SKIP_SAVE;
        }

        const now = Date.now();
        const bookmark = {
          id: `bm_${crypto.randomBytes(8).toString('hex')}`,
          chapterIndex: parsedChapterIndex,
          timestamp: parsedTimestamp,
          note: sanitizedNote,
          createdAt: new Date(now).toISOString(),
          createdAtMs: now
        };
        bookBookmarks.push(bookmark);
        outcome = { status: 200, body: { success: true, bookmark } };
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
