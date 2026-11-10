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
const { chapterTextIdentity } = require('../lib/chapter-reprocess');

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
  async function get() {
    const res = response();
    await routes.get('GET /api/position/:bookId')({ params: { bookId: 'book' }, headers: {}, query: {} }, res);
    return res;
  }
  return { dir, files, post, get, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
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

  // The same text under the same titles, cut at another place: "bbbb" moved
  // from chapter 0 to chapter 1 without changing the structure key.
  function remappedBook() {
    const previous = chapterTextIdentity([
      { text: 'aaaa bbbb', estimatedDuration: 100 }, { text: 'cccc', estimatedDuration: 100 }
    ], 'key-1');
    const next = chapterTextIdentity([
      { text: 'aaaa', estimatedDuration: 100 }, { text: 'bbbb cccc', estimatedDuration: 100 }
    ], 'key-1');
    return {
      id: 'book', chapterStructureKey: 'key-1', chapterCount: 2, chapterDurations: [100, 100], totalDuration: 200,
      chapterTextIdentity: next, textRemapId: 'remap-1',
      textRemap: { id: 'remap-1', fromId: '', previous, next }
    };
  }

  await test('a device-held write from before a same-key text remap is moved by that remap', async () => {
    const h = await harness();
    try {
      await jsonStore.save(h.files.books, { book: remappedBook() });
      // 90 s into old chapter 0 is inside "bbbb", which is now chapter 1.
      const res = await h.post({ chapterIndex: 0, timestamp: 90, chunkIndex: 3, chunkTime: 4 });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.ignored, undefined);
      const stored = (await jsonStore.load(h.files.positions, {})).users.reader.book;
      assert.strictEqual(stored.chapterIndex, 1, 'the write follows its text');
      assert.strictEqual(stored.textRemapId, 'remap-1', 'the stored record names the remap');
      assert.strictEqual(stored.chunkIndex, undefined, 'old chunk coordinates are dropped');
    } finally {
      await h.cleanup();
    }
  });

  await test('a write with no remap id from a pre-v231 client moves only when it predates the remap', async () => {
    const h = await harness();
    try {
      const remapAt = Date.now() - 60_000;
      const book = remappedBook();
      book.textRemap.at = remapAt;
      await jsonStore.save(h.files.books, { book });
      // Recorded after the remap: the old client already plays the new text.
      const after = await h.post({ chapterIndex: 0, timestamp: 90, updatedAt: Date.now() });
      assert.strictEqual(after.body.ignored, undefined);
      let stored = (await jsonStore.load(h.files.positions, {})).users.reader.book;
      assert.strictEqual(stored.chapterIndex, 0, 'a post-remap write is not moved a second time');
      assert.strictEqual(stored.timestamp, 90);
      assert.strictEqual(stored.textRemapId, 'remap-1');
      await jsonStore.save(h.files.positions, {});
      // Recorded before the remap: it names the old text and follows it.
      const before = await h.post({ chapterIndex: 0, timestamp: 90, updatedAt: remapAt - 1000 });
      assert.strictEqual(before.body.ignored, undefined);
      stored = (await jsonStore.load(h.files.positions, {})).users.reader.book;
      assert.strictEqual(stored.chapterIndex, 1, 'a pre-remap write follows its text');
    } finally {
      await h.cleanup();
    }
  });

  await test('a write under the current remap is stored as sent, and an unknown remap is refused', async () => {
    const h = await harness();
    try {
      await jsonStore.save(h.files.books, { book: remappedBook() });
      const current = await h.post({ chapterIndex: 0, timestamp: 30, textRemapId: 'remap-1' });
      assert.strictEqual(current.body.ignored, undefined);
      let stored = (await jsonStore.load(h.files.positions, {})).users.reader.book;
      assert.strictEqual(stored.chapterIndex, 0);
      assert.strictEqual(stored.timestamp, 30);
      const unknown = await h.post({ chapterIndex: 1, timestamp: 90, textRemapId: 'remap-0' });
      assert.strictEqual(unknown.body.ignored, true);
      stored = (await jsonStore.load(h.files.positions, {})).users.reader.book;
      assert.strictEqual(stored.chapterIndex, 0, 'a write against older text cannot be placed');
    } finally {
      await h.cleanup();
    }
  });

  await test('an unmoved position under a text remap is not served and does not order new writes', async () => {
    const h = await harness();
    try {
      await jsonStore.save(h.files.books, { book: remappedBook() });
      await jsonStore.save(h.files.positions, {
        users: { reader: { book: { chapterIndex: 1, timestamp: 90, chapterStructureKey: 'key-1', updatedAtMs: Date.now() } } }
      });
      assert.strictEqual((await h.get()).body.position, null);
      const res = await h.post({ chapterIndex: 0, timestamp: 10, textRemapId: 'remap-1' });
      assert.strictEqual(res.body.ignored, undefined, 'the unmoved record does not count as further ahead');
      assert.strictEqual((await h.get()).body.position.chapterIndex, 0);
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
