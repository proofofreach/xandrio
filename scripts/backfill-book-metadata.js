#!/usr/bin/env node
// Maintenance script: backfill downloadSource / gutenbergId / coverPath metadata.
//
// Safety contract:
// - Resolves DATA_DIR and CACHE_DIR exactly like server.js so it edits the
//   catalog the running server actually uses.
// - Mutates only through the booksStore critical-update API: reads fail closed
//   (a corrupt or unreadable catalog aborts the run instead of being replaced
//   with an empty object), and writes are atomic with bounded backups.
// - Takes an OS-level O_EXCL lockfile for cross-process exclusion; json-store
//   locks are process-local and do not protect against a concurrent server.

const fs = require('fs').promises;
const path = require('path');
const { canonicalStorageDirectory } = require('../lib/book-artifact-paths');
const { createBooksStore } = require('../lib/books-store');
const jsonStore = require('../lib/json-store');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = canonicalStorageDirectory(process.env.DATA_DIR || path.join(ROOT, 'data'));
const CACHE_DIR = canonicalStorageDirectory(process.env.CACHE_DIR || path.join(ROOT, 'cache'));
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');
const LOCK_FILE = path.join(DATA_DIR, 'books.json.backfill.lock');

const booksStore = createBooksStore({ filePath: BOOKS_FILE, jsonStore, maxBackups: 5 });

function inferDownloadSource(book) {
  if (book.downloadSource) return book.downloadSource;
  if (book.uploadedFile) return 'upload';
  if (/^pg-\d+$/i.test(String(book.sourceHash || book.id || ''))) return 'gutenberg';
  if (book.zlibId) return 'zlibrary';
  return 'annas';
}

async function acquireLock() {
  let handle;
  try {
    handle = await fs.open(LOCK_FILE, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `Another backfill appears to be running (${LOCK_FILE} exists). ` +
        'If no backfill is running, remove the lockfile and retry.'
      );
    }
    throw err;
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
}

async function releaseLock() {
  await fs.unlink(LOCK_FILE).catch(() => {});
}

async function backfillBook(book, hooks, bookId) {
  let changed = false;

  if (book.id === undefined) {
    book.id = bookId;
    changed = true;
  }

  const downloadSource = inferDownloadSource(book);
  if (book.downloadSource !== downloadSource) {
    book.downloadSource = downloadSource;
    changed = true;
  }

  if (!book.gutenbergId && book.path) {
    const gutenbergId = await hooks.inferGutenbergIdFromBook(book.path, {
      hash: book.sourceHash || book.id,
      metadata: {
        publisher: book.publisher,
        title: book.title,
        author: book.author
      }
    });
    if (gutenbergId) {
      book.gutenbergId = gutenbergId;
      changed = true;
    }
  }

  const coverPath = path.join(CACHE_DIR, `${book.id}_cover.jpg`);
  try {
    await fs.access(coverPath);
    if (!book.coverPath) {
      book.coverPath = coverPath;
      changed = true;
    }
  } catch {
    const fetched = await hooks.ensureBookCover(book, { coverPath }).catch(() => undefined);
    if (fetched) {
      changed = true;
      return { changed, coverFetched: true };
    }
  }

  return { changed, coverFetched: false };
}

async function main(hooks) {
  await acquireLock();
  try {
    let updated = 0;
    let covers = 0;

    // Critical-store update: fail-closed read + atomic write + backups.
    const result = await booksStore.update(async books => {
      for (const [bookId, book] of Object.entries(books)) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await backfillBook(book, hooks, bookId);
        if (outcome.changed) updated++;
        if (outcome.coverFetched) covers++;
      }
      return books;
    });

    console.log(`Backfilled ${updated} book records; fetched ${covers} covers.`);
    return { updated, covers };
  } finally {
    await releaseLock();
  }
}

if (require.main === module) {
  const { __test } = require('../server');
  main({
    inferGutenbergIdFromBook: __test.inferGutenbergIdFromBook,
    ensureBookCover: __test.ensureBookCover
  }).catch(err => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { main, inferDownloadSource };
