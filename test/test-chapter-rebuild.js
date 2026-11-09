const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const jsonStore = require('../lib/json-store');
const { createBookMutationLocks } = require('../lib/book-mutation-lock');
const { buildChapterTransition } = require('../lib/chapter-reprocess');
const { createChapterRebuildService } = require('../lib/chapter-rebuild');

function chapter(title) {
  return {
    title,
    type: 'chapter',
    text: 'Conserved narration text. '.repeat(80),
    estimatedDuration: 120
  };
}

async function fixture(onStep = null, serviceOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-rebuild-'));
  const files = {
    books: path.join(dir, 'books.json'),
    positions: path.join(dir, 'positions.json'),
    bookmarks: path.join(dir, 'bookmarks.json'),
    transitions: path.join(dir, 'chapter-transitions.json')
  };
  const artifactPath = path.join(dir, 'book.xbook.json');
  const oldArtifact = {
    _xbookVersion: 2,
    processingVersion: 0,
    sourceFormat: 'PDF',
    chapters: [chapter('Old boundary')],
    sourceDocument: { pages: [{ pageNumber: 1, text: 'source' }] }
  };
  const candidate = {
    ...oldArtifact,
    processingVersion: 1,
    chapters: [chapter('Authored boundary')]
  };
  const transition = buildChapterTransition(oldArtifact.chapters, candidate.chapters);
  await Promise.all([
    jsonStore.save(artifactPath, oldArtifact),
    jsonStore.save(files.books, {
      book: { id: 'book', path: artifactPath, chapterStructureKey: 'old-key', chapterCount: 1 }
    }),
    jsonStore.save(files.positions, {
      users: { reader: { book: { chapterIndex: 0, timestamp: 60, chunkIndex: 2, chunkTime: 4, chapterStructureKey: 'old-key' } } }
    }),
    jsonStore.save(files.bookmarks, {
      users: { reader: { book: [{ id: 'mark', chapterIndex: 0, timestamp: 30 }] } }
    }),
    jsonStore.save(files.transitions, {})
  ]);
  const xbookStore = {
    planXBookRebuild: async () => ({
      safe: true,
      changed: true,
      artifact: oldArtifact,
      candidate,
      transition,
      previousStructureKey: 'old-key',
      nextStructureKey: 'new-key'
    }),
    invalidateXBookArtifactCache() {}
  };
  const service = createChapterRebuildService({
    files,
    xbookStore,
    locks: createBookMutationLocks(),
    onStep,
    ...serviceOptions
  });
  return { dir, files, artifactPath, oldArtifact, candidate, service };
}

(async () => {
  {
    const value = await fixture();
    try {
      const result = await value.service.rebuild('book');
      const [artifact, books, positions, bookmarks, transitions] = await Promise.all([
        jsonStore.load(value.artifactPath),
        jsonStore.load(value.files.books),
        jsonStore.load(value.files.positions),
        jsonStore.load(value.files.bookmarks),
        jsonStore.load(value.files.transitions)
      ]);
      assert(result.changed && artifact.chapters[0].title === 'Authored boundary',
        'commits a validated text-conserving rebuild');
      assert(books.book.chapterStructureKey === 'new-key' && transitions.book.previousStructureKey === 'old-key',
        'journals the structure key and one-transition map in the same transaction');
      assert(positions.users.reader.book.timestamp === 60 && positions.users.reader.book.chunkIndex === 2,
        'preserves listening time and unchanged chunk anchors');
      assert(bookmarks.users.reader.book[0].timestamp === 30,
        'preserves bookmark time');
      assert(bookmarks.users.reader.book[0].chapterStructureKey === 'new-key',
        'stamps bookmarks with the committed structure key');
      await assert.rejects(fs.access(`${value.artifactPath}.rebuild-backup.json`), { code: 'ENOENT' });
      await assert.rejects(fs.access(`${value.artifactPath}.rebuild-journal.json`), { code: 'ENOENT' });
      assert.deepStrictEqual(
        (await fs.readdir(value.dir)).filter(name => name.includes('.rebuild-')),
        [
          'book.xbook.json.rebuild-candidate.json.lock.sqlite',
          'book.xbook.json.rebuild-journal.json.lock.sqlite'
        ],
        'a committed rebuild retains only persistent mutexes: no backup, candidate, or transaction history'
      );
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    // Journals from another version or shape are quarantined, never replayed.
    const { journalPaths, TRANSACTION_VERSION, unsupportedJournalReason } = require('../lib/chapter-rebuild');
    const value = await fixture();
    try {
      const paths = journalPaths(value.artifactPath);
      const before = await jsonStore.load(value.files.positions);
      const legacyJournal = {
        transactionVersion: 2,
        bookId: 'book',
        xbookPath: value.artifactPath,
        ...paths,
        started: ['artifact', 'positions'],
        completed: ['artifact'],
        // Pre-slice shape: whole stores, including other users' records.
        snapshots: { books: { book: { id: 'book' } }, positions: { users: {} }, bookmarks: { users: {} }, transitions: {} }
      };
      await fs.copyFile(value.artifactPath, paths.backupPath);
      await fs.writeFile(paths.backupPath, JSON.stringify({ ...value.oldArtifact, chapters: [chapter('Stale backup')] }));
      await jsonStore.save(paths.journalPath, legacyJournal);
      const recovery = await value.service.recoverBook('book');
      assert(recovery.quarantined && /version-2/.test(recovery.reason), 'an older transaction version is quarantined');
      assert.deepStrictEqual(await jsonStore.load(value.files.positions), before, 'nothing is restored from a quarantined journal');
      assert.strictEqual((await jsonStore.load(value.artifactPath)).chapters[0].title, 'Old boundary', 'the live artifact is untouched');
      await assert.rejects(fs.access(paths.journalPath), { code: 'ENOENT' });
      assert((await fs.readdir(value.dir)).some(name => /^book\.xbook\.json\.rebuild-journal\.json\.quarantined-\d+$/.test(name)),
        'the journal is kept under a quarantine name');
      assert.strictEqual(unsupportedJournalReason({ ...legacyJournal, transactionVersion: TRANSACTION_VERSION }), 'whole-store-snapshot',
        'a current-version journal with whole-store snapshots is also refused');
      assert.strictEqual(unsupportedJournalReason({ ...legacyJournal, transactionVersion: TRANSACTION_VERSION,
        snapshots: { books: { id: 'book' }, positions: { reader: {} }, bookmarks: {}, transitions: null } }), null);
      const retry = await value.service.rebuild('book');
      assert(retry.changed, 'after quarantine a fresh rebuild proceeds normally');
      assert((await jsonStore.load(value.files.books)).book.chapterStructureKey === 'new-key');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    // A journal left by a deleted book must not be applied to a re-import
    // that reused the id: the record's addedAt stamp must match.
    const { journalPaths } = require('../lib/chapter-rebuild');
    let crashed = false;
    const value = await fixture(step => {
      if (step === 'after:transitions' && !crashed) {
        crashed = true;
        const error = new Error('simulated crash');
        error.simulateCrash = true;
        throw error;
      }
    });
    try {
      await jsonStore.update(value.files.books, data => { data.book.addedAt = '2026-01-01T00:00:00.000Z'; });
      await assert.rejects(value.service.rebuild('book'), /simulated crash/);
      const paths = journalPaths(value.artifactPath);
      const journal = await jsonStore.load(paths.journalPath);
      assert.strictEqual(journal.bookAddedAt, '2026-01-01T00:00:00.000Z', 'journals are stamped with the record addedAt');
      assert(Number.isInteger(journal.owner?.pid) && typeof journal.owner?.startedAt === 'string', 'journals record their owner process');
      // Simulate delete + re-import with the same id: new record, new artifact.
      await jsonStore.update(value.files.books, data => { data.book.addedAt = '2026-02-02T00:00:00.000Z'; });
      await jsonStore.save(value.artifactPath, { ...value.oldArtifact, chapters: [chapter('Re-imported')] });
      const recovery = await value.service.recoverBook('book');
      assert(recovery.quarantined && recovery.reason === 'book-replaced', 'recovery refuses a journal from a previous import');
      assert.strictEqual((await jsonStore.load(value.artifactPath)).chapters[0].title, 'Re-imported', 'the new artifact is not rolled back');
      // The uncommitted transitions write stays, which a fresh rebuild overwrites.
      const retry = await value.service.rebuild('book');
      assert(retry.changed, 'the re-imported book can still be rebuilt');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    // Orphaned rebuild files for books that no longer exist are swept once at
    // startup; an absent or empty catalog never sweeps.
    const value = await fixture(null, {});
    try {
      const { createChapterRebuildService } = require('../lib/chapter-rebuild');
      const service = createChapterRebuildService({
        files: value.files,
        cacheDir: value.dir,
        xbookStore: { planXBookRebuild: async () => ({ safe: false }) },
        locks: createBookMutationLocks()
      });
      const orphans = [
        'gone.xbook.json.rebuild-journal.json',
        'gone.xbook.json.rebuild-backup.json',
        'gone.xbook.json.rebuild-candidate.json',
        'gone.xbook.json.rebuild-candidate.json.lock.sqlite',
        'gone.xbook.json.rebuild-journal.json.quarantined-1700000000000',
        'legacy.chapters.json.rebuild-backup.json'
      ];
      const kept = [
        'book.xbook.json.rebuild-backup.json',   // existing book
        'gone.xbook.json',                      // not a rebuild file
        'gone.xbook.json.rebuild-backup.json.bak' // not the exact grammar
      ];
      for (const name of [...orphans, ...kept]) await fs.writeFile(path.join(value.dir, name), '{}');
      assert.deepStrictEqual(await service.sweepOrphanedRebuildArtifacts(), { removed: orphans.length });
      const remaining = (await fs.readdir(value.dir)).filter(name => orphans.includes(name) || kept.includes(name)).sort();
      assert.deepStrictEqual(remaining, [...kept].sort(), 'only exact-grammar files of absent books are removed');

      await jsonStore.save(value.files.books, {});
      await fs.writeFile(path.join(value.dir, 'gone.xbook.json.rebuild-backup.json'), '{}');
      assert.deepStrictEqual(await service.sweepOrphanedRebuildArtifacts(), { removed: 0 }, 'an empty catalog sweeps nothing');
      await fs.unlink(value.files.books);
      assert.deepStrictEqual(await service.sweepOrphanedRebuildArtifacts(), { removed: 0 }, 'a missing catalog sweeps nothing');
      await fs.access(path.join(value.dir, 'gone.xbook.json.rebuild-backup.json'));
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    // A book deleted between the snapshot and the books.json write must not
    // be written back, and the catalog store must not be saved at all.
    const writes = [];
    let value;
    value = await fixture(async step => {
      if (step === 'before:books') {
        await jsonStore.update(value.files.books, data => { delete data.book; });
      }
    }, {
      updateJSON: async (filePath, mutator, defaultValue = {}) => {
        const result = await jsonStore.update(filePath, mutator, defaultValue);
        writes.push({ file: path.basename(filePath), skipped: result === jsonStore.SKIP_SAVE });
        return result;
      }
    });
    try {
      const result = await value.service.rebuild('book');
      assert(result.changed, 'the rebuild still completes for the remaining stores');
      const booksWrite = writes.find(write => write.file === 'books.json');
      assert(booksWrite && booksWrite.skipped, 'the books.json write is skipped when the record is gone');
      assert.deepStrictEqual(await jsonStore.load(value.files.books), {}, 'a deleted book is not resurrected by the rebuild');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    const errors = [];
    const value = await fixture(step => {
      if (step === 'committed') {
        const error = new Error('simulated committed crash');
        error.simulateCrash = true;
        throw error;
      }
    }, {
      afterCommit: async () => { throw new Error('persistent audio failure'); },
      onPostCommitError: async event => errors.push(event.error.message)
    });
    try {
      await assert.rejects(value.service.rebuild('book'), /simulated committed crash/);
      const recovery = await value.service.recoverBook('book');
      assert(recovery.pending && errors.includes('persistent audio failure'),
        'persistent post-commit audio recovery remains pending without blocking startup');
      const retry = await value.service.rebuild('book');
      assert.deepStrictEqual(retry, { changed: false, reason: 'recovery-pending' },
        'a new rebuild cannot overwrite a pending committed recovery journal');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    const value = await fixture(null, {
      xbookStore: {
        planXBookRebuild: async () => ({ safe: false, changed: false, reason: 'narration-text-mismatch' }),
        invalidateXBookArtifactCache() {}
      }
    });
    try {
      const result = await value.service.rebuild('book');
      assert.deepStrictEqual(result, { changed: false, reason: 'unsafe-rebuild' },
        'a rebuild that cannot conserve continuous narration is refused');
      assert.strictEqual((await jsonStore.load(value.artifactPath)).chapters[0].title, 'Old boundary',
        'an unsafe rebuild leaves the accepted artifact unchanged');
      assert(!(await fs.readdir(value.dir)).some(name => name.includes('.rebuild-')),
        'an unsafe plan publishes no backup, candidate, or journal');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  for (const boundary of ['artifact', 'transitions', 'books', 'positions', 'bookmarks']) {
    for (const side of ['before', 'after']) {
    const value = await fixture(step => {
      if (step === `${side}:${boundary}`) {
        const error = new Error(`simulated crash ${side} ${boundary}`);
        error.simulateCrash = true;
        throw error;
      }
    });
    try {
      await assert.rejects(value.service.rebuild('book'), /simulated crash/);
      await value.service.recoverBook('book');
      const [artifact, books, positions, bookmarks, transitions] = await Promise.all([
        jsonStore.load(value.artifactPath),
        jsonStore.load(value.files.books),
        jsonStore.load(value.files.positions),
        jsonStore.load(value.files.bookmarks),
        jsonStore.load(value.files.transitions)
      ]);
      assert(artifact.chapters[0].title === 'Old boundary' &&
        books.book.chapterStructureKey === 'old-key' &&
        positions.users.reader.book.timestamp === 60 &&
        bookmarks.users.reader.book[0].timestamp === 30 &&
        !transitions.book,
      `recovers every store after a crash ${side} the ${boundary} boundary`);
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
    }
  }

  {
    const postCommitErrors = [];
    const value = await fixture(null, {
      afterCommit: async () => { throw new Error('audio reconciliation failed'); },
      onPostCommitError: async event => postCommitErrors.push(event.error.message)
    });
    try {
      const result = await value.service.rebuild('book');
      assert(result.changed && postCommitErrors[0] === 'audio reconciliation failed',
        'keeps the durable rebuild and reports a regenerable post-commit failure');
      await fs.access(`${value.artifactPath}.rebuild-journal.json`);
      assert.strictEqual((await jsonStore.load(`${value.artifactPath}.rebuild-journal.json`)).committedBook.chapterStructureKey,
        'new-key', 'retains a committed recovery record until audio reconciliation succeeds');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    let crash = true;
    let reconciliations = 0;
    const value = await fixture(null, {
      afterCommit: async () => {
        reconciliations += 1;
        if (crash) {
          const error = new Error('simulated crash during audio reconciliation');
          error.simulateCrash = true;
          throw error;
        }
      }
    });
    try {
      await assert.rejects(value.service.rebuild('book'), /simulated crash during audio/);
      const artifact = await jsonStore.load(value.artifactPath);
      assert.strictEqual(artifact.chapters[0].title, 'Authored boundary',
        'a crash after the durable commit does not roll back the accepted structure');
      crash = false;
      const recovered = await value.service.recoverBook('book');
      assert(recovered.rolledForward && reconciliations === 2,
        'startup recovery resumes post-commit reconciliation and rolls forward');
      await assert.rejects(fs.access(`${value.artifactPath}.rebuild-journal.json`), { code: 'ENOENT' });
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    const value = await fixture(step => {
      if (step === 'after:books') {
        const error = new Error('simulated startup crash');
        error.simulateCrash = true;
        throw error;
      }
    });
    try {
      await assert.rejects(value.service.rebuild('book'), /simulated startup crash/);
      const recovered = await value.service.recoverAll();
      assert.strictEqual(recovered.length, 1,
        'startup recovery discovers and rolls back an interrupted transaction');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  {
    // GET /api/book holds the same per-book mutation lock while it reads
    // chapters. That reader is not a rebuild, so a rebuild must wait for it
    // and run, not report "rebuild-in-progress" without rebuilding anything.
    const value = await fixture();
    try {
      let releaseReader;
      const reader = value.service.locks.withBookMutationLock('book', () =>
        new Promise(resolve => { releaseReader = resolve; }));
      await new Promise(resolve => setImmediate(resolve));
      const rebuild = value.service.rebuild('book');
      const concurrent = value.service.rebuild('book');
      releaseReader();
      await reader;
      const result = await rebuild;
      assert(result.changed, 'a rebuild queued behind a non-rebuild lock holder still rebuilds');
      assert.deepStrictEqual(await concurrent, { changed: false, reason: 'rebuild-in-progress' },
        'a second rebuild issued while one is pending reports that a rebuild is running');
      const artifact = await jsonStore.load(value.artifactPath);
      assert.strictEqual(artifact.chapters[0].title, 'Authored boundary');
    } finally {
      await fs.rm(value.dir, { recursive: true, force: true });
    }
  }

  console.log('30 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
