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
      } else if (snapshots[store] !== undefined) {
        await saveJSON(files[store], snapshots[store]);
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
        const [books, positions, bookmarks, transitions] = await Promise.all([
          loadJSON(files.books, {}),
          loadJSON(files.positions, {}),
          loadJSON(files.bookmarks, {}),
          loadJSON(files.transitions, {})
        ]);
        if (!books[bookId] || books[bookId].path !== book.path) {
          return { changed: false, reason: 'book-changed-during-plan' };
        }

        journal.snapshots = {
          books: clone(books),
          positions: clone(positions),
          bookmarks: clone(bookmarks),
          transitions: clone(transitions)
        };
        await writeJournal(journal);
        await step('snapshotted', hook);

        const nextBooks = clone(books);
        const nextPositions = clone(positions);
        const nextBookmarks = clone(bookmarks);
        const nextTransitions = clone(transitions);
        remapBookPositions(nextPositions, bookId, plan.transition, plan.nextStructureKey);
        remapBookBookmarks(nextBookmarks, bookId, plan.transition, plan.nextStructureKey);
        nextTransitions[bookId] = {
          previousStructureKey: plan.previousStructureKey,
          nextStructureKey: plan.nextStructureKey,
          transition: plan.transition,
          createdAt: now()
        };
        const nextChapters = plan.candidate.chapters;
        nextBooks[bookId] = {
          ...nextBooks[bookId],
          chapterCount: nextChapters.length,
          totalDuration: nextChapters.reduce((sum, chapter) => sum + (Number(chapter.estimatedDuration) || 0), 0),
          chapterStructureKey: plan.nextStructureKey,
          processingVersion: plan.candidate.processingVersion,
          canRebuildChapters: Boolean(plan.candidate.sourceDocument?.pages?.length) || undefined,
          reprocessedAt: now()
        };
        delete nextBooks[bookId].needsReview;
        delete nextBooks[bookId].validationWarnings;

        const writes = {
          artifact: async () => {
            await fs.rename(paths.candidatePath, book.path);
            await syncDirectory(fs, path.dirname(book.path));
            xbookStore.invalidateXBookArtifactCache?.(book.path);
          },
          transitions: () => saveJSON(files.transitions, nextTransitions),
          books: () => saveJSON(files.books, nextBooks),
          positions: () => saveJSON(files.positions, nextPositions),
          bookmarks: () => saveJSON(files.bookmarks, nextBookmarks)
        };
        for (const store of STORE_ORDER) {
          await markStarted(journal, store, hook);
          await writes[store]();
          await step(`after:${store}`, hook);
          await markCompleted(journal, store, hook);
        }
        return { changed: true, transition: plan.transition, book: nextBooks[bookId] };
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
