const { isSafeBookId, parseNonNegativeInteger } = require('../request-guards');
const { createBookRouteHelpers } = require('./book-route-helpers');

function registerSyncPositionRoutes(app, {
  booksFile, usersFile, positionsFile, listeningQueueFile, transitionsFile,
  loadJSON, updateJSON, jsonStore, bookMutationLocks, userIdFromRequest,
  syncDeviceId, sanitizeSyncId, DEFAULT_USER_ID, newUserId, syncDisplayName,
  normalizeUsersStore, upsertDevice, publicSyncProfile, migratePositions,
  migrateUserScopedStore, recordPosition, positionForBook, positionsForUser,
  positionsForBooks, positionMatchesChapterStructure, mapStateWriteToCurrent,
  observePlaybackHorizon, playbackPrefetch, computeListeningStats, sendServerError
}) {
  const { userIdFor } = createBookRouteHelpers({ loadJSON, booksFile, isSafeBookId, userIdFromRequest });
app.get('/api/sync/profile', async (req, res) => {
  try {
    const userId = userIdFor(req);
    const deviceId = syncDeviceId(req);
    let user = null;
    await updateJSON(usersFile, (data) => {
      const users = normalizeUsersStore(data);
      user = users.users[userId] || null;
      if (!user) return jsonStore.SKIP_SAVE;
      upsertDevice(user, deviceId, req.headers['x-xandrio-device-name']);
    });
    res.json({ userId, deviceId, profile: publicSyncProfile(user, deviceId) });
  } catch (err) {
    sendServerError(res, err, "Failed to load profile");
  }
});

app.post('/api/sync/profile', async (req, res) => {
  try {
    const now = new Date().toISOString();
    // Account sessions always operate on their own profile; only trusted-LAN
    // and legacy shared-token callers may still self-assert a profile id.
    const requestedUserId = sanitizeSyncId(req.body?.userId, '');
    const userId = req.user?.id
      || (requestedUserId && requestedUserId !== DEFAULT_USER_ID ? requestedUserId : newUserId());
    const deviceId = syncDeviceId(req);
    const deviceName = req.body?.deviceName || req.headers['x-xandrio-device-name'];
    const profileName = syncDisplayName(req.body?.name, 'My Library', 80);
    const user = await updateJSON(usersFile, (data) => {
      const users = normalizeUsersStore(data);
      const record = users.users[userId] || {
        id: userId,
        name: profileName,
        createdAt: now,
        devices: {}
      };
      record.name = profileName;
      upsertDevice(record, deviceId, deviceName);
      users.users[userId] = record;
      return record;
    });

    let migrateFromUserId = sanitizeSyncId(req.body?.migrateFromUserId, '');
    // Account sessions may only absorb the shared legacy "default" data;
    // merging from another account would expose that user's positions.
    if (req.user?.id && migrateFromUserId !== DEFAULT_USER_ID) migrateFromUserId = '';
    if (migrateFromUserId && migrateFromUserId !== userId) {
      await updateJSON(positionsFile, (data) => {
        migratePositions(data, migrateFromUserId, userId);
      });
      await updateJSON(listeningQueueFile, (data) => {
        migrateUserScopedStore(data, migrateFromUserId, userId);
      });
    }

    res.json({ success: true, userId, deviceId, profile: publicSyncProfile(user, deviceId) });
  } catch (err) {
    sendServerError(res, err, "Failed to save profile");
  }
});

app.post('/api/sync/device', async (req, res) => {
  try {
    const userId = userIdFor(req);
    const deviceId = syncDeviceId(req);
    const user = await updateJSON(usersFile, (data) => {
      const users = normalizeUsersStore(data);
      const now = new Date().toISOString();
      const record = users.users[userId] || {
        id: userId,
        name: syncDisplayName(req.body?.profileName, 'My Library', 80),
        createdAt: now,
        devices: {}
      };
      upsertDevice(record, deviceId, req.body?.deviceName || req.headers['x-xandrio-device-name']);
      users.users[userId] = record;
      return record;
    });
    res.json({ success: true, userId, deviceId, profile: publicSyncProfile(user, deviceId) });
  } catch (err) {
    sendServerError(res, err, "Failed to register device");
  }
});

app.post('/api/position', async (req, res) => {
  try {
    const { bookId, chapterIndex, timestamp, chunkIndex, chunkTime, characterOffset, positionApproximate, chapterStructureKey: suppliedStructureKey, playbackRate, wasPlaying, updatedAt, allowBackward, finished } = req.body;
    const parsedChapterIndex = parseNonNegativeInteger(chapterIndex);
    const parsedTimestamp = Number(timestamp);
    const parsedChunkIndex = chunkIndex === undefined ? null : parseNonNegativeInteger(chunkIndex);
    const parsedChunkTime = chunkTime === undefined ? null : Number(chunkTime);
    const parsedCharacterOffset = characterOffset === undefined ? null : parseNonNegativeInteger(characterOffset);
    if (!isSafeBookId(bookId) || parsedChapterIndex === null || !Number.isFinite(parsedTimestamp) || parsedTimestamp < 0) {
      return res.status(400).json({ error: 'Invalid playback position' });
    }
    if (chunkIndex !== undefined && parsedChunkIndex === null) {
      return res.status(400).json({ error: 'Invalid playback chunk' });
    }
    if (chunkTime !== undefined && (!Number.isFinite(parsedChunkTime) || parsedChunkTime < 0)) {
      return res.status(400).json({ error: 'Invalid playback chunk time' });
    }
    if (characterOffset !== undefined && parsedCharacterOffset === null) {
      return res.status(400).json({ error: 'Invalid playback character offset' });
    }

    const userId = userIdFor(req);
    const write = await bookMutationLocks.withBookStateLock(bookId, async () => {
      const books = await loadJSON(booksFile, {});
      const book = books[bookId];
      if (!book) return { status: 404 };
      const transitions = positionMatchesChapterStructure(
        { chapterStructureKey: suppliedStructureKey },
        book
      ) ? {} : await loadJSON(transitionsFile, {});
      const mapped = mapStateWriteToCurrent({
        bookId,
        suppliedStructureKey,
        book,
        transitions,
        state: {
          chapterIndex: parsedChapterIndex,
          timestamp: parsedTimestamp,
          chunkIndex: parsedChunkIndex ?? undefined,
          chunkTime: parsedChunkTime ?? undefined,
          characterOffset: parsedCharacterOffset ?? undefined,
          positionApproximate: positionApproximate === true || undefined
        }
      });
      if (mapped.stale) {
        const existing = positionForBook(await loadJSON(positionsFile, {}), userId, bookId);
        return {
          status: 200,
          outcome: {
            success: true,
            ignored: true,
            reason: 'chapter-structure-changed',
            position: positionMatchesChapterStructure(existing, book) ? existing : null
          }
        };
      }

      let outcome;
      await updateJSON(positionsFile, (data) => {
        outcome = recordPosition(data, {
        userId,
        bookId,
        chapterIndex: mapped.state.chapterIndex,
        timestamp: mapped.state.timestamp,
        chunkIndex: mapped.state.chunkIndex,
        chunkTime: mapped.state.chunkTime,
        characterOffset: mapped.state.characterOffset,
        positionApproximate: mapped.state.positionApproximate,
        chapterStructureKey: book.chapterStructureKey || undefined,
        playbackRate,
        wasPlaying,
        finished,
        allowBackward,
        updatedAtMs: updatedAt
      });
        return outcome.ignored ? jsonStore.SKIP_SAVE : undefined;
      });
      return { status: 200, outcome, chapterIndex: mapped.state.chapterIndex };
    });
    if (write.status === 404) return res.status(404).json({ error: 'Book not found' });
    const outcome = write.outcome;
    const prefetchSessionId = `${userId}:${syncDeviceId(req)}`;
    if (!outcome.ignored && Boolean(wasPlaying) && !Boolean(finished)) {
      observePlaybackHorizon({
        bookId,
        chapterIndex: write.chapterIndex,
        sessionId: prefetchSessionId
      }).catch(error => {
        console.warn(`Playback look-ahead observation failed for ${bookId}: ${error.message}`);
      });
    } else if (!outcome.ignored) {
      playbackPrefetch.removeSession(prefetchSessionId).catch(error => {
        console.warn(`Playback look-ahead retirement failed for ${bookId}: ${error.message}`);
      });
    }
    res.json(outcome);
  } catch (err) {
    sendServerError(res, err, "Failed to save position");
  }
});

app.get('/api/position/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    if (!isSafeBookId(bookId)) {
      return res.status(400).json({ error: 'Invalid book identifier' });
    }
    const userId = userIdFor(req);
    const [positions, books] = await Promise.all([
      loadJSON(positionsFile, {}),
      loadJSON(booksFile, {})
    ]);
    const position = positionForBook(positions, userId, bookId);
    res.json({ position: positionMatchesChapterStructure(position, books[bookId]) ? position : null });
  } catch (err) {
    sendServerError(res, err, "Failed to load position");
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const userId = userIdFor(req);
    const [positions, books] = await Promise.all([loadJSON(positionsFile, {}), loadJSON(booksFile, {})]);
    const currentPositions = Object.fromEntries(Object.entries(positionsForUser(positions, userId))
      .filter(([bookId, position]) => positionMatchesChapterStructure(position, books[bookId])));
    res.json({ userId, positions: currentPositions });
  } catch (err) {
    sendServerError(res, err, "Failed to load positions");
  }
});

// Listening-history / stats surface. Auth-exempt like other GETs. Aggregates
// the current sync user's per-book positions against book metadata into
// hours-listened, finished/in-progress counts, and a recently-listened rail.
app.get('/api/stats', async (req, res) => {
  try {
    const userId = userIdFor(req);
    const books = await loadJSON(booksFile, {});
    const storedPositions = positionsForUser(await loadJSON(positionsFile, {}), userId);
    const currentPositions = Object.fromEntries(Object.entries(storedPositions)
      .filter(([bookId, position]) => positionMatchesChapterStructure(position, books[bookId])));
    const stats = computeListeningStats(books, currentPositions, { recentLimit: 5 });
    res.json({ userId, stats });
  } catch (err) {
    sendServerError(res, err, "Failed to load stats");
  }
});

app.post('/api/positions/batch', async (req, res) => {
  try {
    const bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds : [];
    if (bookIds.length > 500) {
      return res.status(400).json({ error: 'Too many book identifiers' });
    }
    const safeIds = [];
    for (const bookId of bookIds) {
      if (!isSafeBookId(bookId)) {
        return res.status(400).json({ error: 'Invalid book identifier' });
      }
      safeIds.push(bookId);
    }
    const userId = userIdFor(req);
    const [storedPositions, books] = await Promise.all([loadJSON(positionsFile, {}), loadJSON(booksFile, {})]);
    const positions = positionsForBooks(storedPositions, userId, safeIds);
    for (const bookId of safeIds) {
      if (!positionMatchesChapterStructure(positions[bookId], books[bookId])) positions[bookId] = null;
    }
    res.json({ userId, positions });
  } catch (err) {
    sendServerError(res, err, "Failed to load positions");
  }
});


}

module.exports = { registerSyncPositionRoutes };
