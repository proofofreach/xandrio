#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { __test } = require('../server');

const ROOT = path.join(__dirname, '..');
const BOOKS_FILE = path.join(ROOT, 'data', 'books.json');
const CACHE_DIR = path.join(ROOT, 'cache');

async function loadBooks() {
  try {
    return JSON.parse(await fs.readFile(BOOKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveBooks(books) {
  await fs.writeFile(BOOKS_FILE, JSON.stringify(books, null, 2));
}

function inferDownloadSource(book) {
  if (book.downloadSource) return book.downloadSource;
  if (book.uploadedFile) return 'upload';
  if (/^pg-\d+$/i.test(String(book.sourceHash || book.id || ''))) return 'gutenberg';
  if (book.zlibId) return 'zlibrary';
  return 'annas';
}

async function main() {
  const books = await loadBooks();
  let updated = 0;
  let covers = 0;

  for (const book of Object.values(books)) {
    if (!book || !book.id) continue;
    let changed = false;

    const downloadSource = inferDownloadSource(book);
    if (book.downloadSource !== downloadSource) {
      book.downloadSource = downloadSource;
      changed = true;
    }

    if (!book.gutenbergId && book.path) {
      const gutenbergId = await __test.inferGutenbergIdFromBook(book.path, {
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
      const fetched = await __test.ensureBookCover(book, { coverPath }).catch(() => undefined);
      if (fetched) {
        covers++;
        changed = true;
      }
    }

    if (changed) updated++;
  }

  await saveBooks(books);
  console.log(`Backfilled ${updated} book records; fetched ${covers} covers.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
