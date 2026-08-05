const fs = require('node:fs');
const path = require('node:path');

const BOOK_ARTIFACT_FIELDS = [
  'path',
  'sourcePath',
  'retainedSourcePath',
  'extractedArtifact',
  'coverPath'
];

function canonicalStorageDirectory(directory, realpath = fs.realpathSync.native) {
  const resolved = path.resolve(directory);
  try {
    return realpath(resolved);
  } catch {
    // Fresh installations create these directories during startup. A missing
    // directory has no symlink target to resolve yet, so its absolute path is
    // already the durable identity.
    return resolved;
  }
}

function isManagedArtifactName(bookId, filename) {
  const id = String(bookId || '');
  return Boolean(id) && (
    filename.startsWith(`${id}.`) ||
    filename.startsWith(`${id}_`)
  );
}

function canonicalArtifactPath(bookId, storedPath, cacheDir, exists = fs.existsSync) {
  if (typeof storedPath !== 'string' || !storedPath) return storedPath;
  const filename = path.basename(storedPath);
  if (!isManagedArtifactName(bookId, filename)) return storedPath;
  const candidate = path.join(cacheDir, filename);
  return exists(candidate) ? candidate : storedPath;
}

async function reconcileBookArtifactPaths({
  cacheDir,
  loadBooks,
  saveBooks,
  exists = fs.existsSync
}) {
  if (!cacheDir || !loadBooks || !saveBooks) {
    throw new TypeError('Book artifact reconciliation requires cacheDir, loadBooks, and saveBooks');
  }
  const books = await loadBooks();
  let repairedBooks = 0;
  let repairedPaths = 0;

  for (const [bookId, book] of Object.entries(books || {})) {
    if (!book || typeof book !== 'object') continue;
    let repairedBook = false;
    for (const field of BOOK_ARTIFACT_FIELDS) {
      const current = book[field];
      const canonical = canonicalArtifactPath(bookId, current, cacheDir, exists);
      if (canonical === current) continue;
      book[field] = canonical;
      repairedBook = true;
      repairedPaths += 1;
    }
    if (repairedBook) repairedBooks += 1;
  }

  if (repairedPaths) await saveBooks(books);
  return { repairedBooks, repairedPaths };
}

module.exports = {
  BOOK_ARTIFACT_FIELDS,
  canonicalArtifactPath,
  canonicalStorageDirectory,
  reconcileBookArtifactPaths
};
