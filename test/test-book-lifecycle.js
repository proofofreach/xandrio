const assert = require('assert');
const path = require('path');
const {
  DELETE_BOOK_RESULT,
  createBookArtifactCleaner,
  createBookDeletionService
} = require('../lib/book-deletion');
const {
  REFRESH_BOOK_RESULT,
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
    rememberDeletedBookId: bookId => operations.push(`remember:${bookId}`),
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
    scheduleArtifactSweeps: bookId => operations.push(`sweep:${bookId}`),
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
  const operations = [];
  let booksUpdateCount = 0;
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
      (file === 'positions' && positionFailuresRemaining > 0)
    ) {
      if (file === 'positions') positionFailuresRemaining--;
      throw new Error('permission denied');
    }
    if (result !== skipSave) files[file] = working;
    operations.push(`update:${file}:${result === skipSave ? 'skipped' : 'saved'}`);
    return result;
  };

  const service = createBookMetadataRefreshService({
    booksFile: 'books',
    positionsFile: 'positions',
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
    chapterStructureKey: () => options.refreshedStructureKey || 'structure-new',
    bookRecordOpenLibraryFields: identity => ({
      openLibraryWorkKey: identity.openLibraryWorkKey
    }),
    canonicalWorkKey: (title, author) => `${title}:${author}`,
    invalidateBookAudio: async (bookId, chapterCount) => {
      operations.push(`invalidate-audio:${bookId}:${chapterCount}`);
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
    setBookPositionsStructureKey: (positions, bookId, structureKey) => {
      operations.push(`set-structure:${bookId}:${structureKey}`);
      for (const user of Object.values(positions)) {
        if (user.books?.[bookId]) user.books[bookId].chapterStructureKey = structureKey;
      }
    },
    now: () => new Date('2026-07-24T12:00:00.000Z'),
    log: { warn: message => operations.push(`warn:${message}`) }
  });

  return { service, files, operations };
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

  await test('downstream deletion-store failures stop at a deterministic boundary', async () => {
    for (const [failedFile, expectedSaved, expectedUntouched] of [
      ['positions', [], ['bookmarks', 'shelves']],
      ['bookmarks', ['positions'], ['shelves']],
      ['shelves', ['positions', 'bookmarks'], []]
    ]) {
      const harness = deletionHarness({ failFile: failedFile });
      await assert.rejects(
        harness.service.deleteBook({ bookId: 'book_1', actor: { role: 'admin' } }),
        /disk full/
      );
      assert.strictEqual(harness.files.books.book_1, undefined);
      assert(harness.operations.includes('cleanup:book_1:Example'));
      for (const file of expectedSaved) {
        assert(harness.operations.includes(`update:${file}:saved`));
      }
      for (const file of expectedUntouched) {
        assert(!harness.operations.some(operation => operation.startsWith(`update:${file}:`)));
      }
    }
  });

  await test('artifact cleanup is cache-bounded and reports individual failures', async () => {
    const removed = [];
    const invalidated = [];
    const cleaner = createBookArtifactCleaner({
      cacheDir: '/cache',
      fs: {
        readdir: async () => ['book_1_audio.mp3', 'other_audio.mp3'],
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
    assert(removed.includes('/cache/book_1_audio.mp3'));
    assert(!removed.includes('/outside/source.epub'));
    assert.deepStrictEqual(result.failed, [{
      path: '/cache/book_1_cover.jpg',
      error: 'permission denied'
    }]);
    assert(!invalidated.includes('/cache/book_1_cover.jpg'));
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
