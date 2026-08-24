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
      return { mtimeMs: stat.mtimeMs, size: stat.size };
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
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }

  console.log(`\nXBook Store tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
