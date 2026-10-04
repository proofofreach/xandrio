'use strict';

// Failure modes recorded before implementation: a newer automatic checkpoint
// moves back exactly one chapter; a delayed explicit rewind overwrites newer
// listening progress. Verify intentional current rewinds, jitter, forward
// progress, independent accounts, and durable reads through real HTTP routes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const jsonStore = require('../lib/json-store');
const { createUserLibraryState } = require('../lib/user-library-state');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { positionMatchesChapterStructure } = require('../lib/chapter-structure');
const { mapStateWriteToCurrent } = require('../lib/chapter-transition-state');
const { registerSyncPositionRoutes } = require('../lib/routes/sync-position-routes');

(async () => {
  const output = path.resolve(__dirname, '../output/deep-reliability/positions');
  await fs.mkdir(output, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-position-conflicts-'));
  const booksFile = path.join(dir, 'books.json');
  const positionsFile = path.join(dir, 'positions.json');
  await jsonStore.save(booksFile, { book: { id: 'book', chapterCount: 10, chapterStructureKey: 'structure-1' } });
  const state = createUserLibraryState();
  const app = express();
  app.use(express.json());
  registerSyncPositionRoutes(app, {
    ...state, booksFile, positionsFile,
    usersFile: path.join(dir, 'users.json'), listeningQueueFile: path.join(dir, 'queue.json'),
    transitionsFile: path.join(dir, 'transitions.json'),
    loadJSON: jsonStore.load, updateJSON: jsonStore.update, jsonStore,
    bookMutationLocks: createBookMutationLocks(),
    userIdFromRequest: state.userIdFromRequest, syncDeviceId: state.deviceIdFromRequest,
    positionMatchesChapterStructure, mapStateWriteToCurrent,
    observePlaybackHorizon: async () => {}, playbackPrefetch: { removeSession: async () => {} },
    sendServerError: (res, error) => res.status(500).json({ error: error.message })
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const initialTime = Date.now() - 10000;
  const results = [];
  async function post(payload, user = 'alice') {
    const response = await fetch(`${origin}/api/position`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xandrio-User-Id': user },
      body: JSON.stringify({ bookId: 'book', chapterStructureKey: 'structure-1', wasPlaying: true, ...payload }),
      signal: AbortSignal.timeout(3000)
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function reset() { await jsonStore.save(positionsFile, {}); }
  try {
    await post({ chapterIndex: 4, timestamp: 10, updatedAt: initialTime });
    const previousChapter = await post({ chapterIndex: 3, timestamp: 200, updatedAt: initialTime + 1000 });
    results.push({ name: 'Automatic progress cannot regress by one chapter', passed: previousChapter.ignored === true && previousChapter.position.chapterIndex === 4, evidence: previousChapter });

    await reset();
    await post({ chapterIndex: 4, timestamp: 10, updatedAt: initialTime + 2000 });
    const staleRewind = await post({ chapterIndex: 1, timestamp: 0, updatedAt: initialTime, allowBackward: true });
    results.push({ name: 'A delayed explicit rewind cannot overwrite newer progress', passed: staleRewind.ignored === true && staleRewind.position.chapterIndex === 4, evidence: staleRewind });

    const deliberateRewind = await post({ chapterIndex: 1, timestamp: 30, updatedAt: initialTime + 3000, allowBackward: true });
    results.push({ name: 'A current explicit rewind still saves', passed: !deliberateRewind.ignored && deliberateRewind.position.chapterIndex === 1 });
    const jitter = await post({ chapterIndex: 1, timestamp: 29.5, updatedAt: initialTime + 4000 });
    results.push({ name: 'Subsecond checkpoint jitter remains accepted', passed: !jitter.ignored && jitter.position.timestamp === 29.5 });
    const backward = await post({ chapterIndex: 1, timestamp: 20, updatedAt: initialTime + 5000 });
    results.push({ name: 'An automatic same-chapter rewind remains ignored', passed: backward.ignored === true && backward.position.timestamp === 29.5 });
    const forward = await post({ chapterIndex: 2, timestamp: 0, updatedAt: initialTime + 6000 });
    const bob = await post({ chapterIndex: 0, timestamp: 2, updatedAt: initialTime + 1000 }, 'bob');
    const persisted = await jsonStore.load(positionsFile);
    const response = await fetch(`${origin}/api/position/book`, { headers: { 'X-Xandrio-User-Id': 'alice' } });
    const read = await response.json();
    results.push({ name: 'Forward progress persists and accounts stay independent',
      passed: !forward.ignored && !bob.ignored && persisted.users.alice.book.chapterIndex === 2 && persisted.users.bob.book.chapterIndex === 0 && read.position.chapterIndex === 2 });
    await fs.writeFile(path.join(output, `${process.env.POSITION_AUDIT_PHASE || 'verification'}.json`), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
    assert(results.every(result => result.passed), 'Position conflict verification failed');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
