/**
 * Fast preflight for test/fixtures/scenarios/lib/provision.js's cover-copy
 * step (writeBookXBook, `fs.copyFile(coverSrc, coverDest)`).
 *
 * provision.js resolves each book's `cover` field in content/books.json
 * against a filename in covers/ and copies it — if the two disagree
 * (wrong extension, typo, deleted file) that copy throws ENOENT deep inside
 * provisioning the 'full' dataset, which only surfaces after
 * `scenario:shots` has already spent time booting five server processes and
 * produces zero screenshots for every view, not just the broken book. This
 * catches the same class of mismatch in milliseconds, before any server
 * boots, and reports every broken reference in one pass rather than
 * stopping at the first one.
 *
 * covers/ only contains real JPEGs (see .gitignore's
 * `!test/fixtures/scenarios/covers/*.jpg` allowlist and provision.js's
 * `${bookContent.id}_cover.jpg` destination name) — a `cover` field must
 * both exist on disk and decode as a JPEG, not merely resolve to a path.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, 'content');
const COVERS_DIR = path.join(__dirname, 'covers');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function isJpeg(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(3);
    fs.readSync(fd, header, 0, 3, 0);
    return header.equals(JPEG_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function main() {
  const books = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'books.json'), 'utf8'));
  assert.ok(Array.isArray(books) && books.length > 0, 'content/books.json must contain at least one book');

  for (const book of books) {
    test(`${book.id}: cover "${book.cover}" resolves to a file in covers/`, () => {
      const coverPath = path.join(COVERS_DIR, book.cover);
      assert.ok(
        fs.existsSync(coverPath),
        `content/books.json references cover "${book.cover}" for ${book.id}, but ` +
        `${path.relative(process.cwd(), coverPath)} does not exist — ` +
        `provision.js's fs.copyFile() will throw ENOENT while provisioning the 'full' dataset`
      );
    });

    test(`${book.id}: cover "${book.cover}" is a real JPEG`, () => {
      const coverPath = path.join(COVERS_DIR, book.cover);
      if (!fs.existsSync(coverPath)) return; // already reported above
      assert.ok(
        isJpeg(coverPath),
        `${path.relative(process.cwd(), coverPath)} does not start with the JPEG magic bytes ` +
        `(ffd8ff) — provision.js always names the copied file "<id>_cover.jpg"`
      );
    });
  }

  const coverFiles = new Set(fs.readdirSync(COVERS_DIR));
  const referenced = new Set(books.map(book => book.cover));
  for (const file of coverFiles) {
    test(`covers/${file} is referenced by some book in content/books.json`, () => {
      assert.ok(referenced.has(file), `covers/${file} exists but no book.cover in content/books.json points to it`);
    });
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`scenario fixture integrity tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
