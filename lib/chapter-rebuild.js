const fsDefault = require('fs').promises;
const path = require('path');
const jsonStoreDefault = require('./json-store');
const { createBookMutationLocks } = require('./book-mutation-lock');
const { remapBookPositions, remapBookBookmarks } = require('./chapter-reprocess');

const TRANSACTION_VERSION = 2;
const STORE_ORDER = ['artifact', 'transitions', 'books', 'positions', 'bookmarks'];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// positions.json and bookmarks.json are global, all-users, all-books stores
// shaped as { users: { [userId]: { [bookId]: <record|record[]> } } }. A
// rebuild only ever needs (and must only ever touch) one book's slice of
// them, so snapshot/restore work on that slice instead of the whole file —
// see extractBookRecordsSnapshot/restoreBookRecordsSnapshot below.
function extractBookRecordsSnapshot(store, bookId) {
  const out = {};
  const users = store && typeof store === 'object' ? store.users : null;
  if (users && typeof users === 'object') {
    for (const [userId, userRecords] of Object.entries(users)) {
      if (userRecords && typeof userRecords === 'object' && Object.prototype.hasOwnProperty.call(userRecords, bookId)) {
        out[userId] = clone(userRecords[bookId]);
      }
    }
  }
  return out;
}

function restoreBookRecordsSnapshot(store, bookId, snapshot) {
  const target = store && typeof store === 'object' ? store : {};
  target.users = target.users && typeof target.users === 'object' ? target.users : {};
  for (const [userId, value] of Object.entries(snapshot || {})) {
    target.users[userId] = target.users[userId] && typeof target.users[userId] === 'object' ? target.users[userId] : {};
    target.users[userId][bookId] = value;
  }
  return target;
}

async function syncFile(fs, filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(fs, dirPath) {
  let handle;
  try {
    handle = await fs.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!new Set(['EBADF', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM']).has(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function journalPaths(xbookPath) {
  return {
    journalPath: `${xbookPath}.rebuild-journal.json`,
    backupPath: `${xbookPath}.rebuild-backup.json`,
    candidatePath: `${xbookPath}.rebuild-candidate.json`
  };
}

function validArtifact(value) {
  return Boolean(value && Number.isInteger(value._xbookVersion) && Array.isArray(value.chapters));
}

function createChapterRebuildService({
  files,
  xbookStore,
  locks = createBookMutationLocks(),
  fs = fsDefault,
  jsonStore = jsonStoreDefault,
  loadJSON = (filePath, fallback = {}) => jsonStore.load(filePath, fallback),
  saveJSON = (filePath, value) => jsonStore.save(filePath, value),
  // Mutations to the shared positions/bookmarks/books/transitions stores must
  // hold each file's lock across their own read-modify-write cycle (see
  // json-store.js's update()), otherwise a rebuild's stale in-memory clone
  // can silently clobber a concurrent write another request already
  // acknowledged with 200 OK. saveJSON/loadJSON remain for the artifact
  // candidate file and whole-value reads that don't need that guarantee.
  updateJSON = (filePath, mutator, defaultValue = {}) => jsonStore.update(filePath, mutator, defaultValue),
  now = () => new Date().toISOString(),
  onStep = null,
  afterCommit = async () => {},
  onPostCommitError = async () => {}
} = {}) {
  if (!files?.books || !files?.positions || !files?.bookmarks || !files?.transitions || !xbookStore?.planXBookRebuild) {
    throw new TypeError('Chapter rebuild requires book, position, bookmark, transition, and XBook stores');
  }

  async function step(name, override) {
    const hook = override || onStep;
    if (hook) await hook(name);
  }

  async function writeJournal(journal) {
    await saveJSON(journal.journalPath, journal);
  }

  async function markStarted(journal, store, hook) {
    if (!journal.started.includes(store)) journal.started.push(store);
    await writeJournal(journal);
    await step(`before:${store}`, hook);
  }

  async function markCompleted(journal, store, hook) {
    if (!journal.completed.includes(store)) journal.completed.push(store);
    await writeJournal(journal);
    await step(`completed:${store}`, hook);
  }

  async function durableCopy(source, destination) {
    await fs.copyFile(source, destination);
    await syncFile(fs, destination);
    await syncDirectory(fs, path.dirname(destination));
  }

  async function cleanupJournal(journal) {
    await fs.unlink(journal.candidatePath).catch(() => {});
    await fs.unlink(journal.journalPath).catch(() => {});
    await syncDirectory(fs, path.dirname(journal.journalPath));
  }

  function committedEvent(journal) {
    return {
      bookId: journal.bookId,
      plan: {
        transition: journal.transition,
        candidate: { chapters: journal.nextChapters || [] },
        previousStructureKey: journal.previousStructureKey,
        nextStructureKey: journal.nextStructureKey
      },
      result: {
        changed: true,
        transition: journal.transition,
        book: journal.committedBook
      }
    };
  }

  async function finishCommittedJournal(journal, hook) {
    if (!journal.audioCompletedAt) {
      await afterCommit(committedEvent(journal));
      journal.audioCompletedAt = now();
      await writeJournal(journal);
      await step('audio-completed', hook);
    }
    await cleanupJournal(journal);
    return { recovered: true, rolledForward: true };
  }

  async function recoverJournal(journal) {
    if (journal.committedAt) {
      try {
        return await finishCommittedJournal(journal);
      } catch (error) {
        await onPostCommitError({ ...committedEvent(journal), error }).catch(() => {});
        return { recovered: false, rolledForward: false, pending: true };
      }
    }
    const started = new Set(journal.started || []);
    const snapshots = journal.snapshots || {};
    // Restore state in reverse publication order. A store marked started may
    // have crashed either just before or just after its write; restoring its
    // under-lock snapshot is safe in both cases.
    for (const store of [...STORE_ORDER].reverse()) {
      if (!started.has(store)) continue;
      if (store === 'artifact') {
        await durableCopy(journal.backupPath, journal.xbookPath);
        xbookStore.invalidateXBookArtifactCache?.(journal.xbookPath);
      } else if (store === 'books' || store === 'transitions') {
        // Restore only this book's pre-image, not the whole store, so a
        // deferred rollback (e.g. at the next startup) can't discard other
        // books' or users' records written since the snapshot was taken.
        await updateJSON(files[store], data => {
          if (snapshots[store] === undefined) delete data[journal.bookId];
          else data[journal.bookId] = snapshots[store];
        }, {});
      } else if (store === 'positions' || store === 'bookmarks') {
        await updateJSON(files[store], data =>
          restoreBookRecordsSnapshot(data, journal.bookId, snapshots[store]), {});
      }
    }
    await cleanupJournal(journal);
    return { recovered: true, rolledBack: [...started] };
  }

  async function recoverPathUnlocked(xbookPath) {
    const { journalPath } = journalPaths(xbookPath);
    let journal;
    try {
      journal = await loadJSON(journalPath, null);
    } catch (error) {
      if (error.code === 'ENOENT') return { recovered: false };
      throw error;
    }
    if (!journal) return { recovered: false };
    return recoverJournal(journal);
  }

  async function recoverBookUnlocked(bookId) {
    const books = await loadJSON(files.books, {});
    const xbookPath = books?.[bookId]?.path;
    if (!xbookPath) return { recovered: false };
    return recoverPathUnlocked(xbookPath);
  }

  function recoverBook(bookId) {
    return locks.withBookMutationLock(bookId, () => recoverBookUnlocked(bookId));
  }

  async function recoverAll() {
    const books = await loadJSON(files.books, {});
    const results = [];
    for (const bookId of Object.keys(books)) {
      const result = await recoverBook(bookId);
      if (result.recovered) results.push({ bookId, ...result });
    }
    return results;
  }

  async function commitPlan(bookId, book, plan, hook) {
    const paths = journalPaths(book.path);
    const journal = {
      transactionVersion: TRANSACTION_VERSION,
      bookId,
      xbookPath: book.path,
      ...paths,
      previousStructureKey: plan.previousStructureKey,
      nextStructureKey: plan.nextStructureKey,
      previousProcessingVersion: Number.isInteger(plan.artifact.processingVersion) ? plan.artifact.processingVersion : 0,
      nextProcessingVersion: plan.candidate.processingVersion,
      transition: plan.transition,
      nextChapters: plan.candidate.chapters,
      started: [],
      completed: [],
      snapshots: { books: null, positions: null, bookmarks: null, transitions: null },
      preparedAt: now()
    };

    await durableCopy(book.path, paths.backupPath);
    await saveJSON(paths.candidatePath, plan.candidate);
    const candidateCheck = await loadJSON(paths.candidatePath, null);
    if (!validArtifact(candidateCheck)) throw new Error('Rebuild candidate failed artifact validation');
    // Publish the recovery intent only after both recovery inputs are durable.
    // A crash before this write leaves the live artifact untouched.
    await writeJournal(journal);
    await step('prepared', hook);

    try {
      const result = await locks.withBookStateLock(bookId, async () => {
        const books = await loadJSON(files.books, {});
        if (!books[bookId] || books[bookId].path !== book.path) {
          return { changed: false, reason: 'book-changed-during-plan' };
        }

        // Snapshot only this book's (and its users') pre-image from each
        // store, not the whole file — the snapshot exists solely to support
        // a rollback, and a whole-file snapshot would make a deferred
        // rollback (lib/chapter-rebuild.js recoverJournal) restore every
        // other book/user's records to however old this journal is.
        const [positions, bookmarks, transitions] = await Promise.all([
          loadJSON(files.positions, {}),
          loadJSON(files.bookmarks, {}),
          loadJSON(files.transitions, {})
        ]);
        journal.snapshots = {
          books: clone(books[bookId]),
          positions: extractBookRecordsSnapshot(positions, bookId),
          bookmarks: extractBookRecordsSnapshot(bookmarks, bookId),
          transitions: clone(transitions[bookId])
        };
        await writeJournal(journal);
        await step('snapshotted', hook);

        const nextChapters = plan.candidate.chapters;
        let committedBook;

        // Each store's write below holds that file's own lock across its
        // read-modify-write cycle (via updateJSON) and mutates only this
        // book's (or this book's users') records, reading whatever is
        // current at write time rather than replaying the stale clone
        // loaded above. That's what stops a concurrent bookmark/position
        // write (or an unrelated import) from being silently overwritten —
        // see the audit finding this fixes (chapter-rebuild-clobbers-
        // concurrent-bookmark-and-position-writes).
        const writes = {
          artifact: async () => {
            await fs.rename(paths.candidatePath, book.path);
            await syncDirectory(fs, path.dirname(book.path));
            xbookStore.invalidateXBookArtifactCache?.(book.path);
          },
          transitions: () => updateJSON(files.transitions, data => {
            data[bookId] = {
              previousStructureKey: plan.previousStructureKey,
              nextStructureKey: plan.nextStructureKey,
              transition: plan.transition,
              createdAt: now()
            };
          }, {}),
          books: () => updateJSON(files.books, data => {
            if (!data[bookId]) return;
            data[bookId] = {
              ...data[bookId],
              chapterCount: nextChapters.length,
              totalDuration: nextChapters.reduce((sum, chapter) => sum + (Number(chapter.estimatedDuration) || 0), 0),
              chapterStructureKey: plan.nextStructureKey,
              processingVersion: plan.candidate.processingVersion,
              canRebuildChapters: Boolean(plan.candidate.sourceDocument?.pages?.length) || undefined,
              reprocessedAt: now()
            };
            delete data[bookId].needsReview;
            delete data[bookId].validationWarnings;
            committedBook = data[bookId];
          }, {}),
          positions: () => updateJSON(files.positions, data =>
            remapBookPositions(data, bookId, plan.transition, plan.nextStructureKey), {}),
          bookmarks: () => updateJSON(files.bookmarks, data =>
            remapBookBookmarks(data, bookId, plan.transition, plan.nextStructureKey), {})
        };
        for (const store of STORE_ORDER) {
          await markStarted(journal, store, hook);
          await writes[store]();
          await step(`after:${store}`, hook);
          await markCompleted(journal, store, hook);
        }
        return { changed: true, transition: plan.transition, book: committedBook };
      });

      if (!result.changed) {
        await cleanupJournal(journal);
        return result;
      }
      journal.committedAt = now();
      journal.committedBook = result.book;
      await writeJournal(journal);
      await step('committed', hook);
      try {
        await finishCommittedJournal(journal, hook);
      } catch (error) {
        if (error.simulateCrash) throw error;
        // The durable commit is authoritative. Keep the journal so startup
        // recovery retries cache reconciliation instead of rolling back live
        // book and listening state.
        await onPostCommitError({ bookId, error, plan, result }).catch(() => {});
      }
      return result;
    } catch (error) {
      if (error.simulateCrash) throw error;
      if (journal.committedAt) {
        await onPostCommitError({ bookId, error, plan }).catch(() => {});
        return { changed: true, transition: plan.transition, book: journal.committedBook, recoveryPending: true };
      }
      await recoverJournal(journal).catch(recoveryError => {
        error.recoveryError = recoveryError;
      });
      throw error;
    }
  }

  function rebuild(bookId, options = {}) {
    return locks.withBookMutationLock(bookId, async () => {
      const recovery = await recoverBookUnlocked(bookId);
      if (recovery.pending) return { changed: false, reason: 'recovery-pending' };
      const books = await loadJSON(files.books, {});
      const book = books?.[bookId];
      if (!book) return { changed: false, reason: 'book-not-found' };
      const plan = await xbookStore.planXBookRebuild(book.path, options);
      if (!plan.safe) return { changed: false, reason: 'unsafe-rebuild' };
      if (!plan.changed) return { changed: false, reason: 'equivalent-current-output' };
      return commitPlan(bookId, book, plan, options.onStep);
    }, {
      ifBusy: 'return',
      busyValue: { changed: false, reason: 'rebuild-in-progress' }
    });
  }

  return {
    rebuild,
    recoverBook,
    recoverAll,
    locks
  };
}

module.exports = { createChapterRebuildService, journalPaths, TRANSACTION_VERSION };
