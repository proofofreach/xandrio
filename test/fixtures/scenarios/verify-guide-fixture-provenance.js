#!/usr/bin/env node
// The ready-guide fixture must have the exact source identity the running
// server derives from its persisted book record. Otherwise a visual "full"
// state can become a stale-warning capture without any product regression.
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { provisionDataset } = require('./lib/provision');
const { createBookDocument } = require('../../../lib/book-document');
const { createXBookStore } = require('../../../lib/xbook-store');
const { createBookGuideSourceSnapshot } = require('../../../lib/book-guide-source');
const { chapterStructureKey } = require('../../../lib/chapter-structure');

async function main() {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-guide-provenance-'));
  try {
    const dataDir = path.join(runtimeDir, 'data');
    const cacheDir = path.join(runtimeDir, 'cache');
    await provisionDataset({ dataDir, cacheDir, dataset: 'full' });

    const books = JSON.parse(await fs.readFile(path.join(dataDir, 'books.json'), 'utf8'));
    const book = books['scn-fieldnotes'];
    const artifact = JSON.parse(await fs.readFile(path.join(cacheDir, 'book-guides', 'scn-fieldnotes.guide.json'), 'utf8'));
    let xbookStore;
    const document = createBookDocument({ getXBookStore: () => xbookStore });
    xbookStore = createXBookStore({
      cacheDir,
      getFileIdentity: async file => {
        const stat = await fs.stat(file);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      },
      invalidateFileIdentity: () => {},
      getBookFormatFromName: document.getFormatFromName
    });

    const chapters = await document.getChaptersCached(book.path);
    const snapshot = createBookGuideSourceSnapshot({ bookId: book.id, book, chapters });
    assert.strictEqual(book.chapterStructureKey, chapterStructureKey(chapters));
    assert.deepStrictEqual(artifact.source, {
      fingerprint: snapshot.fingerprint,
      language: snapshot.language,
      chapterStructureKey: snapshot.chapterStructureKey
    });
    console.log('scenario guide fixture provenance regression: 2 passed, 0 failed');
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
