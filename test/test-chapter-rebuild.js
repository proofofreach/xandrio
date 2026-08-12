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
      await fs.access(`${value.artifactPath}.rebuild-backup.json`);
      await assert.rejects(fs.access(`${value.artifactPath}.rebuild-journal.json`), { code: 'ENOENT' });
      assert.deepStrictEqual(
        (await fs.readdir(value.dir)).filter(name => name.includes('.rebuild-')),
        ['book.xbook.json.rebuild-backup.json'],
        'a committed rebuild retains exactly one bounded prior artifact and no transaction history'
      );
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

  console.log('27 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
