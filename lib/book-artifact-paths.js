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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A book id may itself contain `_` (isSafeBookId allows it), which is also the
// field separator the TTS cache uses inside generated filenames. A bare
// `startsWith(id + '_')` therefore also matches a *different* book's artifacts
// whenever that book's id happens to be `<thisId>_something` (e.g. id `abc`
// wrongly claims files that belong to id `abc_2`). To make ownership
// unambiguous the id must be followed by exactly one of the known artifact
// suffixes, enumerated from the code that actually generates these filenames:
// lib/chunked-tts.js (chunkPathForVariant, chapterPathForVariant,
// cleanChapterPath, _concatListPath, _chapterHashPath, the
// `.narration-artifact.json` / `.part.<ext>` sidecars), lib/offline-audio-package.js
// (the `_offline_<16hex>` variant segment), lib/xbook-store.js (getXBookPath),
// and server.js's canonicalBookCoverPath.
const VARIANT_SEGMENT = '(?:_tts[a-f0-9]{10}|_offline_[a-f0-9]{16})';
const CHUNK_AUDIO_EXT = '(?:mp3|wav)';
const CHAPTER_AUDIO_EXT = '(?:mp3|wav|m4a)';

function managedArtifactPattern(bookId) {
  const id = escapeRegExp(bookId);
  return new RegExp(
    `^${id}(?:` +
      // source file, e.g. <id>.epub, <id>.pdf
      `\\.[A-Za-z0-9]+` +
      // extracted-text artifact
      `|\\.xbook\\.json` +
      // cover image
      `|_cover\\.jpg` +
      // stitched chapter audio (regular or muxed/clean variant)
      `|${VARIANT_SEGMENT}?_ch\\d+\\.${CHAPTER_AUDIO_EXT}` +
      // chapter chunk audio, and its narration-artifact sidecar
      `|${VARIANT_SEGMENT}?_ch\\d+_chunk\\d+\\.${CHUNK_AUDIO_EXT}(?:\\.narration-artifact\\.json)?` +
      // ffmpeg concat list files
      `|${VARIANT_SEGMENT}?_ch\\d+_concat(?:_clean)?\\.txt` +
      // cached chunk-text hash sidecar
      `|${VARIANT_SEGMENT}?_ch\\d+\\.texthash` +
      // in-progress concat output before it is renamed into place
      `|${VARIANT_SEGMENT}?_ch\\d+\\.${CHAPTER_AUDIO_EXT}\\.part\\.${CHUNK_AUDIO_EXT}` +
    `)$`
  );
}

function isManagedArtifactName(bookId, filename) {
  const id = String(bookId || '');
  if (!id) return false;
  return managedArtifactPattern(id).test(String(filename || ''));
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
  isManagedArtifactName,
  reconcileBookArtifactPaths
};
