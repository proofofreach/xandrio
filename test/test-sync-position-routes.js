const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jsonStore = require('../lib/json-store');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { createUserLibraryState } = require('../lib/user-library-state');
const { positionMatchesChapterStructure } = require('../lib/chapter-structure');
const { mapStateWriteToCurrent } = require('../lib/chapter-transition-state');
const { registerSyncPositionRoutes } = require('../lib/routes/sync-position-routes');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-position-route-'));
  const files = {
    books: path.join(dir, 'books.json'),
    positions: path.join(dir, 'positions.json'),
    transitions: path.join(dir, 'transitions.json')
  };
  await Promise.all([
    jsonStore.save(files.books, {
      book: { id: 'book', chapterStructureKey: 'key-1', chapterCount: 3, chapterDurations: [600, 600, 600], totalDuration: 1800 }
    }),
    jsonStore.save(files.positions, {}),
    jsonStore.save(files.transitions, {})
  ]);
  const routes = new Map();
  const app = {
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); }
  };
  const state = createUserLibraryState();
  registerSyncPositionRoutes(app, {
    booksFile: files.books,
    positionsFile: files.positions,
    transitionsFile: files.transitions,
    loadJSON: jsonStore.load,
    updateJSON: jsonStore.update,
    jsonStore,
    bookMutationLocks: createBookMutationLocks(),
    userIdFromRequest: () => 'reader',
    syncDeviceId: () => 'device',
    recordPosition: state.recordPosition,
    positionForBook: state.positionForBook,
    positionsForUser: state.positionsForUser,
    positionsForBooks: state.positionsForBooks,
    positionMatchesChapterStructure,
    mapStateWriteToCurrent,
    observePlaybackHorizon: async () => undefined,
    playbackPrefetch: { removeSession: async () => undefined },
    sendServerError: (res, error) => { throw error; }
  });
  async function post(body) {
    const res = response();
    await routes.get('POST /api/position')({
      body: { bookId: 'book', chapterStructureKey: 'key-1', ...body },
      headers: {},
      query: {}
    }, res);
    return res;
  }
  return { dir, files, post, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

(async () => {
  await test('a position past the book is rejected and cannot freeze forward progress', async () => {
    const h = await harness();
    try {
      for (const body of [
        { chapterIndex: 999, timestamp: 0 },
        { chapterIndex: 3, timestamp: 0 },
        { chapterIndex: '1e300', timestamp: 0 },
        { chapterIndex: 1, timestamp: 600000 }
      ]) {
        const res = await h.post(body);
        assert.strictEqual(res.statusCode, 400, `${JSON.stringify(body)} is rejected`);
      }
      assert.deepStrictEqual(await jsonStore.load(h.files.positions, {}), {}, 'nothing was stored');
      const forward = await h.post({ chapterIndex: 1, timestamp: 30 });
      assert.strictEqual(forward.statusCode, 200);
      assert.strictEqual(forward.body.ignored, undefined);
      assert.strictEqual(forward.body.position.chapterIndex, 1);
    } finally {
      await h.cleanup();
    }
  });

  await test('a stale position from an earlier structure does not block current progress', async () => {
    const h = await harness();
    try {
      // A rebuild could not map this record, so it kept its old structure key.
      await jsonStore.save(h.files.positions, {
        users: { reader: { book: { chapterIndex: 2, timestamp: 500, chapterStructureKey: 'key-0', updatedAtMs: Date.now() } } }
      });
      const res = await h.post({ chapterIndex: 0, timestamp: 20 });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.ignored, undefined);
      const stored = (await jsonStore.load(h.files.positions, {})).users.reader.book;
      assert.strictEqual(stored.chapterIndex, 0);
      assert.strictEqual(stored.chapterStructureKey, 'key-1');
    } finally {
      await h.cleanup();
    }
  });

  console.log(`sync-position-routes tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exit(1);
});
