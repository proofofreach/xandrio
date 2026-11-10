const crypto = require('crypto');
const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');
const { storageError, badRequest, notFound, invalidBookId } = require('../http-error');
const { createUserLibraryState } = require('../user-library-state');
const { mapStateWriteToCurrent } = require('../chapter-transition-state');
const { positionMatchesChapterStructure } = require('../chapter-structure');

const MAX_BOOKMARKS_PER_BOOK = 100;
const MAX_NOTE_LENGTH = 500;
const userLibraryState = createUserLibraryState();

function sendStorageError(res, error, message) {
  return storageError(res, error, message, 'Bookmark/settings storage failed:');
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

// A rebuild remaps every bookmark it can and leaves the rest under the old
// structure key, where their chapter index names different text. Keep them
// (they are the reader's own notes) but mark them so no client seeks to them.
function withStructureState(bookmarks, book) {
  if (!Array.isArray(bookmarks)) return [];
  if (!book) return bookmarks;
  return bookmarks.map(bookmark => positionMatchesChapterStructure(bookmark, book)
    ? bookmark
    : { ...bookmark, stale: true });
}

function compareBookmarks(a, b) {
  if ((a.chapterIndex || 0) !== (b.chapterIndex || 0)) return (a.chapterIndex || 0) - (b.chapterIndex || 0);
  return (a.timestamp || 0) - (b.timestamp || 0);
}

const SEARCH_SOURCE_IDS = new Set(['standardebooks', 'gutenberg', 'annas', 'zlibrary', 'internetarchive', 'opds']);
const CLIENT_SETTINGS_ALLOWED_KEYS = ['defaultSpeed', 'skipIntervalSeconds', 'progressDisplayMode', 'defaultSearchSources', 'theme', 'smartRewindEnabled', 'rollingOfflineEnabled', 'shelfRowDensity'];
const ALLOWED_SKIP_INTERVALS = new Set([10, 15, 30]);
const ALLOWED_PROGRESS_MODES = new Set(['elapsed', 'remaining']);
const ALLOWED_ROW_DENSITIES = new Set(['compact', 'comfortable']);

// Each validator returns the stored value, or undefined when the value is not
// acceptable. Search sources are filtered rather than refused, so a client
// that still offers a retired source can keep its other choices.
const CLIENT_SETTING_VALIDATORS = {
  defaultSpeed(value) {
    const speed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(speed) && speed >= 0.5 && speed <= 3 ? speed : undefined;
  },
  skipIntervalSeconds(value) {
    const interval = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    return Number.isInteger(interval) && ALLOWED_SKIP_INTERVALS.has(interval) ? interval : undefined;
  },
  progressDisplayMode(value) {
    return ALLOWED_PROGRESS_MODES.has(value) ? value : undefined;
  },
  defaultSearchSources(value) {
    if (!Array.isArray(value)) return undefined;
    const sources = [...new Set(value.filter(id => SEARCH_SOURCE_IDS.has(id)))];
    return sources.length > 0 ? sources : undefined;
  },
  theme(value) {
    return typeof value === 'string' && value.length <= 20 ? value : undefined;
  },
  smartRewindEnabled(value) {
    return typeof value === 'boolean' ? value : undefined;
  },
  rollingOfflineEnabled(value) {
    return typeof value === 'boolean' ? value : undefined;
  },
  shelfRowDensity(value) {
    return ALLOWED_ROW_DENSITIES.has(value) ? value : undefined;
  }
};

// A settings update names, per key, a new value or null. Null means "reset to
// the default": the key is removed from the stored profile, the same contract
// as the per-book settings route. A non-null value that fails validation is
// reported in `invalid` so the route can refuse the whole update instead of
// dropping the key and answering success. Unknown keys are ignored.
function parseClientSettingsUpdate(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const set = {};
  const reset = [];
  const invalid = [];
  for (const key of CLIENT_SETTINGS_ALLOWED_KEYS) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) continue;
    if (source[key] === null) {
      reset.push(key);
      continue;
    }
    const value = CLIENT_SETTING_VALIDATORS[key](source[key]);
    if (value === undefined) invalid.push(key);
    else set[key] = value;
  }
  return { set, reset, invalid };
}

// The accepted non-null values of an update.
function sanitizeClientSettings(input) {
  return parseClientSettingsUpdate(input).set;
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
        return badRequest(res, 'Invalid bookmark');
      }
      if (characterOffset !== undefined && parsedCharacterOffset === null) {
        return badRequest(res, 'Invalid bookmark character offset');
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
        if (mapped.invalid) {
          return { status: 400, body: { error: 'Bookmark is outside this book' } };
        }
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
      const [rawStore, books] = await Promise.all([
        loadJSON(bookmarksFile, {}),
        booksFile ? loadJSON(booksFile, {}) : {}
      ]);
      const store = normalizeBookmarksStore(rawStore);
      const userBookmarks = store.users?.[userId] || {};
      const bookmarks = Object.fromEntries(Object.entries(userBookmarks)
        .map(([bookId, list]) => [bookId, withStructureState(list, books[bookId])]));
      res.json({ userId, bookmarks });
    } catch (err) {
      sendStorageError(res, err, 'Failed to load bookmarks');
    }
  });

  app.get('/api/bookmarks/:bookId', async (req, res) => {
    try {
      const { bookId } = req.params;
      if (!isSafeBookId(bookId)) {
        return invalidBookId(res);
      }
      const userId = bookmarkUserId(req);
      const [rawStore, books] = await Promise.all([
        loadJSON(bookmarksFile, {}),
        booksFile ? loadJSON(booksFile, {}) : {}
      ]);
      const store = normalizeBookmarksStore(rawStore);
      const bookmarks = withStructureState(store.users?.[userId]?.[bookId], books[bookId]).sort(compareBookmarks);
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
        return notFound(res, 'Bookmark not found');
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
      const input = req.body?.settings;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return badRequest(res, 'Invalid client settings');
      }
      const update = parseClientSettingsUpdate(input);
      if (update.invalid.length) {
        return badRequest(res, `Invalid client settings: ${update.invalid.join(', ')}`);
      }
      let settings;
      await updateJSON(clientSettingsFile, (data) => {
        const store = normalizeBookmarksStore(data);
        settings = { ...(store.users[userId] || {}), ...update.set };
        for (const key of update.reset) delete settings[key];
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
  parseClientSettingsUpdate,
  sanitizeClientSettings
};
