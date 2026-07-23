/**
 * Test suite lib/listening-stats — computeListeningStats aggregation:
 * progress math (measured vs estimated), finished/in-progress split,
 * hours-listened sum, recently-listened ordering, and orphan handling.
 */

const assert = require('assert');
const { computeListeningStats, normalizedChapterDurations } = require('../lib/listening-stats');

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

// --- normalizedChapterDurations ---------------------------------------------

test('normalizedChapterDurations returns array when fully measured', () => {
  const book = { chapterCount: 3, chapterDurations: [10, 20, 30] };
  assert.deepStrictEqual(normalizedChapterDurations(book), [10, 20, 30]);
});

test('normalizedChapterDurations rejects partial arrays', () => {
  const book = { chapterCount: 3, chapterDurations: [10, 20] };
  assert.strictEqual(normalizedChapterDurations(book), null);
});

test('normalizedChapterDurations rejects zero/negative entries', () => {
  const book = { chapterCount: 3, chapterDurations: [10, 0, 30] };
  assert.strictEqual(normalizedChapterDurations(book), null);
});

// --- computeListeningStats: empty / orphan ----------------------------------

test('empty inputs yield zeroed stats', () => {
  const s = computeListeningStats({}, {});
  assert.strictEqual(s.totalHoursListened, 0);
  assert.strictEqual(s.booksFinishedCount, 0);
  assert.strictEqual(s.booksInProgressCount, 0);
  assert.deepStrictEqual(s.inProgress, []);
  assert.deepStrictEqual(s.recent, []);
});

test('positions for unknown books are ignored', () => {
  const books = { a: { title: 'A', chapterCount: 2, totalDuration: 100 } };
  const positions = { ghost: { chapterIndex: 1, timestamp: 10, updatedAtMs: 5 } };
  const s = computeListeningStats(books, positions);
  assert.strictEqual(s.booksInProgressCount, 0);
  assert.strictEqual(s.recent.length, 0);
});

// --- measured (duration-weighted) progress ----------------------------------

test('measured durations drive percent and elapsed', () => {
  const books = {
    a: { title: 'A', author: 'X', chapterCount: 4, chapterDurations: [100, 100, 100, 100], totalDuration: 400 }
  };
  // Start of chapter index 2 → 200s elapsed of 400s → 50%.
  const positions = { a: { chapterIndex: 2, timestamp: 0, updatedAtMs: 1000 } };
  const s = computeListeningStats(books, positions);
  assert.strictEqual(s.inProgress.length, 1);
  assert.strictEqual(s.inProgress[0].percent, 50);
  // 200s → 0.055... hours, rounded to 1 decimal = 0.1
  assert.strictEqual(s.totalHoursListened, 0.1);
});

// --- estimated (even-spread) progress when durations missing ----------------

test('estimated progress used when chapterDurations absent', () => {
  const books = { a: { title: 'A', chapterCount: 10, totalDuration: 3600 } }; // 360s/chapter
  const positions = { a: { chapterIndex: 5, timestamp: 0, updatedAtMs: 1 } };
  const s = computeListeningStats(books, positions);
  // 5/10 → 50%
  assert.strictEqual(s.inProgress[0].percent, 50);
  assert.strictEqual(s.totalHoursListened, 0.5); // 1800s
});

// --- finished handling ------------------------------------------------------

test('finished books count fully toward hours and finished list', () => {
  const books = { a: { title: 'A', chapterCount: 5, totalDuration: 7200 } };
  const positions = { a: { chapterIndex: 4, timestamp: 0, finished: true, updatedAt: '2026-07-01T00:00:00Z', updatedAtMs: 9 } };
  const s = computeListeningStats(books, positions);
  assert.strictEqual(s.booksFinishedCount, 1);
  assert.strictEqual(s.booksInProgressCount, 0);
  assert.strictEqual(s.finished[0].finishedAt, '2026-07-01T00:00:00Z');
  assert.strictEqual(s.totalHoursListened, 2); // full 7200s
});

// --- recently-listened ordering + limit -------------------------------------

test('recent is newest-first and limited', () => {
  const books = {};
  const positions = {};
  for (let i = 0; i < 8; i++) {
    const id = `b${i}`;
    books[id] = { title: `Book ${i}`, chapterCount: 2, totalDuration: 100 };
    positions[id] = { chapterIndex: 0, timestamp: 10, updatedAtMs: i * 1000 };
  }
  const s = computeListeningStats(books, positions, { recentLimit: 5 });
  assert.strictEqual(s.recent.length, 5);
  assert.strictEqual(s.recent[0].id, 'b7'); // highest updatedAtMs first
  assert.strictEqual(s.recent[4].id, 'b3');
});

test('in-progress excludes finished and sorts by recency', () => {
  const books = {
    a: { title: 'A', chapterCount: 2, totalDuration: 100 },
    b: { title: 'B', chapterCount: 2, totalDuration: 100 },
    c: { title: 'C', chapterCount: 2, totalDuration: 100 }
  };
  const positions = {
    a: { chapterIndex: 0, timestamp: 10, updatedAtMs: 100 },
    b: { chapterIndex: 1, timestamp: 0, finished: true, updatedAtMs: 200 },
    c: { chapterIndex: 1, timestamp: 10, updatedAtMs: 300 }
  };
  const s = computeListeningStats(books, positions);
  assert.strictEqual(s.booksInProgressCount, 2);
  assert.strictEqual(s.inProgress[0].id, 'c'); // newest in-progress first
  assert.strictEqual(s.inProgress[1].id, 'a');
});

test('books without duration metadata are skipped (no NaN)', () => {
  const books = { a: { title: 'A' } }; // no chapterCount/totalDuration
  const positions = { a: { chapterIndex: 0, timestamp: 5, updatedAtMs: 1 } };
  const s = computeListeningStats(books, positions);
  assert.strictEqual(s.booksInProgressCount, 0);
  assert.strictEqual(s.totalHoursListened, 0);
  assert.ok(Number.isFinite(s.totalSecondsListened));
});

console.log(`\n${'═'.repeat(50)}`);
console.log(`listening-stats tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
