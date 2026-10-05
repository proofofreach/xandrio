'use strict';

// Failure modes recorded before implementation:
// - a shelf write that already observed a book can land after deletion and
//   silently restore membership when the same id is imported again;
// - a listening-queue write can do the same;
// - a book playback setting can survive deletion and appear after reimport;
// - a malformed whole-queue replacement can normalize to an empty queue and
//   erase the user's valid queue instead of returning a client error.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const jsonStore = require('../lib/json-store');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { createBookDeletionService, DELETE_BOOK_RESULT } = require('../lib/book-deletion');
const { removeBookBookmarks } = require('../lib/routes/bookmarks-routes');
const { registerLibraryBookRoutes } = require('../lib/routes/library-book-routes');
const { registerListeningQueueRoutes } = require('../lib/routes/listening-queue-routes');
const { createUserLibraryState } = require('../lib/user-library-state');
const shelves = require('../lib/shelves');
const { removeBookFromAllQueues } = require('../lib/listening-queue');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const outputDir = path.resolve(__dirname, '../output/general-reliability/server');
  const phase = process.env.LIBRARY_DATA_PHASE || 'after';
  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-library-lifecycle-'));
  const files = {
    books: path.join(tempDir, 'books.json'),
    positions: path.join(tempDir, 'positions.json'),
    bookmarks: path.join(tempDir, 'bookmarks.json'),
    shelves: path.join(tempDir, 'shelves.json'),
    queues: path.join(tempDir, 'listening-queues.json')
  };
  const shelfBookId = 'shelf_race_book';
  const queueBookId = 'queue_race_book';
  const bulkBookId = 'bulk_queue_race_book';
  const settingsBookId = 'settings_race_book';
  const unrelatedBookId = 'unrelated_book';
  const books = {
    [shelfBookId]: { id: shelfBookId, title: 'Shelf Race Book', author: 'Fixture Author', addedBy: 'alice' },
    [queueBookId]: { id: queueBookId, title: 'Queue Race Book', author: 'Fixture Author', addedBy: 'alice' },
    [bulkBookId]: { id: bulkBookId, title: 'Bulk Queue Race Book', author: 'Fixture Author', addedBy: 'alice' },
    [settingsBookId]: { id: settingsBookId, title: 'Settings Race Book', author: 'Fixture Author', addedBy: 'alice' },
    [unrelatedBookId]: { id: unrelatedBookId, title: 'Unrelated Book', author: 'Fixture Author', addedBy: 'alice' }
  };
  const locks = createBookMutationLocks();
  const userState = createUserLibraryState();
  const firstRelease = deferred();
  let shelfGate = { reached: deferred(), release: firstRelease.promise };
  let queueGate = { reached: deferred(), release: firstRelease.promise };

  await Promise.all([
    jsonStore.save(files.books, books),
    jsonStore.save(files.positions, { users: { alice: {
      [shelfBookId]: { chapterIndex: 1, timestamp: 2 },
      [queueBookId]: { chapterIndex: 1, timestamp: 2 }
    } } }),
    jsonStore.save(files.bookmarks, { users: { alice: {
      [shelfBookId]: [{ id: 'bm_shelf_fixture' }],
      [queueBookId]: [{ id: 'bm_queue_fixture' }]
    } } }),
    jsonStore.save(files.shelves, { users: { alice: { books: {} } } }),
    jsonStore.save(files.queues, { users: { alice: { bookIds: [], autoContinue: true, bookSettings: {} } } })
  ]);

  const updateJSON = async (file, mutator) => {
    if (file === files.shelves && shelfGate) {
      const gate = shelfGate;
      shelfGate = null;
      gate.reached.resolve();
      await gate.release;
    }
    if (file === files.queues && queueGate) {
      const gate = queueGate;
      queueGate = null;
      gate.reached.resolve();
      await gate.release;
    }
    return jsonStore.update(file, mutator);
  };

  const deletionService = createBookDeletionService({
    booksFile: files.books,
    positionsFile: files.positions,
    bookmarksFile: files.bookmarks,
    shelvesFile: files.shelves,
    listeningQueueFile: files.queues,
    updateJSON,
    skipSave: jsonStore.SKIP_SAVE,
    rememberDeletedBookId: () => {},
    cancelBookJobs: async () => 0,
    stopPremiumPrep: async () => {},
    cleanupBookArtifacts: async () => ({ deleted: [], failed: [] }),
    scheduleArtifactSweeps: () => {},
    removeBookPositions: userState.removeBookPositions,
    removeBookBookmarks,
    removeBookFromAllShelves: shelves.removeBookFromAllShelves,
    removeBookFromAllQueues
  });

  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 200 }));
  app.use(express.json({ limit: '16kb' }));
  app.use((req, _res, next) => {
    req.user = { id: req.headers['x-xandrio-user-id'] || 'alice', role: req.headers['x-fixture-role'] || 'admin' };
    next();
  });

  registerLibraryBookRoutes(app, {
    booksFile: files.books,
    shelvesFile: files.shelves,
    loadJSON: jsonStore.load,
    updateJSON,
    jsonStore,
    shelves,
    userIdFromRequest: userState.userIdFromRequest,
    publicBookRecord: value => value,
    publicBookRecordWithCoverArtifact: async value => value,
    bookMutationLocks: locks,
    bookDeletionService: deletionService,
    DELETE_BOOK_RESULT,
    bookMetadataRefreshService: { refreshBook: async () => ({ status: 'not_found' }), reconcileChapterStructure: async () => null },
    REFRESH_BOOK_RESULT: { NOT_FOUND: 'not_found' },
    chapterRebuildService: { recoverBook: async () => {}, rebuild: async () => ({ reason: 'book-not-found' }), canRebuild: async () => false },
    getChaptersCached: async () => [],
    normalizeChapterTitleForDisplay: value => value,
    canonicalBookCoverPath: id => path.join(tempDir, `${id}_cover.jpg`),
    readValidatedLibraryCover: async () => null,
    shouldRefreshCachedCover: () => false,
    removeFileIfExists: async () => {},
    ensureBookCover: async () => null,
    persistCanonicalCoverPath: async () => {},
    coverRefreshGate: { tryAcquire: () => () => {} },
    coverRefreshRateLimit: (_req, _res, next) => next(),
    sendServerError: (res, error, message) => res.status(500).json({ error: message, detail: error.message })
  });
  registerListeningQueueRoutes(app, {
    listeningQueueFile: files.queues,
    booksFile: files.books,
    positionsFile: files.positions,
    loadJSON: jsonStore.load,
    updateJSON,
    withBookStateLock: locks.withBookStateLock
  });

  const server = await listen(app);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-xandrio-user-id': 'alice' };
  const request = async (method, pathname, body) => {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000)
    });
    const payload = await response.json();
    return { status: response.status, body: payload };
  };

  const evidence = { phase, checks: [] };
  try {
    const shelfReached = shelfGate.reached.promise;
    const queueReached = queueGate.reached.promise;
    const shelfWrite = request('POST', `/api/shelf/${shelfBookId}`, {});
    const queueWrite = request('POST', '/api/listening-queue/items', { bookId: queueBookId });
    await Promise.all([shelfReached, queueReached]);

    const unrelatedWrite = await request('POST', '/api/listening-queue/items', { bookId: unrelatedBookId });

    let shelfDeleteCompletedBeforeRelease = false;
    let queueDeleteCompletedBeforeRelease = false;
    const shelfDeletion = request('DELETE', `/api/book/${shelfBookId}`)
      .then(result => {
        shelfDeleteCompletedBeforeRelease = true;
        return result;
      });
    const queueDeletion = request('DELETE', `/api/book/${queueBookId}`)
      .then(result => {
        queueDeleteCompletedBeforeRelease = true;
        return result;
      });
    await new Promise(resolve => setTimeout(resolve, 150));
    const observedShelfDeleteBeforeRelease = shelfDeleteCompletedBeforeRelease;
    const observedQueueDeleteBeforeRelease = queueDeleteCompletedBeforeRelease;
    firstRelease.resolve();
    const [shelfResponse, queueResponse, shelfDeleteResponse, queueDeleteResponse] = await Promise.all([
      shelfWrite,
      queueWrite,
      shelfDeletion,
      queueDeletion
    ]);

    const rawShelves = await jsonStore.load(files.shelves, {});
    const rawQueues = await jsonStore.load(files.queues, {});
    const staleShelf = Boolean(rawShelves.users?.alice?.books?.[shelfBookId]);
    const staleQueue = rawQueues.users?.alice?.bookIds?.includes(queueBookId) === true;
    const unrelatedPreserved = rawQueues.users?.alice?.bookIds?.includes(unrelatedBookId) === true;

    await jsonStore.save(files.books, {
      ...books,
      kept: { id: 'kept', title: 'Kept Book', author: 'Fixture Author', addedBy: 'alice' }
    });
    const [libraryAfterReimport, queueAfterReimport] = await Promise.all([
      request('GET', '/api/library'),
      request('GET', '/api/listening-queue')
    ]);
    const resurrectedShelf = libraryAfterReimport.body.shelf?.includes(shelfBookId) === true;
    const resurrectedQueue = queueAfterReimport.body.queue?.bookIds?.includes(queueBookId) === true;
    evidence.checks.push({
      name: 'Delete serializes shelf and queue writes',
      passed: !observedShelfDeleteBeforeRelease && !observedQueueDeleteBeforeRelease &&
        !staleShelf && !staleQueue && !resurrectedShelf && !resurrectedQueue && unrelatedPreserved,
      observedShelfDeleteBeforeRelease,
      observedQueueDeleteBeforeRelease,
      staleShelf,
      staleQueue,
      resurrectedShelf,
      resurrectedQueue,
      unrelatedPreserved,
      responses: {
        shelf: shelfResponse.status,
        queue: queueResponse.status,
        unrelatedQueue: unrelatedWrite.status,
        shelfDeletion: shelfDeleteResponse.status,
        queueDeletion: queueDeleteResponse.status
      }
    });

    await jsonStore.save(files.queues, {
      users: { alice: { bookIds: ['kept'], autoContinue: true, bookSettings: {} } }
    });
    const malformed = await request('PUT', '/api/listening-queue', { queue: 'not-an-object' });
    const queueAfterMalformed = await jsonStore.load(files.queues, {});
    const retained = queueAfterMalformed.users?.alice?.bookIds?.includes('kept') === true;
    evidence.checks.push({
      name: 'Malformed queue replacement is rejected without data loss',
      passed: malformed.status === 400 && retained,
      status: malformed.status,
      retained,
      response: malformed.body
    });

    const bulkRelease = deferred();
    const bulkReached = deferred();
    queueGate = { reached: bulkReached, release: bulkRelease.promise };
    const bulkWrite = request('PUT', '/api/listening-queue', {
      queue: { bookIds: [bulkBookId, 'kept'], autoContinue: true }
    });
    await bulkReached.promise;
    let bulkDeleteCompletedBeforeRelease = false;
    const bulkDeletion = request('DELETE', `/api/book/${bulkBookId}`)
      .then(result => {
        bulkDeleteCompletedBeforeRelease = true;
        return result;
      });
    await new Promise(resolve => setTimeout(resolve, 150));
    const observedBulkDeleteBeforeRelease = bulkDeleteCompletedBeforeRelease;
    bulkRelease.resolve();
    const [bulkWriteResponse, bulkDeleteResponse] = await Promise.all([bulkWrite, bulkDeletion]);
    const queueAfterBulkDelete = await jsonStore.load(files.queues, {});
    const staleBulkQueue = queueAfterBulkDelete.users?.alice?.bookIds?.includes(bulkBookId) === true;
    const bulkUnrelatedPreserved = queueAfterBulkDelete.users?.alice?.bookIds?.includes('kept') === true;
    await jsonStore.update(files.books, catalog => {
      catalog[bulkBookId] = books[bulkBookId];
    });
    const bulkQueueAfterReimport = await request('GET', '/api/listening-queue');
    const resurrectedBulkQueue = bulkQueueAfterReimport.body.queue?.bookIds?.includes(bulkBookId) === true;
    evidence.checks.push({
      name: 'Bulk queue replacement serializes with deletion',
      passed: !observedBulkDeleteBeforeRelease && !staleBulkQueue && !resurrectedBulkQueue && bulkUnrelatedPreserved,
      observedBulkDeleteBeforeRelease,
      staleBulkQueue,
      resurrectedBulkQueue,
      unrelatedPreserved: bulkUnrelatedPreserved,
      responses: { bulkWrite: bulkWriteResponse.status, deletion: bulkDeleteResponse.status }
    });

    const settingsRelease = deferred();
    const settingsReached = deferred();
    queueGate = { reached: settingsReached, release: settingsRelease.promise };
    const settingsWrite = request('PUT', `/api/listening-queue/books/${settingsBookId}/settings`, {
      settings: { playbackSpeed: 1.5 }
    });
    await settingsReached.promise;
    let settingsDeleteCompletedBeforeRelease = false;
    const settingsDeletion = request('DELETE', `/api/book/${settingsBookId}`)
      .then(result => {
        settingsDeleteCompletedBeforeRelease = true;
        return result;
      });
    await new Promise(resolve => setTimeout(resolve, 150));
    const observedSettingsDeleteBeforeRelease = settingsDeleteCompletedBeforeRelease;
    settingsRelease.resolve();
    const [settingsWriteResponse, settingsDeleteResponse] = await Promise.all([settingsWrite, settingsDeletion]);
    const queueAfterSettingsDelete = await jsonStore.load(files.queues, {});
    const staleSettings = Object.hasOwn(queueAfterSettingsDelete.users?.alice?.bookSettings || {}, settingsBookId);
    await jsonStore.update(files.books, catalog => {
      catalog[settingsBookId] = books[settingsBookId];
    });
    const settingsAfterReimport = await request('GET', `/api/listening-queue/books/${settingsBookId}/settings`);
    const resurrectedSettings = Object.keys(settingsAfterReimport.body.settings || {}).length > 0;
    evidence.checks.push({
      name: 'Book playback settings serialize with deletion',
      passed: !observedSettingsDeleteBeforeRelease && !staleSettings && !resurrectedSettings &&
        settingsWriteResponse.status === 200 && settingsDeleteResponse.status === 200 && settingsAfterReimport.status === 200,
      observedSettingsDeleteBeforeRelease,
      staleSettings,
      resurrectedSettings,
      responses: {
        settingsWrite: settingsWriteResponse.status,
        deletion: settingsDeleteResponse.status,
        afterReimport: settingsAfterReimport.status
      }
    });

    evidence.passed = evidence.checks.every(check => check.passed);
    await fs.writeFile(path.join(outputDir, `${phase}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
    assert.equal(evidence.passed, true, 'Library data lifecycle verification failed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
