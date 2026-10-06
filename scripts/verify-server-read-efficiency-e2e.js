'use strict';

// Failure cases recorded before implementation:
// - unchanged detail reads acquire the whole-library writer lock and parse
//   books.json again even though there is no chapter state to reconcile;
// - cached cover reads acquire the same lock to persist an existing path;
// - a fast path must still stamp legacy structures, reset changed narration,
//   retry pending repairs, backfill covers, and preserve concurrent metadata;
// - shared-library responses must retain per-user shelf selection.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const jsonStore = require('../lib/json-store');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { createBookMetadataRefreshService } = require('../lib/book-metadata-refresh');
const { registerLibraryBookRoutes } = require('../lib/routes/library-book-routes');
const { chapterStructureKey } = require('../lib/chapter-structure');
const { createUserLibraryState } = require('../lib/user-library-state');
const shelves = require('../lib/shelves');

(async () => {
  const phase = process.env.SERVER_READ_PHASE || 'after';
  assert.match(phase, /^[a-z0-9-]{1,64}$/);
  const outputDir = path.resolve(__dirname, '../output/server-performance/storage');
  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-read-efficiency-'));
  const files = Object.fromEntries(['books', 'positions', 'shelves', 'transitions', 'bookmarks']
    .map(name => [name, path.join(tempDir, `${name}.json`)]));
  const bookId = 'fixture_book';
  const chapters = [{ index: 0, title: 'One', text: 'Stable narration.', estimatedDuration: 12 }];
  const structureKey = chapterStructureKey(chapters);
  const coverPath = path.join(tempDir, `${bookId}_cover.jpg`);
  const fixtureCover = Buffer.from('local-cover-fixture');
  const sourcePath = path.join(tempDir, 'chapters.json');
  await fs.writeFile(sourcePath, JSON.stringify(chapters));
  await fs.writeFile(coverPath, fixtureCover);
  const book = {
    id: bookId, title: 'Fixture Book', author: 'Fixture Author', path: sourcePath,
    addedBy: 'alice', coverPath, chapterStructureKey: structureKey,
    chapterCount: 1, totalDuration: 12, canRebuildChapters: true
  };
  const books = { [bookId]: book };
  for (let index = 0; index < 500; index++) {
    const id = `other_book_${index}`;
    books[id] = { ...book, id, title: `Book ${index}`, description: 'Fixture metadata. '.repeat(50) };
  }
  const criticalBooks = jsonStore.createCriticalStore({
    filePath: files.books, defaultValue: {}, validate: value => Boolean(value && typeof value === 'object')
  });
  await criticalBooks.save(books);
  const userState = createUserLibraryState();
  const positions = { users: {
    alice: { [bookId]: { chapterIndex: 0, timestamp: 5, chapterStructureKey: structureKey } },
    bob: { [bookId]: { chapterIndex: 0, timestamp: 8, chapterStructureKey: structureKey } }
  } };
  await Promise.all([
    jsonStore.save(files.positions, positions),
    jsonStore.save(files.shelves, { users: { alice: { books: { [bookId]: {} } }, bob: { books: { other_book_0: {} } } } }),
    jsonStore.save(files.transitions, {}),
    jsonStore.save(files.bookmarks, { users: {} })
  ]);
  let counters = null;
  let beforeBookUpdate = null;
  let beforeCoverPersist = null;
  const originalReadFile = fs.readFile;
  const originalOpen = fs.open;
  const originalLink = fs.link;
  fs.readFile = async function (file, ...args) {
    if (counters && file === files.books) counters.bookReads++;
    return originalReadFile.call(this, file, ...args);
  };
  fs.open = async function (file, ...args) {
    if (counters && String(file).startsWith(`${files.books}.lock`)) counters.lockFileOpens++;
    return originalOpen.call(this, file, ...args);
  };
  fs.link = async function (source, destination, ...args) {
    if (counters && destination === `${files.books}.lock`) counters.writerLockClaims++;
    return originalLink.call(this, source, destination, ...args);
  };
  const loadJSON = (file, fallback) => file === files.books ? criticalBooks.load() : jsonStore.load(file, fallback);
  const updateJSON = async (file, mutator, fallback) => {
    if (counters && file === files.books) counters.bookUpdateCalls++;
    if (file === files.books && beforeBookUpdate) {
      const hook = beforeBookUpdate;
      beforeBookUpdate = null;
      await hook();
    }
    return file === files.books ? criticalBooks.update(mutator) : jsonStore.update(file, mutator, fallback);
  };
  const locks = createBookMutationLocks();
  const audioRepairs = [];
  const service = createBookMetadataRefreshService({
    booksFile: files.books, positionsFile: files.positions,
    transitionsFile: files.transitions, bookmarksFile: files.bookmarks,
    cacheDir: tempDir, path, loadJSON, updateJSON, skipSave: jsonStore.SKIP_SAVE,
    chapterStructureKey,
    removeFileIfExists: file => fs.rm(file, { force: true }),
    invalidateBookAudio: async (id, count) => { audioRepairs.push({ id, count }); },
    removeBookPositions: userState.removeBookPositions,
    setBookPositionsStructureKey: userState.setBookPositionsStructureKey,
    withBookStateLock: locks.withBookStateLock,
    log: { warn() {} }
  });
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 500 }));
  app.use((req, _res, next) => {
    req.user = { id: req.headers['x-fixture-user'] || 'alice', role: 'admin' };
    next();
  });
  registerLibraryBookRoutes(app, {
    booksFile: files.books, shelvesFile: files.shelves, loadJSON, updateJSON, jsonStore, shelves,
    userIdFromRequest: req => req.user.id,
    publicBookRecord: value => value,
    publicBookRecordWithCoverArtifact: async value => ({ ...value, hasCover: Boolean(value.coverPath) }),
    bookMutationLocks: locks, bookMetadataRefreshService: service,
    chapterRebuildService: { recoverBook: async () => {}, canRebuild: async () => false },
    getChaptersCached: async file => JSON.parse(await fs.readFile(file, 'utf8')),
    normalizeChapterTitleForDisplay: value => value,
    canonicalBookCoverPath: () => coverPath,
    readValidatedLibraryCover: async file => {
      try { return { buffer: await fs.readFile(file), contentType: 'image/jpeg' }; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    shouldRefreshCachedCover: (_book, force) => force,
    removeFileIfExists: file => fs.rm(file, { force: true }),
    ensureBookCover: async () => { throw new Error('No network permitted in cached-cover fixture'); },
    persistCanonicalCoverPath: async (id, nextPath) => {
      if (beforeCoverPersist) { const hook = beforeCoverPersist; beforeCoverPersist = null; await hook(); }
      await updateJSON(files.books, current => {
        if (!current[id] || current[id].coverPath === nextPath) return jsonStore.SKIP_SAVE;
        current[id] = { ...current[id], coverPath: nextPath };
      });
    },
    coverRefreshGate: { tryAcquire: () => () => {} },
    coverRefreshRateLimit: (_req, _res, next) => next(),
    sendServerError: (res, error) => res.status(500).json({ error: error.message })
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (pathname, user = 'alice') => {
    const response = await fetch(`${origin}${pathname}`, {
      headers: { 'x-fixture-user': user }, signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200, `${pathname} must succeed`);
    return pathname.startsWith('/api/cover/') ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  const evidence = { phase, fixture: { books: Object.keys(books).length, bytes: (await fs.stat(files.books)).size }, checks: [], benchmarks: [] };
  try {
    async function measure(label, pathname, count, maxReads) {
      await get(pathname); // Warm local HTTP connection and filesystem cache.
      counters = { bookReads: 0, bookUpdateCalls: 0, lockFileOpens: 0, writerLockClaims: 0 };
      const samples = [];
      for (let index = 0; index < count; index++) {
        const start = performance.now();
        const response = await get(pathname);
        samples.push(performance.now() - start);
        if (pathname.startsWith('/api/cover/')) assert.deepEqual(response, fixtureCover);
        else assert.equal(response.book.chapterStructureKey, structureKey);
      }
      samples.sort((a, b) => a - b);
      const metrics = { label, requests: count, ...counters, p50Ms: samples[Math.floor(count * 0.5)], p95Ms: samples[Math.floor(count * 0.95)] };
      counters = null;
      evidence.benchmarks.push(metrics);
      evidence.checks.push({ name: `${label}: reads do not claim writer locks`, passed: metrics.writerLockClaims === 0 && metrics.bookUpdateCalls === 0 });
      evidence.checks.push({ name: `${label}: bounded full-library reads`, passed: metrics.bookReads <= count * maxReads });
    }
    await measure('unchanged details', `/api/book/${bookId}`, 30, 2);
    await measure('cached cover', `/api/cover/${bookId}`, 30, 1);
    assert.deepEqual(await jsonStore.load(files.positions), positions);

    await criticalBooks.update(current => { delete current[bookId].chapterStructureKey; });
    beforeBookUpdate = () => criticalBooks.update(current => { current[bookId].title = 'Concurrent metadata'; });
    const stamped = await get(`/api/book/${bookId}`);
    assert.equal(stamped.book.chapterStructureKey, structureKey);
    assert.equal((await criticalBooks.load())[bookId].title, 'Concurrent metadata');
    assert.equal((await jsonStore.load(files.positions)).users.bob[bookId].timestamp, 8);
    evidence.checks.push({ name: 'legacy structure stamping preserves positions and concurrent metadata', passed: true });

    await criticalBooks.update(current => {
      current[bookId].metadataRefreshReconciliation = { audio: { chapterCount: 1 }, positions: { type: 'stamp', structureKey } };
    });
    await get(`/api/book/${bookId}`);
    assert.equal(audioRepairs.length, 1);
    assert.equal((await criticalBooks.load())[bookId].metadataRefreshReconciliation, undefined);
    evidence.checks.push({ name: 'matching structure still completes pending audio and position repairs', passed: true });

    const changed = [{ ...chapters[0], text: 'Replacement narration with new boundaries.' }, { index: 1, title: 'Two', text: 'New second chapter.', estimatedDuration: 9 }];
    await fs.writeFile(sourcePath, JSON.stringify(changed));
    const reset = await get(`/api/book/${bookId}`);
    assert.equal(reset.book.chapterStructureKey, chapterStructureKey(changed));
    assert.equal(reset.book.chapterCount, 2);
    const resetPositions = await jsonStore.load(files.positions);
    assert.equal(resetPositions.users.alice[bookId], undefined);
    assert.equal(resetPositions.users.bob[bookId], undefined);
    assert.equal(audioRepairs.at(-1).count, 2);
    evidence.checks.push({ name: 'changed narration reconciles stored key, chapter count, audio and all user positions', passed: true });

    for (const oldPath of [undefined, path.join(tempDir, 'legacy-cover.jpg')]) {
      await criticalBooks.update(current => { current[bookId].coverPath = oldPath; });
      beforeCoverPersist = () => criticalBooks.update(current => { current[bookId].title = 'Concurrent cover metadata'; });
      assert.deepEqual(await get(`/api/cover/${bookId}`), fixtureCover);
      const current = (await criticalBooks.load())[bookId];
      assert.equal(current.coverPath, coverPath);
      assert.equal(current.title, 'Concurrent cover metadata');
    }
    evidence.checks.push({ name: 'missing and noncanonical paths backfill without overwriting concurrent metadata', passed: true });
    const aliceLibrary = await get('/api/library');
    const bobLibrary = await get('/api/library', 'bob');
    assert.deepEqual(aliceLibrary.shelf, [bookId]);
    assert.deepEqual(bobLibrary.shelf, ['other_book_0']);
    assert.equal(aliceLibrary.books.length, 501);
    assert.equal(bobLibrary.books.length, 501);
    evidence.checks.push({ name: 'shared library and per-user shelves preserved', passed: true });
  } catch (error) {
    evidence.checks.push({ name: 'scenario completion', passed: false, error: error.stack });
  } finally {
    fs.readFile = originalReadFile;
    fs.open = originalOpen;
    fs.link = originalLink;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    evidence.passed = evidence.checks.every(check => check.passed);
    const receipt = path.join(outputDir, `${phase}.json`);
    await fs.writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n');
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(JSON.stringify({ receipt, ...evidence }, null, 2));
    if (!evidence.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
