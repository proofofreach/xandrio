const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ownerProcessGone, PROCESS_STARTED_AT } = require('./abandoned-temp-files');
const { BOOK_ARTIFACT_FIELDS } = require('./book-artifact-paths');
const { writeFileAtomic } = require('./write-file-atomic');

// An import writes into cache/ long before books.json has a record for it, and
// it tracks what it owns only in memory. A crash in that window leaves files no
// record reaches. Each import therefore keeps a durable claim marker that lists,
// before the first write, every path it may create, tagged with its writer's
// PID and start time. The marker goes away when ownership transfers (the
// record commits) or cleanup removes the files.
//
// The startup sweep deletes only paths a dead owner's marker lists, and only
// when no books.json record owns them. Matching cache/ by id pattern instead
// would delete any id-named file, wipe the library when books.json is missing
// or restored, and race a second process that has files before its record.

const MARKER_NAME = /^([1-9]\d*)\.[a-f0-9]{16}\.json$/;
const MARKER_TEMP_NAME = /^([1-9]\d*)\.[a-f0-9]{16}\.json\.([1-9]\d*)\.[a-f0-9]{8}\.\d+\.tmp$/;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']);

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function createImportClaims({ directory }) {
  if (!directory) throw new TypeError('Import claims require a directory');

  function begin() {
    const markerPath = path.join(directory, `${process.pid}.${crypto.randomBytes(8).toString('hex')}.json`);
    const entries = new Map();
    let written = false;
    let tail = Promise.resolve();
    const serialize = task => {
      const run = tail.then(task);
      tail = run.catch(() => undefined);
      return run;
    };

    return {
      markerPath,
      // Resolves once the marker that lists `paths` is durable.
      claim(bookId, paths) {
        return serialize(async () => {
          let added = false;
          for (const filePath of paths || []) {
            if (!filePath || entries.has(filePath)) continue;
            entries.set(filePath, String(bookId));
            added = true;
          }
          if (!added) return;
          await fs.mkdir(directory, { recursive: true });
          await writeFileAtomic(markerPath, JSON.stringify({
            pid: process.pid,
            startedAt: PROCESS_STARTED_AT,
            entries: [...entries].map(([filePath, id]) => ({ bookId: id, path: filePath }))
          }));
          await syncDirectory(directory);
          written = true;
        });
      },
      // Ownership has transferred or the files are gone.
      close() {
        return serialize(async () => {
          if (!written) return;
          await fs.unlink(markerPath).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
          written = false;
          entries.clear();
        });
      }
    };
  }

  return { directory, begin };
}

async function readMarker(markerPath) {
  try {
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (!marker || !Number.isSafeInteger(marker.pid) || !Array.isArray(marker.entries)) return null;
    return marker;
  } catch {
    return null;
  }
}

// Same PID and start time as this process means one of this process's own
// imports; otherwise defer to the shared owner-liveness rule (which also
// handles PID reuse by a later process, as containers do with PID 1).
async function markerOwnerGone(marker, markerPath) {
  if (marker.pid === process.pid && marker.startedAt === PROCESS_STARTED_AT) return false;
  return ownerProcessGone(marker.pid, markerPath);
}

function recordedPaths(books) {
  const resolved = new Set();
  const names = new Set();
  for (const book of Object.values(books)) {
    if (!book || typeof book !== 'object') continue;
    for (const field of BOOK_ARTIFACT_FIELDS) {
      if (typeof book[field] !== 'string' || !book[field]) continue;
      resolved.add(path.resolve(book[field]));
      // Stored paths can carry an old cache root (see reconcileBookArtifactPaths).
      names.add(path.basename(book[field]));
    }
  }
  return { resolved, names };
}

async function sweepAbandonedImportClaims({
  directory,
  cacheDir,
  loadBooks,
  removeFile = filePath => fs.unlink(filePath),
  log = console
}) {
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: 0, markers: 0 };
    throw error;
  }

  const live = [];
  const dead = [];
  for (const name of names) {
    const entryPath = path.join(directory, name);
    const temp = name.match(MARKER_TEMP_NAME);
    if (temp) {
      if (await ownerProcessGone(Number(temp[2]), entryPath)) await fs.unlink(entryPath).catch(() => {});
      continue;
    }
    if (!MARKER_NAME.test(name)) continue;
    const marker = await readMarker(entryPath);
    // An unparsable marker could name anything; leave it for an operator.
    if (!marker) {
      log.warn?.(`Import claim ${entryPath} is unreadable; leaving it in place`);
      continue;
    }
    (await markerOwnerGone(marker, entryPath) ? dead : live).push({ marker, entryPath });
  }
  if (!dead.length) return { removed: 0, markers: 0 };

  // Without a readable library every claimed path might belong to a record.
  let books;
  try {
    books = await loadBooks();
  } catch (error) {
    log.warn?.(`Import claim sweep skipped: books.json is unreadable (${error.code || error.message})`);
    return { removed: 0, markers: 0, skipped: true };
  }
  if (!books || typeof books !== 'object' || Array.isArray(books)) {
    log.warn?.('Import claim sweep skipped: books.json is not a library object');
    return { removed: 0, markers: 0, skipped: true };
  }

  const recorded = recordedPaths(books);
  const liveClaims = new Set(live.flatMap(({ marker }) => marker.entries.map(entry => path.resolve(String(entry?.path)))));
  const cacheRoot = path.resolve(cacheDir);
  let removed = 0;
  let markers = 0;
  for (const { marker, entryPath } of dead) {
    let complete = true;
    for (const entry of marker.entries) {
      if (typeof entry?.path !== 'string' || !entry.path) continue;
      const filePath = path.resolve(entry.path);
      const owned = Object.prototype.hasOwnProperty.call(books, String(entry.bookId)) ||
        recorded.resolved.has(filePath) ||
        recorded.names.has(path.basename(filePath)) ||
        liveClaims.has(filePath);
      if (owned || path.dirname(filePath) !== cacheRoot) continue;
      try {
        await removeFile(filePath);
        removed++;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        complete = false;
        log.warn?.(`Import claim sweep could not remove ${filePath}: ${error.message}`);
      }
    }
    if (!complete) continue;
    await fs.unlink(entryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    markers++;
  }
  return { removed, markers };
}

module.exports = { createImportClaims, sweepAbandonedImportClaims };
