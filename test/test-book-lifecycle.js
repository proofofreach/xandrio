const assert = require('assert');
const path = require('path');
const {
  DELETE_BOOK_RESULT,
  createBookArtifactCleaner,
  createBookDeletionService
} = require('../lib/book-deletion');
const {
  REFRESH_BOOK_RESULT,
  STRUCTURE_RECONCILE_RESULT,
  createBookAudioInvalidator,
  createBookMetadataRefreshService
} = require('../lib/book-metadata-refresh');
const { resolveMetadataSeed } = require('../lib/metadata-service');

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

function clone(value) {
  return structuredClone(value);
}

function deletionHarness(options = {}) {
  const skipSave = Symbol('skip');
  const files = {
    books: {
      book_1: {
        id: 'book_1',
        title: 'Example',
        addedBy: 'owner',
        path: '/cache/book_1.epub'
      }
    },
    positions: { owner: { books: { book_1: { chapterIndex: 2 } } } },
    bookmarks: { owner: [{ id: 'mark', bookId: 'book_1' }] },
    shelves: { owner: ['book_1'], other: ['book_1'] },
    listeningQueues: {
      users: {
        owner: { bookIds: ['book_1'], bookSettings: { book_1: { playbackSpeed: 1.5 } } }
      }
    }
  };
  const operations = [];
  const artifactCleanup = options.artifactCleanup || {
    deleted: ['/cache/book_1.epub'],
    failed: []
  };

  const updateJSON = async (file, mutator) => {
    operations.push(`update:${file}:begin`);
    const working = clone(files[file]);
    const result = await mutator(working);
    if ((file === 'books' && options.failBookWrite) || options.failFile === file) {
      operations.push(`update:${file}:failed`);
      throw new Error('disk full');
    }
    if (result !== skipSave) {
      files[file] = working;
      operations.push(`update:${file}:saved`);
    } else {
      operations.push(`update:${file}:skipped`);
    }
    return result;
  };

  const service = createBookDeletionService({
    booksFile: 'books',
    positionsFile: 'positions',
    bookmarksFile: 'bookmarks',
    shelvesFile: 'shelves',
    listeningQueueFile: 'listeningQueues',
    updateJSON,
    skipSave,
    beginBookDeletion: options.trackDeletionLog
      ? async bookId => {
        operations.push(`tombstone:begin:${bookId}`);
        return 'deletion-token';
      }
      : undefined,
    commitBookDeletion: options.trackDeletionLog
      ? async token => operations.push(`tombstone:commit:${token}`)
      : undefined,
    abortBookDeletion: options.trackDeletionLog
      ? async token => operations.push(`tombstone:abort:${token}`)
      : undefined,
    rememberDeletedBookId: options.rememberDeletedBookId || (bookId => operations.push(`remember:${bookId}`)),
    cancelBookJobs: async bookId => {
      operations.push(`cancel:${bookId}`);
      await options.cancelBookJobs?.(bookId, operations);
      return 3;
    },
    stopPremiumPrep: async bookId => {
      operations.push(`stop:${bookId}`);
      await options.stopPremiumPrep?.(bookId, operations);
    },
    cleanupBookArtifacts: async (bookId, book) => {
      operations.push(`cleanup:${bookId}:${book.title}`);
      return artifactCleanup;
    },
    scheduleArtifactSweeps: options.scheduleArtifactSweeps || (bookId => operations.push(`sweep:${bookId}`)),
    removeBookPositions: (positions, bookId) => {
      for (const user of Object.values(positions)) delete user.books?.[bookId];
    },
    removeBookBookmarks: (bookmarks, bookId) => {
      for (const [userId, entries] of Object.entries(bookmarks)) {
        bookmarks[userId] = entries.filter(entry => entry.bookId !== bookId);
      }
    },
    removeBookFromAllShelves: (shelves, bookId) => {
      for (const [userId, entries] of Object.entries(shelves)) {
        shelves[userId] = entries.filter(entry => entry !== bookId);
      }
    },
    removeBookFromAllQueues: (store, bookId) => {
      for (const queue of Object.values(store.users || {})) {
        queue.bookIds = queue.bookIds.filter(id => id !== bookId);
        delete queue.bookSettings?.[bookId];
      }
    },
    log: { warn: (...args) => operations.push(`warn:${args[0]}`) }
  });

  return { service, files, operations, artifactCleanup };
}

function metadataHarness(options = {}) {
  const skipSave = Symbol('skip');
  const files = {
    books: {
      book_1: {
        id: 'book_1',
        title: options.bookTitle || 'Old Title',
        author: options.bookAuthor || 'Old Author',
        searchedTitle: options.searchedTitle,
        searchedAuthor: options.searchedAuthor,
        filename: options.filename,
        path: options.bookPath || '/cache/book_1.epub',
        chapterStructureKey: options.chapterStructureKey,
        importValidation: options.importValidation,
        chapterCount: options.chapterCount,
        totalDuration: options.totalDuration,
        chapterDurations: options.chapterDurations,
        audioGenerationState: options.audioGenerationState,
        audioGeneratedChapters: options.audioGeneratedChapters,
        audioGenerationTotal: options.audioGenerationTotal,
        audioGenerationUpdatedAt: options.audioGenerationUpdatedAt,
        retainedConcurrentField: true,
        chapter1Ready: true,
        preloadedThrough: 4
      }
    },
    positions: {
      owner: { books: { book_1: { chapterIndex: 3, chapterStructureKey: options.chapterStructureKey } } }
    }
  };
  files.transitions = {};
  files.bookmarks = { users: { owner: { book_1: [{ chapterIndex: 0, timestamp: 12, chapterStructureKey: options.chapterStructureKey }] } } };
  const operations = [];
  let booksUpdateCount = 0;
  let transitionFailuresRemaining = options.transitionFailures || 0;
  let positionFailuresRemaining = options.positionFailures ??
    (options.failPositionsWrite ? Number.POSITIVE_INFINITY : 0);
  let coverFailuresRemaining = options.coverFailures ??
    (options.failCoverRemoval ? Number.POSITIVE_INFINITY : 0);
  let audioFailuresRemaining = options.audioFailures ??
    (options.failAudioInvalidation ? Number.POSITIVE_INFINITY : 0);

  const updateJSON = async (file, mutator) => {
    operations.push(`update:${file}:begin`);
    if (file === 'books') {
      booksUpdateCount++;
      if (options.deleteBeforeBookUpdate && booksUpdateCount === 1) delete files.books.book_1;
    }
    const working = clone(files[file]);
    const result = await mutator(working);
    if (
      (file === 'books' && options.failBookWrite) ||
      (file === 'positions' && positionFailuresRemaining > 0) ||
      (file === 'transitions' && transitionFailuresRemaining > 0)
    ) {
      if (file === 'positions') positionFailuresRemaining--;
      if (file === 'transitions') transitionFailuresRemaining--;
      throw new Error('permission denied');
    }
    if (result !== skipSave) files[file] = working;
    operations.push(`update:${file}:${result === skipSave ? 'skipped' : 'saved'}`);
    return result;
  };

  const service = createBookMetadataRefreshService({
    booksFile: 'books',
    positionsFile: 'positions',
    transitionsFile: 'transitions',
    bookmarksFile: 'bookmarks',
    cacheDir: '/cache',
    path,
    loadJSON: async file => clone(files[file]),
    updateJSON,
    skipSave,
    isXBookPath: file => file.endsWith('.xbook.json'),
    invalidateXBookArtifactCache: file => operations.push(`invalidate:${file}`),
    extractBookMetadata: async file => {
      operations.push(`metadata:${file}`);
      return options.embeddedMetadata || {
        title: 'Fresh Title',
        author: 'Fresh Author',
        publisher: 'Embedded Publisher',
        date: '2021-04-03',
        description: '<p>Fresh description</p>',
        language: 'en',
        isbn: ['123']
      };
    },
    getChaptersCached: async file => {
      operations.push(`chapters:${file}`);
      return options.refreshedChapters || [{ title: 'One' }, { title: 'Two' }];
    },
    resolveMetadataSeed: options.resolveMetadataSeed || ((metadata, fallbackTitle, fallbackAuthor) => ({
      title: metadata.title || fallbackTitle,
      author: metadata.author || fallbackAuthor,
      embeddedLooksWrong: false
    })),
    enrichBookMetadata: async () => options.enrichedMetadata || ({
      title: 'Provider Title',
      author: 'Provider Author',
      publisher: 'Provider Publisher',
      publishedDate: 1999,
      subjects: ['Fiction']
    }),
    trustedEnrichedTitle: title => title,
    resolveOpenLibraryIdentity: async (_identity, resolveOptions) => {
      operations.push(`identity-timeout:${resolveOptions.timeoutMs}`);
      return {
        openLibraryWorkKey: 'OL1W',
        confidence: { score: 0.9, level: 'high' },
        warnings: ['one provider lookup timed out']
      };
    },
    isGarbageTitle: () => false,
    isGarbageAuthor: () => false,
    normalizeAuthorForDisplay: value => value,
    publishedYearFromMetadata: (date, fallback) => date ? 2021 : fallback,
    // Deliberately minimal test double; production uses chapter-utils.stripHTML.
    // codeql[js/incomplete-multi-character-sanitization]
    cleanBookDescription: value => value.replace(/<[^>]+>/g, ''),
    chapterStructureKey: options.structureKey || (() => options.refreshedStructureKey || 'structure-new'),
    bookRecordOpenLibraryFields: identity => ({
      openLibraryWorkKey: identity.openLibraryWorkKey
    }),
    canonicalWorkKey: (title, author) => `${title}:${author}`,
    invalidateBookAudio: async (bookId, chapterCount, chapterIndexes) => {
      operations.push(`invalidate-audio:${bookId}:${chapterCount}${chapterIndexes ? `:${chapterIndexes.join(',')}` : ''}`);
      if (audioFailuresRemaining > 0) {
        audioFailuresRemaining--;
        throw new Error('audio busy');
      }
    },
    removeFileIfExists: async file => {
      operations.push(`remove-cover:${file}`);
      if (coverFailuresRemaining > 0) {
        coverFailuresRemaining--;
        throw new Error('cover busy');
      }
    },
    removeBookPositions: (positions, bookId) => {
      operations.push(`remove-positions:${bookId}`);
      for (const user of Object.values(positions)) delete user.books?.[bookId];
    },
    setBookPositionsStructureKey: (positions, bookId, structureKey, previousStructureKey) => {
      operations.push(`set-structure:${bookId}:${structureKey}`);
      for (const user of Object.values(positions)) {
        if (user.books?.[bookId] && (previousStructureKey === undefined || user.books[bookId].chapterStructureKey === previousStructureKey)) user.books[bookId].chapterStructureKey = structureKey;
      }
    },
    withBookStateLock: async (bookId, operation) => {
      operations.push(`state-lock:${bookId}:begin`);
      try {
        return await operation();
      } finally {
        operations.push(`state-lock:${bookId}:end`);
      }
    },
    now: () => new Date('2026-07-24T12:00:00.000Z'),
    log: { warn: message => operations.push(`warn:${message}`) }
  });

  return {
    service, files, operations,
    setPositionFailures: count => { positionFailuresRemaining = count; }
  };
}

(async () => {
  await test('deletion reports not found without side effects', async () => {
    const harness = deletionHarness();
    delete harness.files.books.book_1;
    const result = await harness.service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } });
    assert.deepStrictEqual(result, { status: DELETE_BOOK_RESULT.NOT_FOUND });
    assert.deepStrictEqual(harness.operations, ['update:books:begin', 'update:books:skipped']);
  });

  await test('member deletion enforces ownership before side effects', async () => {
    const harness = deletionHarness();
    const result = await harness.service.deleteBook({
      bookId: 'book_1',
      actor: { id: 'different-user', role: 'member' }
    });
    assert.deepStrictEqual(result, { status: DELETE_BOOK_RESULT.FORBIDDEN });
    assert(harness.files.books.book_1);
    assert(!harness.operations.some(operation => operation.startsWith('cleanup:')));
  });

  await test('an unknown or missing role is not privileged to delete another user\'s book', async () => {
    for (const actor of [undefined, {}, { id: 'different-user' }, { id: 'different-user', role: 'editor' }]) {
      const harness = deletionHarness();
      const result = await harness.service.deleteBook({ bookId: 'book_1', actor });
      assert.deepStrictEqual(result, { status: DELETE_BOOK_RESULT.FORBIDDEN }, `actor ${JSON.stringify(actor)}`);
      assert(harness.files.books.book_1, 'book must survive');
    }
    const owner = deletionHarness();
    const owned = await owner.service.deleteBook({ bookId: 'book_1', actor: { id: 'owner', role: 'guest' } });
    assert.strictEqual(owned.status, DELETE_BOOK_RESULT.DELETED, 'the owner may still delete their own book');
  });

  await test('a failing library-state store does not stop the other stores from being cleaned', async () => {
    const harness = deletionHarness({ failFile: 'bookmarks' });
    const result = await harness.service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } });
    assert.strictEqual(result.status, DELETE_BOOK_RESULT.DELETED);
    assert.deepStrictEqual(result.libraryStateErrors, [{ store: 'bookmarks', error: 'disk full' }]);
    assert.strictEqual(harness.files.positions.owner.books.book_1, undefined, 'positions were cleaned before the failure');
    assert.deepStrictEqual(harness.files.shelves, { owner: [], other: [] }, 'shelves were still cleaned after the failure');
    assert.deepStrictEqual(harness.files.listeningQueues.users.owner.bookIds, [], 'queues were still cleaned after the failure');
    assert(harness.operations.includes('update:shelves:saved') && harness.operations.includes('update:listeningQueues:saved'));
  });

  await test('startup reconcile drops library-state entries for books absent from a non-empty catalog', async () => {
    const files = {
      books: { kept: { id: 'kept' } },
      positions: { users: { alice: { kept: { chapterIndex: 1 }, gone: { chapterIndex: 2 } }, bob: { gone: {} } } },
      bookmarks: { users: { alice: { gone: [{ id: 'm' }] } } },
      shelves: { users: { alice: { books: { kept: { addedAt: 1 }, gone: { addedAt: 2 } } } } },
      listeningQueues: { users: { alice: { bookIds: ['gone', 'kept'], bookSettings: { gone: { speed: 2 } } } } }
    };
    const skipSave = Symbol('skip');
    const saved = [];
    const updateJSON = async (file, mutator) => {
      const working = clone(files[file]);
      const result = await mutator(working);
      if (result !== skipSave) { files[file] = working; saved.push(file); }
      return result;
    };
    const { createUserLibraryState } = require('../lib/user-library-state');
    const shelves = require('../lib/shelves');
    const listeningQueue = require('../lib/listening-queue');
    const { removeBookBookmarks } = require('../lib/routes/bookmarks-routes');
    const state = createUserLibraryState();
    const service = createBookDeletionService({
      booksFile: 'books', positionsFile: 'positions', bookmarksFile: 'bookmarks', shelvesFile: 'shelves',
      listeningQueueFile: 'listeningQueues', updateJSON, skipSave,
      rememberDeletedBookId: () => null, cancelBookJobs: async () => 0, stopPremiumPrep: async () => {},
      cleanupBookArtifacts: async () => ({ deleted: [], failed: [] }), scheduleArtifactSweeps: () => {},
      removeBookPositions: (positions, bookId) => state.removeBookPositions(positions, bookId),
      removeBookBookmarks,
      removeBookFromAllShelves: shelves.removeBookFromAllShelves,
      removeBookFromAllQueues: listeningQueue.removeBookFromAllQueues,
      log: { warn() {}, log() {}, error() {} }
    });

    const result = await service.reconcileLibraryState({ loadBooks: async () => files.books });
    assert.deepStrictEqual(result.removed, { positions: 1, bookmarks: 1, shelves: 1, listeningQueues: 1 });
    assert.deepStrictEqual(Object.keys(files.positions.users.alice), ['kept']);
    assert.deepStrictEqual(files.positions.users.bob, {});
    assert.deepStrictEqual(files.bookmarks.users.alice, {});
    assert.deepStrictEqual(Object.keys(files.shelves.users.alice.books), ['kept']);
    assert.deepStrictEqual(files.listeningQueues.users.alice.bookIds, ['kept']);
    assert.deepStrictEqual(files.listeningQueues.users.alice.bookSettings, {});

    saved.length = 0;
    assert.deepStrictEqual(await service.reconcileLibraryState({ loadBooks: async () => files.books }), { removed: {} });
    assert.deepStrictEqual(saved, [], 'a clean library writes nothing');

    files.positions.users.alice.gone = {};
    assert.strictEqual((await service.reconcileLibraryState({ loadBooks: async () => { throw new Error('missing'); } })).skipped, 'catalog-unavailable');
    assert.strictEqual((await service.reconcileLibraryState({ loadBooks: async () => null })).skipped, 'catalog-unavailable');
    assert(files.positions.users.alice.gone, 'an unavailable catalog never sweeps');
  });

  await test('successful deletion removes all references and preserves response fields', async () => {
    const harness = deletionHarness({
      artifactCleanup: {
        deleted: ['/cache/book_1.epub'],
        failed: [{ path: '/cache/book_1_cover.jpg', error: 'busy' }]
      }
    });
    const result = await harness.service.deleteBook({
      bookId: 'book_1',
      actor: { id: 'owner', role: 'member' }
    });
    assert.strictEqual(result.status, DELETE_BOOK_RESULT.DELETED);
    assert.strictEqual(result.cancelledJobs, 3);
    assert.deepStrictEqual(result.artifactCleanup, harness.artifactCleanup);
    assert.strictEqual(harness.files.books.book_1, undefined);
    assert.strictEqual(harness.files.positions.owner.books.book_1, undefined);
    assert.deepStrictEqual(harness.files.bookmarks.owner, []);
    assert.deepStrictEqual(harness.files.shelves, { owner: [], other: [] });
    assert.deepStrictEqual(harness.files.listeningQueues.users.owner, { bookIds: [], bookSettings: {} });
    assert(
      harness.operations.indexOf('update:books:saved') < harness.operations.indexOf('cleanup:book_1:Example'),
      'catalog write must finish before irreversible cleanup'
    );
  });

  await test('deletion waits for durable generation cleanup before removing artifacts', async () => {
    let releaseCleanup;
    const cleanupGate = new Promise(resolve => {
      releaseCleanup = resolve;
    });
    const harness = deletionHarness({
      cancelBookJobs: async (_bookId, operations) => {
        operations.push('cancel:durable:begin');
        await cleanupGate;
        operations.push('cancel:durable:done');
      }
    });

    let settled = false;
    const deletion = harness.service
      .deleteBook({ bookId: 'book_1', actor: { role: 'admin' } })
      .finally(() => {
        settled = true;
      });
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(settled, false);
    assert(!harness.operations.includes('cleanup:book_1:Example'));
    releaseCleanup();
    await deletion;
    assert(
      harness.operations.indexOf('cancel:durable:done') <
        harness.operations.indexOf('cleanup:book_1:Example')
    );
  });

  await test('deletion waits for premium intent removal before removing artifacts', async () => {
    let releasePremiumCleanup;
    const premiumCleanupGate = new Promise(resolve => {
      releasePremiumCleanup = resolve;
    });
    const harness = deletionHarness({
      stopPremiumPrep: async (_bookId, operations) => {
        operations.push('stop:durable:begin');
        await premiumCleanupGate;
        operations.push('stop:durable:done');
      }
    });

    let settled = false;
    const deletion = harness.service
      .deleteBook({ bookId: 'book_1', actor: { role: 'admin' } })
      .finally(() => {
        settled = true;
      });
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(settled, false);
    assert(!harness.operations.includes('cleanup:book_1:Example'));
    releasePremiumCleanup();
    await deletion;
    assert(
      harness.operations.indexOf('stop:durable:done') <
        harness.operations.indexOf('cleanup:book_1:Example')
    );
  });

  await test('deletion publishes its tombstone after the catalog write', async () => {
    const harness = deletionHarness({ trackDeletionLog: true });
    await harness.service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } });
    assert(
      harness.operations.indexOf('update:books:saved') <
        harness.operations.indexOf('tombstone:commit:deletion-token')
    );
    assert(
      harness.operations.indexOf('tombstone:commit:deletion-token') <
        harness.operations.indexOf('cleanup:book_1:Example')
    );
  });

  await test('failed catalog persistence cannot remove artifacts from a live record', async () => {
    const harness = deletionHarness({ failBookWrite: true, trackDeletionLog: true });
    await assert.rejects(
      harness.service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } }),
      /disk full/
    );
    assert(harness.files.books.book_1);
    assert(!harness.operations.some(operation =>
      /^(remember|cancel|stop|cleanup|sweep):/.test(operation)
    ));
    assert(harness.operations.includes('tombstone:abort:deletion-token'));
  });

  await test('a downstream deletion-store failure is reported and never blocks the remaining stores', async () => {
    const all = ['positions', 'bookmarks', 'shelves', 'listeningQueues'];
    for (const failedFile of all) {
      const harness = deletionHarness({ failFile: failedFile });
      const result = await harness.service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } });
      assert.strictEqual(result.status, DELETE_BOOK_RESULT.DELETED);
      assert.deepStrictEqual(result.libraryStateErrors, [{ store: failedFile, error: 'disk full' }]);
      assert.strictEqual(harness.files.books.book_1, undefined);
      assert(harness.operations.includes('cleanup:book_1:Example'));
      for (const file of all) {
        assert(harness.operations.includes(`update:${file}:begin`), `${file} is attempted even after ${failedFile} failed`);
        if (file !== failedFile) assert(harness.operations.includes(`update:${file}:saved`), `${file} is saved`);
      }
    }
  });

  await test('artifact cleanup is cache-bounded and reports individual failures', async () => {
    const removed = [];
    const invalidated = [];
    const cleaner = createBookArtifactCleaner({
      cacheDir: '/cache',
      fs: {
        readdir: async () => ['book_1_ch0_chunk0.mp3', 'other_ch0_chunk0.mp3'],
        rm: async target => {
          removed.push(target);
          if (target.endsWith('_cover.jpg')) throw new Error('permission denied');
        }
      },
      invalidateChapterCache: target => invalidated.push(target),
      isBookDeleted: () => true,
      setTimer: () => {},
      log: console
    });
    const result = await cleaner.cleanup('book_1', {
      path: '/cache/book_1.epub',
      sourcePath: '/outside/source.epub',
      coverPath: '/cache/book_1_cover.jpg'
    });
    assert(removed.includes('/cache/book_1.epub'));
    assert(removed.includes('/cache/book_1_ch0_chunk0.mp3'));
    assert(!removed.includes('/cache/other_ch0_chunk0.mp3'));
    assert(!removed.includes('/outside/source.epub'));
    assert.deepStrictEqual(result.failed, [{
      path: '/cache/book_1_cover.jpg',
      error: 'permission denied'
    }]);
    assert(!invalidated.includes('/cache/book_1_cover.jpg'));
  });

  await test('artifact cleanup for a book id does not sweep a sibling id it is a prefix of', async () => {
    // "abc" is a proper prefix of "abc_2". A bare startsWith(bookId + '_')
    // test would incorrectly claim "abc_2"'s narration and cover as "abc"'s.
    const removed = [];
    const cleaner = createBookArtifactCleaner({
      cacheDir: '/cache',
      fs: {
        readdir: async () => [
          'abc.epub',
          'abc_ch0.mp3',
          'abc_2.epub',
          'abc_2_ch0.mp3',
          'abc_2_cover.jpg'
        ],
        rm: async target => removed.push(target)
      },
      invalidateChapterCache: () => {},
      isBookDeleted: () => true,
      setTimer: () => {},
      log: console
    });
    const result = await cleaner.cleanup('abc', {});
    assert.deepStrictEqual(new Set(result.deleted), new Set([
      '/cache/abc.epub',
      '/cache/abc_ch0.mp3'
    ]));
    assert(!removed.includes('/cache/abc_2.epub'));
    assert(!removed.includes('/cache/abc_2_ch0.mp3'));
    assert(!removed.includes('/cache/abc_2_cover.jpg'));
  });

  await test('deletion guards retire only after every deferred sweep settles', async () => {
    const timers = [];
    const completed = [];
    const cleaner = createBookArtifactCleaner({
      cacheDir: '/cache',
      fs: {
        readdir: async () => [],
        rm: async () => {}
      },
      invalidateChapterCache: () => {},
      isBookDeleted: () => true,
      withSweepLock: (_bookId, task) => task(),
      onSweepsComplete: bookId => completed.push(bookId),
      setTimer: callback => timers.push(callback),
      log: { log() {}, error() {} }
    });
    cleaner.scheduleSweeps('book_1', {});
    assert.strictEqual(timers.length, 3);
    for (let index = 0; index < timers.length; index += 1) {
      timers[index]();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepStrictEqual(completed, index === timers.length - 1 ? ['book_1'] : []);
    }
  });

  await test('a first deletion\'s last sweep does not retire the guard of a later deletion of the same id', async () => {
    // Delete, re-import and delete again inside the 30 s sweep window. The
    // guard map mirrors server.js: one token per deletion, a re-import clears.
    const timers = [];
    const guards = new Map();
    const cleaner = createBookArtifactCleaner({
      cacheDir: '/cache',
      fs: { readdir: async () => [], rm: async () => {} },
      invalidateChapterCache: () => {},
      isBookDeleted: bookId => guards.has(bookId),
      withSweepLock: (_bookId, task) => task(),
      onSweepsComplete: (bookId, token) => {
        if (token && guards.get(bookId) === token) guards.delete(bookId);
      },
      setTimer: (callback, delay) => timers.push({ callback, delay }),
      log: { log() {}, error() {} }
    });
    const deleteOnce = () => {
      const { service } = deletionHarness({
        rememberDeletedBookId: bookId => {
          const token = { bookId };
          guards.set(bookId, token);
          return token;
        },
        scheduleArtifactSweeps: cleaner.scheduleSweeps
      });
      return service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } });
    };
    const runTimers = async batch => {
      for (const timer of batch) timer.callback();
      for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
    };

    await deleteOnce();
    const first = timers.splice(0);
    guards.delete('book_1'); // the re-import retires the first guard
    await deleteOnce();
    const second = timers.splice(0);
    await runTimers(first);
    assert(guards.has('book_1'), 'the second deletion keeps its guard after the first deletion\'s sweeps settle');
    await runTimers(second);
    assert(!guards.has('book_1'), 'the second deletion retires its own guard once its sweeps settle');
  });

  await test('metadata refresh preserves precedence and clears stale structure positions', async () => {
    const harness = metadataHarness({ chapterStructureKey: 'structure-old' });
    const result = await harness.service.refreshBook('book_1');
    assert.strictEqual(result.status, REFRESH_BOOK_RESULT.REFRESHED);
    assert.strictEqual(result.book.title, 'Fresh Title');
    assert.strictEqual(result.book.author, 'Fresh Author');
    assert.strictEqual(result.book.publisher, 'Embedded Publisher');
    assert.strictEqual(result.book.publishedDate, 2021);
    assert.strictEqual(result.book.description, 'Fresh description');
    assert.deepStrictEqual(result.book.subjects, ['Fiction']);
    assert.strictEqual(result.book.chapterCount, 2);
    assert.strictEqual(result.book.chapterStructureKey, 'structure-new');
    assert.strictEqual(result.book.chapter1Ready, false);
    assert.strictEqual(result.book.preloadedThrough, null);
    assert.strictEqual(result.book.metadataRefreshed, '2026-07-24T12:00:00.000Z');
    assert.strictEqual(result.book.retainedConcurrentField, true);
    assert.deepStrictEqual(result.providerWarnings, ['one provider lookup timed out']);
    assert(harness.operations.includes('identity-timeout:5000'));
    assert(harness.operations.includes('invalidate-audio:book_1:2'));
    assert(harness.operations.includes('remove-cover:/cache/book_1_cover.jpg'));
    assert(harness.operations.includes('remove-positions:book_1'));
    assert(harness.operations.includes('state-lock:book_1:begin'));
  });

  await test('metadata refresh rejects a storage id title in favor of trusted search metadata', async () => {
    const harness = metadataHarness({
      bookTitle: 'book_1',
      bookAuthor: 'Andrew Roberts',
      searchedTitle: 'Napoleon',
      searchedAuthor: 'Andrew Roberts',
      filename: 'book_1.epub',
      embeddedMetadata: {
        title: 'book_1',
        author: 'Untrusted Embedded Author',
        publisher: 'Penguin Group US',
        language: 'en',
        description: 'Stored description'
      },
      enrichedMetadata: {},
      resolveMetadataSeed,
      chapterStructureKey: 'structure-new',
      refreshedStructureKey: 'structure-new'
    });
    const result = await harness.service.refreshBook('book_1');
    assert.strictEqual(result.book.title, 'Napoleon');
    assert.strictEqual(result.book.author, 'Andrew Roberts');
  });

  await test('metadata refresh restores the selected title when embedded metadata names the series', async () => {
    const harness = metadataHarness({
      bookTitle: 'book_1 The Magic Mountain', searchedTitle: 'The Magic Mountain',
      filename: 'book_1 The Magic Mountain.epub',
      embeddedMetadata: { title: 'Oxford World’s Classics', author: 'Thomas Mann', description: 'A novel' },
      enrichedMetadata: {}, resolveMetadataSeed,
      chapterStructureKey: 'structure-new', refreshedStructureKey: 'structure-new'
    });
    const result = await harness.service.refreshBook('book_1');
    assert.strictEqual(result.book.title, 'The Magic Mountain');
  });

  await test('metadata refresh clears stale audio state when chapter totals disagree', async () => {
    const harness = metadataHarness({
      chapterStructureKey: 'structure-new',
      refreshedStructureKey: 'structure-new',
      chapterCount: 2,
      totalDuration: 999,
      chapterDurations: [99],
      audioGenerationState: 'partial',
      audioGeneratedChapters: 1,
      audioGenerationTotal: 65,
      audioGenerationUpdatedAt: '2026-07-27T05:48:38.717Z',
      refreshedChapters: [
        { title: 'One', estimatedDuration: 10 },
        { title: 'Two', estimatedDuration: 20 }
      ]
    });
    const result = await harness.service.refreshBook('book_1');
    assert(harness.operations.includes('invalidate-audio:book_1:65'));
    assert.strictEqual(result.book.totalDuration, 30);
    assert.strictEqual(result.book.chapterDurations, undefined);
    assert.strictEqual(result.book.audioGenerationState, undefined);
    assert.strictEqual(result.book.audioGeneratedChapters, undefined);
    assert.strictEqual(result.book.audioGenerationTotal, undefined);
    assert.strictEqual(result.book.audioGenerationUpdatedAt, undefined);
  });

  await test('metadata refresh introduces a structure key without discarding position', async () => {
    const harness = metadataHarness({ chapterStructureKey: undefined });
    const result = await harness.service.refreshBook('book_1');
    assert.strictEqual(result.status, REFRESH_BOOK_RESULT.REFRESHED);
    assert.strictEqual(
      harness.files.positions.owner.books.book_1.chapterStructureKey,
      'structure-new'
    );
    assert(!harness.operations.includes('remove-positions:book_1'));
  });

  await test('unchanged chapter structure is reconciled without touching positions or audio', async () => {
    const harness = metadataHarness({ chapterStructureKey: 'structure-new', chapterCount: 2 });
    const result = await harness.service.reconcileChapterStructure('book_1', [{ title: 'One' }, { title: 'Two' }]);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.UNCHANGED);
    assert.strictEqual(harness.files.positions.owner.books.book_1.chapterIndex, 3);
    assert(!harness.operations.some(operation => operation.startsWith('invalidate-audio:')));
    assert(!harness.operations.includes('remove-positions:book_1'));
  });

  function relabelHarness(extra = {}) {
    const structureKey = require('../lib/chapter-structure').chapterStructureKey;
    const previous = [{ title: 'Wrong ancestor — Essay', type: 'content', text: 'Exact narration remains here.', estimatedDuration: 30 }];
    const next = [{ ...previous[0], title: 'Essay' }];
    const harness = metadataHarness({
      structureKey, chapterStructureKey: structureKey(previous), chapterCount: 1,
      chapterDurations: [30], audioGenerationState: 'ready',
      refreshedChapters: next, refreshedStructureKey: structureKey(next),
      importValidation: { content: { extractionResult: { chapters: previous } } },
      ...extra
    });
    harness.files.positions.owner.books.book_1 = { chapterIndex: 0, timestamp: 12, chunkIndex: 2, chapterStructureKey: structureKey(previous) };
    return { ...harness, previous, next, structureKey };
  }

  await test('chapter relabeling preserves audio and exact listening state', async () => {
    const h = relabelHarness();
    h.files.positions.stale = { books: { book_1: { chapterIndex: 8, timestamp: 90, chapterStructureKey: 'too-old-key' } } };
    h.files.bookmarks.users.stale = { book_1: [{ chapterIndex: 8, timestamp: 90, chapterStructureKey: 'too-old-key' }] };
    const result = await h.service.reconcileChapterStructure('book_1', h.next);
    assert.strictEqual(result.status, 'relabeled');
    assert.strictEqual(h.files.positions.stale.books.book_1.chapterStructureKey, 'too-old-key');
    assert.strictEqual(h.files.bookmarks.users.stale.book_1[0].chapterStructureKey, 'too-old-key');
    assert.deepStrictEqual(h.files.books.book_1.chapterDurations, [30]);
    assert.strictEqual(h.files.books.book_1.audioGenerationState, 'ready');
    assert.deepStrictEqual(h.files.positions.owner.books.book_1, { chapterIndex: 0, timestamp: 12, chunkIndex: 2, chapterStructureKey: h.structureKey(h.next) });
    assert.strictEqual(h.files.bookmarks.users.owner.book_1[0].timestamp, 12);
    assert.strictEqual(h.files.bookmarks.users.owner.book_1[0].chapterStructureKey, h.structureKey(h.next));
    const mapped = require('../lib/chapter-transition-state').mapStateWriteToCurrent({
      bookId: 'book_1', suppliedStructureKey: h.structureKey(h.previous), book: h.files.books.book_1,
      transitions: h.files.transitions, state: { chapterIndex: 0, timestamp: 18, chunkIndex: 3 }
    });
    assert.deepStrictEqual(mapped.state, { chapterIndex: 0, timestamp: 18, chunkIndex: 3, chapterStructureKey: h.structureKey(h.next) });
    assert(!h.operations.some(op => op.startsWith('invalidate-audio:') || op.startsWith('remove-positions:')));
  });

  await test('chapter relabeling retries interrupted position persistence on the next read', async () => {
    const h = relabelHarness({ positionFailures: 1 });
    await assert.rejects(h.service.reconcileChapterStructure('book_1', h.next), /permission denied/);
    assert(h.files.books.book_1.metadataRefreshReconciliation.positions);
    await h.service.reconcileChapterStructure('book_1', h.next);
    assert.strictEqual(h.files.positions.owner.books.book_1.timestamp, 12);
    assert.strictEqual(h.files.positions.owner.books.book_1.chapterStructureKey, h.structureKey(h.next));
    assert(!h.files.books.book_1.metadataRefreshReconciliation);
  });

  await test('a pending relabel maps old-device writes before transition persistence recovers', async () => {
    const h = relabelHarness({ transitionFailures: 1 });
    await assert.rejects(h.service.reconcileChapterStructure('book_1', h.next), /permission denied/);
    const mapped = require('../lib/chapter-transition-state').mapStateWriteToCurrent({
      bookId: 'book_1', suppliedStructureKey: h.structureKey(h.previous), book: h.files.books.book_1,
      transitions: h.files.transitions, state: { chapterIndex: 0, timestamp: 18, chunkIndex: 3 }
    });
    assert.deepStrictEqual(mapped.state, { chapterIndex: 0, timestamp: 18, chunkIndex: 3, chapterStructureKey: h.structureKey(h.next) });
    await h.service.reconcileChapterStructure('book_1', h.next);
    assert(h.files.transitions.book_1.transition.metadataOnly);
    assert(!h.files.books.book_1.metadataRefreshReconciliation);
  });

  await test('metadata refresh also preserves a verified label-only change', async () => {
    const h = relabelHarness();
    await h.service.refreshBook('book_1');
    assert.strictEqual(h.files.books.book_1.chapter1Ready, true);
    assert.strictEqual(h.files.books.book_1.preloadedThrough, 4);
    assert.deepStrictEqual(h.files.books.book_1.chapterDurations, [30]);
    assert.strictEqual(h.files.positions.owner.books.book_1.timestamp, 12);
    assert(!h.operations.some(op => op.startsWith('invalidate-audio:') || op.startsWith('remove-positions:')));
  });

  await test('matching chapter count does not preserve changed narration', async () => {
    const h = relabelHarness();
    const next = [{ ...h.next[0], text: 'Different narration.' }];
    const result = await h.service.reconcileChapterStructure('book_1', next);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.RESEGMENTED);
    assert(h.operations.some(op => op.startsWith('invalidate-audio:')));
  });

  await test('an unrelated import snapshot cannot certify a metadata-only change', async () => {
    const h = relabelHarness();
    h.files.books.book_1.importValidation.content.extractionResult.chapters[0].title = 'Unrelated';
    const result = await h.service.reconcileChapterStructure('book_1', h.next);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.RESEGMENTED);
  });

  await test('a compacted import fingerprint still certifies and rejects relabels', async () => {
    const { compactImportValidation } = require('../lib/import-validation');
    const h = relabelHarness();
    h.files.books.book_1.importValidation = compactImportValidation(h.files.books.book_1.importValidation);
    const stored = h.files.books.book_1.importValidation.content.extractionResult.chapters[0];
    assert.strictEqual(stored.text, undefined, 'the record no longer carries chapter text');
    assert.strictEqual(typeof stored.textSha256, 'string');
    const changed = [{ ...h.next[0], text: 'Different narration.' }];
    const rejected = await relabelHarness();
    rejected.files.books.book_1.importValidation = compactImportValidation(rejected.files.books.book_1.importValidation);
    assert.strictEqual((await rejected.service.reconcileChapterStructure('book_1', changed)).status,
      STRUCTURE_RECONCILE_RESULT.RESEGMENTED);
    assert.strictEqual((await h.service.reconcileChapterStructure('book_1', h.next)).status, 'relabeled');
    assert(!h.operations.some(op => op.startsWith('invalidate-audio:')));
  });

  await test('read-time re-segmentation drops positions instead of moving the reader', async () => {
    const harness = metadataHarness({ chapterStructureKey: 'structure-old', chapterCount: 5 });
    const chapters = Array.from({ length: 7 }, (_unused, index) => ({
      title: `Chapter ${index + 1}`,
      estimatedDuration: 100
    }));
    const result = await harness.service.reconcileChapterStructure('book_1', chapters);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.RESEGMENTED);
    assert.strictEqual(result.book.chapterStructureKey, 'structure-new');
    assert.strictEqual(result.book.chapterCount, 7);
    assert.strictEqual(result.book.totalDuration, 700);
    assert.strictEqual(result.book.chapterDurations, undefined);
    assert.strictEqual(result.book.audioGenerationState, undefined);
    assert.strictEqual(result.book.retainedConcurrentField, true);
    // Chapter-indexed audio exists for both the old and the new shape.
    assert(harness.operations.includes('invalidate-audio:book_1:7'));
    assert(harness.operations.includes('remove-positions:book_1'));
    assert.strictEqual(harness.files.positions.owner.books.book_1, undefined);
  });

  function driftHarness(extra = {}) {
    const structureKey = require('../lib/chapter-structure').chapterStructureKey;
    const opening = 'The opening paragraph stays where it was.';
    const moved = 'This paragraph moves to the next chapter.';
    const middle = 'The middle chapter keeps its own text.';
    const closing = 'The closing chapter is untouched.';
    const shape = texts => texts.map((text, index) => ({
      title: `Chapter ${index + 1}`, type: 'content', sourceHref: `ch${index + 1}.xhtml`, text, estimatedDuration: 60
    }));
    const previous = shape([`${opening} ${moved}`, middle, closing]);
    const next = shape([opening, `${moved} ${middle}`, closing]);
    assert.strictEqual(structureKey(previous), structureKey(next), 'the drift keeps the structure key');
    const key = structureKey(previous);
    const h = metadataHarness({
      structureKey, chapterStructureKey: key, chapterCount: 3,
      chapterDurations: [70, 50, 40], audioGenerationState: 'ready', ...extra
    });
    // A reader inside the moved paragraph, and a bookmark on it.
    const insideMoved = opening.length + 1 + 5;
    h.files.positions = { users: { owner: { book_1: {
      chapterIndex: 0, timestamp: 50, characterOffset: insideMoved, chunkIndex: 3, chapterStructureKey: key
    } } } };
    h.files.bookmarks = { users: { owner: { book_1: [
      { id: 'bm_moved', chapterIndex: 0, timestamp: 50, characterOffset: insideMoved, chapterStructureKey: key },
      { id: 'bm_closing', chapterIndex: 2, timestamp: 10, characterOffset: 4, chapterStructureKey: key }
    ] } } };
    return { ...h, previous, next, key };
  }

  await test('boundary drift under an unchanged structure key remaps positions and bookmarks', async () => {
    const h = driftHarness();
    const baseline = await h.service.reconcileChapterStructure('book_1', h.previous);
    assert.strictEqual(baseline.status, STRUCTURE_RECONCILE_RESULT.UNCHANGED);
    assert.strictEqual(h.files.books.book_1.chapterTextIdentity.structureKey, h.key, 'the text identity is recorded going forward');
    assert.strictEqual(h.files.positions.users.owner.book_1.chapterIndex, 0, 'recording a baseline moves nothing');

    const operationsBefore = h.operations.length;
    assert.strictEqual((await h.service.reconcileChapterStructure('book_1', h.previous)).status,
      STRUCTURE_RECONCILE_RESULT.UNCHANGED);
    assert(!h.operations.slice(operationsBefore).some(op => op.startsWith('update:books')),
      'a matching identity takes the read-only fast path');

    const result = await h.service.reconcileChapterStructure('book_1', h.next);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.REMAPPED);
    const position = h.files.positions.users.owner.book_1;
    assert.strictEqual(position.chapterIndex, 1, 'the reader follows the moved paragraph');
    assert.strictEqual(position.characterOffset, 5);
    assert.strictEqual(position.chunkIndex, undefined, 'chunk coordinates of moved text are dropped');
    assert.strictEqual(position.chapterStructureKey, h.key);
    const [movedBookmark, closingBookmark] = h.files.bookmarks.users.owner.book_1;
    assert.strictEqual(movedBookmark.chapterIndex, 1);
    assert.strictEqual(movedBookmark.characterOffset, 5);
    assert.strictEqual(closingBookmark.chapterIndex, 2, 'a bookmark in an unchanged chapter stays put');
    assert.strictEqual(closingBookmark.timestamp, 10, 'an unchanged chapter keeps its exact time');
    assert(h.operations.includes('invalidate-audio:book_1:3:0,1'), 'only chapters whose text moved lose audio');
    assert.deepStrictEqual(h.files.books.book_1.chapterDurations, [null, null, 40]);
    assert.strictEqual(h.files.books.book_1.chapterCount, 3);
    assert(!h.files.books.book_1.metadataRefreshReconciliation);
    assert(!h.operations.includes('remove-positions:book_1'));
  });

  await test('a drift remap publishes the identity that device-held positions and downloads are checked against', async () => {
    const h = driftHarness();
    const { chapterLayoutKey } = require('../lib/chapter-reprocess');
    const { __test: serverTestHooks } = require('../server');
    await h.service.reconcileChapterStructure('book_1', h.previous);
    const before = await serverTestHooks.publicBookRecordWithCoverArtifact({ ...h.files.books.book_1, id: 'bad!id' });
    assert.strictEqual(before.textRemapId, undefined, 'no remap has happened yet');
    assert(before.chapterLayoutKey.startsWith(`${h.key}~`), 'the layout key names the structure and the text cut');

    await h.service.reconcileChapterStructure('book_1', h.next);
    const book = h.files.books.book_1;
    const position = h.files.positions.users.owner.book_1;
    assert(book.textRemapId, 'the book records the remap it applied');
    assert.strictEqual(position.textRemapId, book.textRemapId, 'remapped records name the same remap');
    assert.strictEqual(book.textRemap.fromId, '');
    assert.strictEqual(book.textRemap.next.streamHash, book.chapterTextIdentity.streamHash);
    const after = await serverTestHooks.publicBookRecordWithCoverArtifact({ ...book, id: 'bad!id' });
    assert.strictEqual(after.textRemapId, book.textRemapId);
    assert.strictEqual(after.textRemap, undefined, 'the stored identities stay private');
    assert.notStrictEqual(after.chapterLayoutKey, before.chapterLayoutKey, 'moved text changes the layout key');
    assert.strictEqual(after.chapterLayoutKey, chapterLayoutKey(h.key, book.chapterTextIdentity));
  });

  await test('an interrupted drift remap is replayed without moving a record twice', async () => {
    const h = driftHarness();
    await h.service.reconcileChapterStructure('book_1', h.previous);
    h.setPositionFailures(1);
    await assert.rejects(h.service.reconcileChapterStructure('book_1', h.next), /permission denied/);
    const pending = JSON.parse(JSON.stringify(h.files.books.book_1.metadataRefreshReconciliation.positions));
    assert.strictEqual(pending.type, 'remap');
    await h.service.reconcileChapterStructure('book_1', h.next);
    assert.strictEqual(h.files.positions.users.owner.book_1.chapterIndex, 1);
    assert.strictEqual(h.files.positions.users.owner.book_1.characterOffset, 5);

    // A crash after the stores were written but before the marker cleared.
    h.files.books.book_1.metadataRefreshReconciliation = { positions: pending };
    await h.service.reconcileChapterStructure('book_1', h.next);
    assert.strictEqual(h.files.positions.users.owner.book_1.chapterIndex, 1, 'a replay does not remap again');
    assert.strictEqual(h.files.positions.users.owner.book_1.characterOffset, 5);
    assert.strictEqual(h.files.bookmarks.users.owner.book_1[0].characterOffset, 5);
  });

  await test('changed narration under an unchanged key records a new identity without moving the reader', async () => {
    const h = driftHarness();
    await h.service.reconcileChapterStructure('book_1', h.previous);
    const edited = h.previous.map((chapter, index) => index === 1 ? { ...chapter, text: 'A corrected middle chapter.' } : chapter);
    const result = await h.service.reconcileChapterStructure('book_1', edited);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.UNCHANGED);
    assert.strictEqual(h.files.positions.users.owner.book_1.chapterIndex, 0);
    assert.strictEqual(h.files.positions.users.owner.book_1.chunkIndex, 3);
    assert(!h.operations.some(op => op.startsWith('invalidate-audio:')));
    const operationsBefore = h.operations.length;
    await h.service.reconcileChapterStructure('book_1', edited);
    assert(!h.operations.slice(operationsBefore).some(op => op.startsWith('update:books')),
      'the new identity is the baseline from now on');
  });

  await test('a book with no recorded structure is stamped rather than reset', async () => {
    const harness = metadataHarness({ chapterStructureKey: undefined });
    const result = await harness.service.reconcileChapterStructure('book_1', [{ title: 'One' }]);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.STAMPED);
    assert.strictEqual(
      harness.files.positions.owner.books.book_1.chapterStructureKey,
      'structure-new'
    );
    assert(!harness.operations.includes('remove-positions:book_1'));
    assert(!harness.operations.some(operation => operation.startsWith('invalidate-audio:')));
  });

  await test('reconciliation is a no-op when the book was deleted underneath it', async () => {
    const harness = metadataHarness({ chapterStructureKey: 'structure-old' });
    delete harness.files.books.book_1;
    const result = await harness.service.reconcileChapterStructure('book_1', [{ title: 'One' }]);
    assert.strictEqual(result.status, STRUCTURE_RECONCILE_RESULT.UNCHANGED);
    assert(!harness.operations.includes('remove-positions:book_1'));
  });

  await test('metadata refresh returns not found when deletion wins the persistence race', async () => {
    const harness = metadataHarness({ deleteBeforeBookUpdate: true });
    const result = await harness.service.refreshBook('book_1');
    assert.deepStrictEqual(result, { status: REFRESH_BOOK_RESULT.NOT_FOUND });
    assert(!harness.operations.some(operation => operation.startsWith('remove-cover:')));
    assert(!harness.operations.some(operation => operation.startsWith('remove-positions:')));
  });

  await test('metadata persistence failure leaves cover and positions untouched', async () => {
    const harness = metadataHarness({ failBookWrite: true });
    await assert.rejects(harness.service.refreshBook('book_1'), /permission denied/);
    assert(!harness.operations.some(operation => operation.startsWith('remove-cover:')));
    assert(!harness.operations.some(operation => operation.startsWith('remove-positions:')));
  });

  await test('cover eviction is best-effort and does not block position reconciliation', async () => {
    const harness = metadataHarness({
      chapterStructureKey: 'structure-old',
      coverFailures: 1
    });
    const first = await harness.service.refreshBook('book_1');
    assert.strictEqual(first.status, REFRESH_BOOK_RESULT.REFRESHED);
    assert.strictEqual(harness.files.positions.owner.books.book_1, undefined);
    assert(harness.files.books.book_1.metadataRefreshReconciliation.cover);
    assert.strictEqual(first.book.metadataRefreshReconciliation, undefined);

    const second = await harness.service.refreshBook('book_1');
    assert.strictEqual(second.status, REFRESH_BOOK_RESULT.REFRESHED);
    assert.strictEqual(harness.files.books.book_1.metadataRefreshReconciliation, undefined);
    assert.strictEqual(
      harness.operations.filter(operation => operation.startsWith('remove-cover:')).length,
      2
    );
  });

  await test('failed position reconciliation remains marked and succeeds on retry', async () => {
    const harness = metadataHarness({
      chapterStructureKey: 'structure-old',
      positionFailures: 1
    });
    await assert.rejects(harness.service.refreshBook('book_1'), /permission denied/);
    assert.strictEqual(harness.files.books.book_1.title, 'Fresh Title');
    assert(harness.files.books.book_1.metadataRefreshReconciliation.positions);
    assert(harness.files.positions.owner.books.book_1);

    const retry = await harness.service.refreshBook('book_1');
    assert.strictEqual(retry.status, REFRESH_BOOK_RESULT.REFRESHED);
    assert.strictEqual(harness.files.positions.owner.books.book_1, undefined);
    assert.strictEqual(harness.files.books.book_1.metadataRefreshReconciliation, undefined);
    assert.strictEqual(retry.book.metadataRefreshReconciliation, undefined);
  });

  await test('failed audio invalidation remains marked and succeeds on retry', async () => {
    const harness = metadataHarness({
      chapterStructureKey: 'structure-old',
      audioFailures: 1
    });
    await assert.rejects(harness.service.refreshBook('book_1'), /audio busy/);
    assert(harness.files.books.book_1.metadataRefreshReconciliation.audio);

    const retry = await harness.service.refreshBook('book_1');
    assert.strictEqual(retry.status, REFRESH_BOOK_RESULT.REFRESHED);
    assert.strictEqual(harness.files.books.book_1.metadataRefreshReconciliation, undefined);
    assert.strictEqual(
      harness.operations.filter(operation => operation.startsWith('invalidate-audio:')).length,
      2
    );
  });

  await test('audio invalidation quiesces durable preparation before deleting cache files', async () => {
    const operations = [];
    const worker = {
      quiesceChapterAllVariants: async (bookId, chapterIndex) => {
        operations.push(`quiesce:${bookId}:${chapterIndex}`);
      }
    };
    const invalidateBookAudio = createBookAudioInvalidator({
      stopPremiumPrep: async bookId => operations.push(`stop-premium:${bookId}`),
      waitForPremiumIdle: async bookId => operations.push(`premium-idle:${bookId}`),
      removePlaybackPrefetch: async bookId => operations.push(`remove-prefetch:${bookId}`),
      cancelOfflinePreparation: async bookId => operations.push(`cancel-offline:${bookId}`),
      waitForOfflineIdle: async bookId => operations.push(`offline-idle:${bookId}`),
      workers: () => [worker, worker],
      removeGenerationJournalEntries: async bookId => operations.push(`remove-journal:${bookId}`),
      invalidateCache: async affected => operations.push(`invalidate-cache:${affected.length}`)
    });

    await invalidateBookAudio('book_1', 2);

    const offlineIdleIndex = operations.indexOf('offline-idle:book_1');
    const firstQuiesceIndex = operations.indexOf('quiesce:book_1:0');
    const premiumIdleIndex = operations.indexOf('premium-idle:book_1');
    const journalIndex = operations.indexOf('remove-journal:book_1');
    const cacheIndex = operations.indexOf('invalidate-cache:2');
    assert(operations.includes('stop-premium:book_1'));
    assert(operations.includes('remove-prefetch:book_1'));
    assert(operations.includes('cancel-offline:book_1'));
    assert(offlineIdleIndex < firstQuiesceIndex);
    assert(firstQuiesceIndex < premiumIdleIndex);
    assert(premiumIdleIndex < journalIndex);
    assert(journalIndex < cacheIndex);
    assert.strictEqual(
      operations.filter(operation => operation.startsWith('quiesce:')).length,
      2
    );
  });

  await test('XBook metadata refresh invalidates the artifact before extraction', async () => {
    const harness = metadataHarness({ bookPath: '/cache/book_1.xbook.json' });
    await harness.service.refreshBook('book_1');
    assert(
      harness.operations.indexOf('invalidate:/cache/book_1.xbook.json') <
        harness.operations.indexOf('metadata:/cache/book_1.xbook.json')
    );
  });

  await test('book lifecycle HTTP routes keep method, path, and invalid-id contracts', async () => {
    const { app, __test: serverTestHooks } = require('../server');
    const projected = await serverTestHooks.publicBookRecordWithCoverArtifact({
      id: 'bad!id',
      title: 'Example',
      metadataRefreshReconciliation: {
        positions: { type: 'remove', structureKey: 'pending' }
      }
    });
    assert.strictEqual(projected.metadataRefreshReconciliation, undefined);

    for (const [method, routePath] of [
      ['delete', '/api/book/:bookId'],
      ['post', '/api/refresh-metadata/:bookId']
    ]) {
      const layer = app.router.stack.find(candidate =>
        candidate.route?.path === routePath && candidate.route.methods[method]
      );
      assert(layer, `${method.toUpperCase()} ${routePath} must remain registered`);
      const response = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        }
      };
      await layer.route.stack[0].handle(
        { params: { bookId: 'bad!id' } },
        response
      );
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(response.body, { error: 'Invalid book identifier' });
    }

    const deletionFeed = app.router.stack.find(candidate =>
      candidate.route?.path === '/api/offline/deletions' &&
      candidate.route.methods.get
    );
    assert(deletionFeed, 'GET /api/offline/deletions must remain registered');
    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
    await deletionFeed.route.stack[0].handle(
      { query: { since: '-1' } },
      response
    );
    assert.strictEqual(response.statusCode, 400);
    assert.deepStrictEqual(response.body, { error: 'Invalid deletion cursor' });
  });

  console.log(`book-lifecycle tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exit(1);
});
