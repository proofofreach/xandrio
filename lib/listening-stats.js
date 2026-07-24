// Listening-history aggregation.
//
// Pure, side-effect-free so it can be unit-tested without the filesystem or
// Express. The server passes in the raw books map (data/books.json) and one
// user's position map (data/positions.json → users[userId]); everything here
// is derived from those two objects.
//
// Progress math mirrors the frontend (public/js/views/library.js:
// normalizedChapterDurations / durationWeightedProgress) so the Stats screen
// agrees with the per-book progress bars users already see. Measured
// chapterDurations are preferred; otherwise we fall back to totalDuration
// spread evenly across chapterCount.

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Per-chapter measured durations, but only when the array is trustworthy:
// one positive number per chapter. Partial arrays (the common case before
// backfill) return null so callers fall back to the even-spread estimate.
function normalizedChapterDurations(book, chapterCount = book && book.chapterCount) {
  const count = Number(chapterCount);
  if (!book || !Number.isInteger(count) || count <= 0 || !Array.isArray(book.chapterDurations)) return null;
  const durations = book.chapterDurations.slice(0, count).map(Number);
  if (durations.length !== count || !durations.every(v => Number.isFinite(v) && v > 0)) return null;
  return durations;
}

// Elapsed seconds + percent from measured per-chapter durations.
function durationWeightedProgress(durations, position) {
  const total = durations.reduce((sum, v) => sum + v, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const chapterIndex = Math.max(0, Math.min(durations.length - 1, Number(position.chapterIndex) || 0));
  const elapsedBefore = durations.slice(0, chapterIndex).reduce((sum, v) => sum + v, 0);
  const chapterTime = Math.max(0, Math.min(durations[chapterIndex] || 0, Number(position.timestamp) || 0));
  const elapsed = Math.min(total, elapsedBefore + chapterTime);
  return { elapsed, total, percent: Math.min(99, Math.max(0, Math.round((elapsed / total) * 100))) };
}

// Elapsed seconds + percent when we only know the book's total duration and
// chapter count — estimate each chapter as an equal slice.
function estimatedProgress(book, position) {
  const total = toFiniteNumber(book.totalDuration);
  const count = Number(book.chapterCount);
  if (!total || total <= 0 || !Number.isInteger(count) || count <= 0) return null;
  const perChapter = total / count;
  const chapterIndex = Math.max(0, Math.min(count - 1, Number(position.chapterIndex) || 0));
  const chapterTime = Math.max(0, Math.min(perChapter, Number(position.timestamp) || 0));
  const elapsed = Math.min(total, chapterIndex * perChapter + chapterTime);
  return { elapsed, total, percent: Math.min(99, Math.max(0, Math.round((elapsed / total) * 100))) };
}

// One book's listening progress. Returns null when the book has no usable
// duration/chapter metadata at all (nothing meaningful to show).
function bookProgress(book, position) {
  if (!position) return null;
  const total = toFiniteNumber(book.totalDuration);

  if (position.finished) {
    return { elapsed: total && total > 0 ? total : null, total, percent: 100, finished: true };
  }

  const durations = normalizedChapterDurations(book);
  const progress = durations
    ? durationWeightedProgress(durations, position)
    : estimatedProgress(book, position);
  if (!progress) return null;
  return Object.assign({}, progress, { finished: false });
}

function bookSummary(book, id) {
  // Covers are fetched by id via GET /api/cover/:id — no need to leak the
  // absolute filesystem path. hasCover lets the client skip the request when
  // there is nothing to show.
  return {
    id,
    title: book.title || 'Untitled',
    author: book.author || '',
    hasCover: Boolean(book.coverPath)
  };
}

/**
 * Aggregate listening stats for a single user.
 *
 * @param {Object} books      books.json map: { [bookId]: bookMeta }
 * @param {Object} positions  one user's positions: { [bookId]: positionRecord }
 * @param {Object} [opts]
 * @param {number} [opts.recentLimit=5]  how many recently-listened entries to return
 * @returns {{
 *   totalSecondsListened: number,
 *   totalHoursListened: number,
 *   booksFinishedCount: number,
 *   booksInProgressCount: number,
 *   inProgress: Array,
 *   finished: Array,
 *   recent: Array
 * }}
 */
function computeListeningStats(books, positions, opts) {
  opts = opts || {};
  const recentLimit = Number.isInteger(opts.recentLimit) ? opts.recentLimit : 5;
  const bookMap = books && typeof books === 'object' ? books : {};
  const posMap = positions && typeof positions === 'object' ? positions : {};

  let totalSecondsListened = 0;
  const inProgress = [];
  const finished = [];
  const recentCandidates = [];

  for (const [bookId, position] of Object.entries(posMap)) {
    const book = bookMap[bookId];
    if (!book || !position || typeof position !== 'object') continue; // stale/orphan position

    const progress = bookProgress(book, position);
    if (!progress) continue;

    if (Number.isFinite(progress.elapsed) && progress.elapsed > 0) {
      totalSecondsListened += progress.elapsed;
    }

    const updatedAtMs = toFiniteNumber(position.updatedAtMs) || 0;
    const summary = bookSummary(book, bookId);

    if (progress.finished) {
      finished.push(Object.assign({}, summary, {
        finishedAt: position.updatedAt || null,
        finishedAtMs: updatedAtMs
      }));
    } else {
      inProgress.push(Object.assign({}, summary, {
        percent: progress.percent,
        chapterIndex: Number(position.chapterIndex) || 0,
        chapterCount: Number(book.chapterCount) || null,
        updatedAt: position.updatedAt || null,
        updatedAtMs
      }));
    }

    recentCandidates.push(Object.assign({}, summary, {
      percent: progress.percent,
      finished: Boolean(progress.finished),
      updatedAt: position.updatedAt || null,
      updatedAtMs
    }));
  }

  inProgress.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  finished.sort((a, b) => b.finishedAtMs - a.finishedAtMs);
  recentCandidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const totalHoursListened = Math.round((totalSecondsListened / 3600) * 10) / 10;

  return {
    totalSecondsListened: Math.round(totalSecondsListened),
    totalHoursListened,
    booksFinishedCount: finished.length,
    booksInProgressCount: inProgress.length,
    inProgress,
    finished,
    recent: recentCandidates.slice(0, Math.max(0, recentLimit))
  };
}

module.exports = { computeListeningStats, normalizedChapterDurations };
