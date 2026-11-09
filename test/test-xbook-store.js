const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createXBookStore } = require('../lib/xbook-store');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

async function rejects(operation) {
  try {
    await operation();
    return false;
  } catch (error) {
    return error.message === 'Invalid book ID' ||
      error.message === 'XBook artifact path must stay inside the cache directory';
  }
}

function createStore(cacheDir) {
  return createXBookStore({
    cacheDir,
    getFileIdentity: async filePath => {
      const stat = await fs.stat(filePath);
      return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, ctimeMs: stat.ctimeMs };
    },
    invalidateFileIdentity() {},
    extractBookMetadata: async () => ({ title: 'Test book' }),
    extractBookChapters: async () => [{ title: 'Chapter 1', type: 'chapter', text: 'Readable prose.' }],
    extractMobiCover: async () => false,
    getBookFormatFromName: () => 'pdf'
  });
}

(async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexandrio-xbook-store-'));
  try {
    const store = createStore(cacheDir);
    const invalidIds = ['../evil', path.resolve(cacheDir, 'evil'), 'book/evil', '..'];
    const invalidPathsRejected = await Promise.all(invalidIds.map(async bookId => {
      const pathRejected = await rejects(async () => store.getXBookPath(bookId));
      const writeRejected = await rejects(() => store.writeXBookArtifact(bookId, '/library/book.pdf'));
      return pathRejected && writeRejected;
    }));
    assert(invalidPathsRejected.every(Boolean),
      'rejects traversal, absolute, separator, and dot-dot IDs before cache access');

    const outsideArtifact = `${cacheDir}.outside.xbook.json`;
    assert(await rejects(() => store.readXBookArtifact(outsideArtifact)),
      'rejects reads whose artifact path escapes the cache directory');

    const escapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexandrio-xbook-escape-'));
    try {
      const secret = path.join(escapeDir, 'secret.xbook.json');
      await fs.writeFile(secret, '{"id":"nope"}');
      const linked = path.join(cacheDir, 'escaped.xbook.json');
      await fs.symlink(secret, linked);
      assert(await rejects(() => store.readXBookArtifact(linked)),
        'rejects reads that symlink out of the cache directory');
    } finally {
      await fs.rm(escapeDir, { recursive: true, force: true });
    }

    const bookId = 'book.2026-08_24';
    const written = await store.writeXBookArtifact(bookId, '/library/book.pdf');
    const loaded = await store.readXBookArtifact(written.xbookPath);
    assert(loaded.id === bookId && loaded.metadata.title === 'Test book' &&
      path.dirname(written.xbookPath) === path.resolve(cacheDir),
    'allows legitimate IDs to write and read artifacts inside the cache directory');

    const atomicId = 'atomic-book';
    const atomicPath = store.getXBookPath(atomicId);
    const originalContents = JSON.stringify({ _xbookVersion: 1, id: atomicId, chapters: [] });
    await fs.writeFile(atomicPath, originalContents);
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    let tempOpenFlags;
    let releaseRename;
    let signalRename;
    const renameReached = new Promise(resolve => { signalRename = resolve; });
    const renameReleased = new Promise(resolve => { releaseRename = resolve; });
    fs.open = async (filePath, flags, ...args) => {
      if (String(filePath).startsWith(`${atomicPath}.`)) tempOpenFlags = flags;
      return originalOpen(filePath, flags, ...args);
    };
    fs.rename = async (from, to) => {
      if (path.resolve(to) === atomicPath) {
        signalRename();
        await renameReleased;
      }
      return originalRename(from, to);
    };
    try {
      const write = store.writeXBookArtifact(atomicId, '/library/book.pdf');
      await renameReached;
      const observedDuringWrite = await fs.readFile(atomicPath, 'utf8');
      assert(observedDuringWrite === originalContents && tempOpenFlags === 'wx',
        'writes through an exclusive temporary file without exposing partial artifact content');
      releaseRename();
      await write;
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRename;
    }
    const finalArtifact = JSON.parse(await fs.readFile(atomicPath, 'utf8'));
    assert(finalArtifact.id === atomicId && finalArtifact.metadata.title === 'Test book',
      'atomically replaces the artifact after the complete temporary file is ready');

    // Memory cache identity: a same-size, same-mtime replacement must not keep
    // serving stale content, and the shared cached object must be immutable.
    const cachedId = 'cached-book';
    const cachedPath = store.getXBookPath(cachedId);
    const first = { _xbookVersion: 1, id: cachedId, chapters: [{ title: 'AAAA', type: 'chapter', text: 'one' }] };
    const second = { _xbookVersion: 1, id: cachedId, chapters: [{ title: 'BBBB', type: 'chapter', text: 'one' }] };
    assert(JSON.stringify(first).length === JSON.stringify(second).length, 'fixture artifacts must be equal length');
    await fs.writeFile(cachedPath, JSON.stringify(first));
    const firstStat = await fs.stat(cachedPath);
    const loadedFirst = await store.readXBookArtifact(cachedPath);
    assert(loadedFirst.chapters[0].title === 'AAAA', 'reads the first artifact');
    assert(Object.isFrozen(loadedFirst) && Object.isFrozen(loadedFirst.chapters) && Object.isFrozen(loadedFirst.chapters[0]),
      'cached artifacts are frozen so no caller can mutate the shared copy');
    assert(await store.readXBookArtifact(cachedPath) === loadedFirst, 'an unchanged file is served from memory');
    // Pin mtime and size so only the inode and ctime can distinguish the files.
    const pinnedStore = createXBookStore({
      cacheDir,
      getFileIdentity: async filePath => {
        const stat = await fs.stat(filePath);
        return { mtimeMs: firstStat.mtimeMs, size: firstStat.size, ino: stat.ino, ctimeMs: stat.ctimeMs };
      },
      invalidateFileIdentity() {},
      extractBookMetadata: async () => ({}),
      extractBookChapters: async () => [],
      extractMobiCover: async () => false,
      getBookFormatFromName: () => 'pdf'
    });
    assert((await pinnedStore.readXBookArtifact(cachedPath)).chapters[0].title === 'AAAA', 'pinned store reads the first artifact');
    await fs.writeFile(`${cachedPath}.replace`, JSON.stringify(second));
    await fs.rename(`${cachedPath}.replace`, cachedPath);
    const loadedSecond = await pinnedStore.readXBookArtifact(cachedPath);
    assert(loadedSecond.chapters[0].title === 'BBBB',
      'a replaced artifact with identical mtime and size is re-read (inode/ctime are part of the cache key)');
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }

  console.log(`\nXBook Store tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
