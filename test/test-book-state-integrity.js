/**
 * Book lifecycle data-integrity tests.
 *
 * A deleted book must leave nothing behind (files, per-book settings,
 * pronunciation rules, chapter transitions), even when its deletion was
 * interrupted or a cleanup step failed, and a profile migration must move
 * every per-user store without dropping either side's data.
 * Run: node test/test-book-state-integrity.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
  DELETE_BOOK_RESULT,
  createBookArtifactCleaner,
  createBookDeletionService,
  loadCatalogStrict
} = require('../lib/book-deletion');
const { createUserLibraryState, USER_DATA_STORES } = require('../lib/user-library-state');
const { removeBookRules, referencedRuleBooks } = require('../lib/pronunciation-repair');
const shelves = require('../lib/shelves');
const listeningQueue = require('../lib/listening-queue');
const { removeBookBookmarks } = require('../lib/routes/bookmarks-routes');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

const quiet = { log() {}, warn() {}, error() {} };
const state = createUserLibraryState();

function memoryStore(files) {
  const skipSave = Symbol('skip');
  const saved = [];
  return {
    skipSave,
    saved,
    files,
    async updateJSON(file, mutator) {
      const working = structuredClone(files[file] ?? {});
      const result = await mutator(working);
      if (result !== skipSave) {
        files[file] = working;
        saved.push(file);
      }
      return result;
    }
  };
}

function perBookStores() {
  return [
    {
      store: 'bookNarration',
      file: 'settings',
      referenced: settings => new Set(Object.keys(settings?.bookNarration || {})),
      remove: (settings, bookId) => { if (settings.bookNarration) delete settings.bookNarration[bookId]; }
    },
    { store: 'pronunciations', file: 'pronunciations', referenced: referencedRuleBooks, remove: removeBookRules },
    {
      store: 'chapterTransitions',
      file: 'transitions',
      referenced: transitions => new Set(Object.keys(transitions || {})),
      remove: (transitions, bookId) => { delete transitions[bookId]; }
    }
  ];
}

function service(store, overrides = {}) {
  return createBookDeletionService({
    booksFile: 'books',
    positionsFile: 'positions',
    bookmarksFile: 'bookmarks',
    shelvesFile: 'shelves',
    listeningQueueFile: 'queues',
    updateJSON: store.updateJSON,
    skipSave: store.skipSave,
    rememberDeletedBookId: () => ({}),
    cancelBookJobs: async () => 0,
    stopPremiumPrep: async () => {},
    cleanupBookArtifacts: async () => ({ deleted: [], failed: [] }),
    scheduleArtifactSweeps: () => {},
    removeBookPositions: (positions, bookId) => state.removeBookPositions(positions, bookId),
    removeBookBookmarks,
    removeBookFromAllShelves: shelves.removeBookFromAllShelves,
    removeBookFromAllQueues: listeningQueue.removeBookFromAllQueues,
    bookStateStores: perBookStores(),
    log: quiet,
    ...overrides
  });
}

function libraryFiles(books) {
  return {
    books,
    positions: { users: { alice: { gone: { chapterIndex: 1 } } } },
    bookmarks: { users: { alice: { gone: [{ id: 'm1' }] } } },
    shelves: { users: { alice: { books: { gone: { addedAt: 'x' } } } } },
    queues: { users: { alice: { bookIds: ['gone'], bookSettings: {} } } },
    settings: { voice: 'kokoro:af_heart', bookNarration: { gone: { voiceId: 'chatterbox:old', fallbackPolicy: 'wait' } } },
    pronunciations: { version: 1, global: [], books: { gone: [{ id: 'pron_1', source: 'Kant', replacement: 'Kahnt' }] } },
    transitions: { gone: { previousStructureKey: 'a', nextStructureKey: 'b' } }
  };
}

function assertNoTraceOf(files, bookId) {
  assert.strictEqual(files.positions.users.alice[bookId], undefined, 'positions');
  assert.strictEqual(files.bookmarks.users.alice[bookId], undefined, 'bookmarks');
  assert.strictEqual(files.shelves.users.alice.books[bookId], undefined, 'shelves');
  assert(!files.queues.users.alice.bookIds.includes(bookId), 'queue');
  assert.strictEqual(files.settings.bookNarration[bookId], undefined, 'book narrator pin');
  assert.strictEqual(files.pronunciations.books[bookId], undefined, 'pronunciation rules');
  assert.strictEqual(files.transitions[bookId], undefined, 'chapter transitions');
}

(async () => {
  console.log('\n--- Book state integrity ---');

  await test('deletion removes per-book narrator, pronunciation and transition state', async () => {
    const store = memoryStore(libraryFiles({ gone: { id: 'gone', addedBy: 'alice' } }));
    const result = await service(store).deleteBook({ bookId: 'gone', actor: { role: 'admin' } });
    assert.strictEqual(result.status, DELETE_BOOK_RESULT.DELETED);
    assertNoTraceOf(store.files, 'gone');
    assert.strictEqual(store.files.settings.voice, 'kokoro:af_heart', 'other settings survive');
  });

  await test('a failing cleanup step does not abort the remaining steps', async () => {
    const store = memoryStore(libraryFiles({ gone: { id: 'gone' } }));
    const cleaned = [];
    const result = await service(store, {
      cancelBookJobs: async () => { throw new Error('guide cancel failed'); },
      stopPremiumPrep: async () => { throw new Error('premium stop failed'); },
      cleanupBookArtifacts: async bookId => { cleaned.push(bookId); return { deleted: ['x'], failed: [] }; }
    }).deleteBook({ bookId: 'gone', actor: { role: 'admin' } });
    assert.strictEqual(result.status, DELETE_BOOK_RESULT.DELETED);
    assert.deepStrictEqual(cleaned, ['gone'], 'artifacts are still removed');
    assertNoTraceOf(store.files, 'gone');
    assert.deepStrictEqual(result.cleanupErrors.map(item => item.step), ['jobs', 'premiumPrep']);
  });

  await test('retrying the delete of a committed deletion finishes its cleanup instead of NOT_FOUND', async () => {
    const store = memoryStore(libraryFiles({ kept: { id: 'kept' } }));
    const cleaned = [];
    const result = await service(store, {
      isDeletionCommitted: async bookId => bookId === 'gone',
      cleanupBookArtifacts: async bookId => { cleaned.push(bookId); return { deleted: [], failed: [] }; }
    }).deleteBook({ bookId: 'gone', actor: { id: 'someone', role: 'member' } });
    assert.strictEqual(result.status, DELETE_BOOK_RESULT.DELETED);
    assert.strictEqual(result.resumed, true);
    assert.deepStrictEqual(cleaned, ['gone']);
    assertNoTraceOf(store.files, 'gone');
  });

  await test('a delete of an id that was never deleted is still NOT_FOUND and touches nothing', async () => {
    const store = memoryStore(libraryFiles({ kept: { id: 'kept' } }));
    const result = await service(store, { isDeletionCommitted: async () => false })
      .deleteBook({ bookId: 'gone', actor: { role: 'admin' } });
    assert.deepStrictEqual(result, { status: DELETE_BOOK_RESULT.NOT_FOUND });
    assert.deepStrictEqual(store.saved, []);
  });

  await test('startup reconcile drops orphaned per-book state, also when the last book is gone', async () => {
    const store = memoryStore(libraryFiles({}));
    store.files.settings.bookNarration.kept = { voiceId: 'kokoro:af_heart' };
    const result = await service(store).reconcileLibraryState({ loadBooks: async () => ({ kept: {} }) });
    assert.deepStrictEqual(result.removed, {
      positions: 1, bookmarks: 1, shelves: 1, listeningQueues: 1,
      bookNarration: 1, pronunciations: 1, chapterTransitions: 1
    });
    assertNoTraceOf(store.files, 'gone');
    assert(store.files.settings.bookNarration.kept, 'a live book keeps its narrator');

    const empty = memoryStore(libraryFiles({}));
    const emptied = await service(empty).reconcileLibraryState({ loadBooks: async () => ({}) });
    assert.strictEqual(emptied.skipped, undefined, 'a readable empty catalog is reconciled');
    assertNoTraceOf(empty.files, 'gone');
  });

  await test('startup reconcile never sweeps when the catalog is missing or corrupt', async () => {
    for (const loadBooks of [
      async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      async () => null,
      async () => []
    ]) {
      const store = memoryStore(libraryFiles({}));
      const result = await service(store).reconcileLibraryState({ loadBooks });
      assert.strictEqual(result.skipped, 'catalog-unavailable');
      assert.deepStrictEqual(store.saved, []);
    }
  });

  await test('the strict catalog loader refuses a missing books.json instead of reading it as empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-strict-'));
    const filePath = path.join(dir, 'books.json');
    await assert.rejects(loadCatalogStrict({ access: fs.access, load: async () => ({}), filePath }), { code: 'ENOENT' });
    await fs.writeFile(filePath, '{}');
    assert.deepStrictEqual(await loadCatalogStrict({ access: fs.access, load: async () => ({}), filePath }), {});
    await assert.rejects(loadCatalogStrict({ access: fs.access, load: async () => [], filePath }));
  });

  await test('the deleted-book sweep removes a committed deletion\'s files and never a live book\'s', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deleted-sweep-'));
    const files = [
      'abc.epub', 'abc.xbook.json', 'abc_cover.jpg', 'abc_ch0.mp3',
      'abc_offline_0123456789abcdef_ch0.mp3.part',
      // live sibling whose id has the deleted id as a prefix
      'abc_2.epub', 'abc_2_ch0.mp3', 'abc_2_cover.jpg',
      // a deleted id that was re-imported
      'back.epub',
      // an unrelated file and a file the live record names explicitly
      'notes.txt', 'abc.pdf'
    ];
    for (const name of files) await fs.writeFile(path.join(cacheDir, name), 'x');
    await fs.mkdir(path.join(cacheDir, 'abc_narration_artifacts_v1'));
    const books = {
      abc_2: { id: 'abc_2', path: path.join(cacheDir, 'abc_2.epub') },
      back: { id: 'back', path: path.join(cacheDir, 'back.epub') },
      other: { id: 'other', sourcePath: '/old/cache/root/abc.pdf' }
    };
    const locked = [];
    const cleaner = createBookArtifactCleaner({
      cacheDir,
      fs,
      invalidateChapterCache: () => {},
      isBookDeleted: () => false,
      bookStillExists: async bookId => Boolean(books[bookId]),
      withSweepLock: async (bookId, task) => { locked.push(bookId); return task(); },
      log: quiet
    });
    const result = await cleaner.sweepDeletedBooks({
      loadBooks: async () => books,
      deletedBookIds: ['abc', 'back', 'never-had-files']
    });
    const left = (await fs.readdir(cacheDir)).sort();
    assert.deepStrictEqual(left, ['abc.pdf', 'abc_2.epub', 'abc_2_ch0.mp3', 'abc_2_cover.jpg', 'back.epub', 'notes.txt']);
    assert.strictEqual(result.removed, 6);
    assert.deepStrictEqual(locked, ['abc'], 'removal runs under the deleted book\'s lock');
  });

  await test('the deleted-book sweep does nothing without a readable catalog or once the book is back', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deleted-sweep-guard-'));
    await fs.writeFile(path.join(cacheDir, 'abc.epub'), 'x');
    const make = bookStillExists => createBookArtifactCleaner({
      cacheDir, fs, invalidateChapterCache: () => {}, isBookDeleted: () => false, bookStillExists, log: quiet
    });
    const unreadable = await make(async () => false).sweepDeletedBooks({
      loadBooks: async () => { throw new Error('corrupt'); },
      deletedBookIds: ['abc']
    });
    assert.strictEqual(unreadable.skipped, 'catalog-unavailable');
    // Re-imported between the catalog read and the locked re-check.
    await make(async () => true).sweepDeletedBooks({ loadBooks: async () => ({}), deletedBookIds: ['abc'] });
    assert.deepStrictEqual(await fs.readdir(cacheDir), ['abc.epub']);
  });

  await test('pronunciation rules have a per-book remove path', async () => {
    const store = { version: 1, global: [{ id: 'g' }], books: { a: [{ id: 'r' }], b: [] } };
    assert.deepStrictEqual([...referencedRuleBooks(store)].sort(), ['a', 'b']);
    assert.strictEqual(removeBookRules(store, 'a'), true);
    assert.strictEqual(removeBookRules(store, 'a'), false);
    assert.deepStrictEqual(store, { version: 1, global: [{ id: 'g' }], books: { b: [] } });
  });

  await test('profile migration covers every per-user store', async () => {
    assert.deepStrictEqual([...USER_DATA_STORES].sort(), ['bookmarks', 'clientSettings', 'listeningQueues', 'positions', 'shelves']);
  });

  await test('profile migration merges shelves, bookmarks, queues and settings without dropping either side', async () => {
    const stores = {
      positions: { users: { default: { a: { chapterIndex: 1 }, c: { chapterIndex: 5 } }, usr: { c: { chapterIndex: 9 } } } },
      bookmarks: { users: { default: { a: [{ id: 'm1' }], c: [{ id: 'm2' }, { id: 'm3' }] }, usr: { c: [{ id: 'm3' }, { id: 'm4' }] } } },
      shelves: { users: { default: { books: { a: { addedAt: '1' }, c: { addedAt: '2' } } }, usr: { books: { c: { addedAt: '9' }, d: { addedAt: '8' } } } } },
      listeningQueues: {
        users: {
          default: { bookIds: ['a', 'c', 'e'], autoContinue: false, bookSettings: { a: { playbackSpeed: 1.5 }, c: { playbackSpeed: 2 } } },
          usr: { bookIds: ['d', 'c'], autoContinue: true, bookSettings: { c: { playbackSpeed: 1.25 } } }
        }
      },
      clientSettings: { users: { default: { theme: 'dark', speed: 1.2 }, usr: { speed: 1.5 } } }
    };
    const migrateAll = () => {
      for (const kind of USER_DATA_STORES) state.migrateUserData(kind, stores[kind], 'default', 'usr');
    };
    migrateAll();
    assert.deepStrictEqual(stores.positions.users.usr, { a: { chapterIndex: 1 }, c: { chapterIndex: 9 } });
    assert.deepStrictEqual(stores.bookmarks.users.usr, { c: [{ id: 'm3' }, { id: 'm4' }, { id: 'm2' }], a: [{ id: 'm1' }] });
    assert.deepStrictEqual(Object.keys(stores.shelves.users.usr.books).sort(), ['a', 'c', 'd']);
    assert.strictEqual(stores.shelves.users.usr.books.c.addedAt, '9', 'target shelf entry wins');
    assert.deepStrictEqual(stores.listeningQueues.users.usr, {
      bookIds: ['d', 'c', 'a', 'e'],
      autoContinue: true,
      bookSettings: { a: { playbackSpeed: 1.5 }, c: { playbackSpeed: 1.25 } }
    });
    assert.deepStrictEqual(stores.clientSettings.users.usr, { theme: 'dark', speed: 1.5 });
    assert(stores.shelves.users.default.books.a, 'the source is kept so an interrupted migration can be retried');

    const once = structuredClone(stores);
    migrateAll();
    assert.deepStrictEqual(stores, once, 'a retried migration converges');
  });

  await test('profile migration into a new profile copies the source queue as is', async () => {
    const store = { users: { default: { bookIds: ['a'], autoContinue: false, bookSettings: {} } } };
    state.migrateUserData('listeningQueues', store, 'default', 'usr');
    assert.deepStrictEqual(store.users.usr, { bookIds: ['a'], autoContinue: false, bookSettings: {} });
  });

  console.log(`\nBook state integrity tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
