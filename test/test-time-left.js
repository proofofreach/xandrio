/**
 * Shared time vocabulary: formatDuration and "time left at effective speed".
 *
 * Run: node test/test-time-left.js
 */
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'util', 'time-left.mjs'));
  const {
    formatDuration,
    formatSpeed,
    effectiveSpeed,
    validSpeed,
    bookAudioProgress,
    bookTimeLeft,
    timeLeftAtSpeed,
    timeLeftLabel,
    shortChapterContext
  } = await import(moduleUrl.href);

  console.log('\n━━━ formatDuration ━━━');

  test('empty, zero, negative and non-numeric durations render nothing', () => {
    for (const value of [undefined, null, 0, -5, NaN, 'abc']) {
      assert.strictEqual(formatDuration(value), '');
    }
  });

  test('under a minute reads "< 1m"', () => {
    assert.strictEqual(formatDuration(1), '< 1m');
    assert.strictEqual(formatDuration(59.9), '< 1m');
  });

  test('minutes under an hour have no hour part', () => {
    assert.strictEqual(formatDuration(60), '1m');
    assert.strictEqual(formatDuration(45 * 60), '45m');
    assert.strictEqual(formatDuration(59 * 60 + 29), '59m');
  });

  test('minutes round first and carry into the hour (never "11h 60m")', () => {
    assert.strictEqual(formatDuration(11 * 3600 + 59 * 60 + 45), '12h 00m');
    assert.strictEqual(formatDuration(59 * 60 + 30), '1h 00m');
    assert.strictEqual(formatDuration(3599), '1h 00m');
    for (let seconds = 0; seconds < 48 * 3600; seconds += 7) {
      assert(!/\b60m$/.test(formatDuration(seconds)), `no 60m at ${seconds}s`);
    }
  });

  test('hours keep two-digit minutes', () => {
    assert.strictEqual(formatDuration(6 * 3600 + 2 * 60), '6h 02m');
    assert.strictEqual(formatDuration(9 * 3600 + 12 * 60), '9h 12m');
    assert.strictEqual(formatDuration(38 * 3600 + 20 * 60), '38h 20m');
    assert.strictEqual(formatDuration(3660), '1h 01m');
  });

  console.log('\n━━━ speed ━━━');

  test('formatSpeed always shows a decimal and the multiplication sign', () => {
    assert.strictEqual(formatSpeed(1), '1.0×');
    assert.strictEqual(formatSpeed(1.25), '1.25×');
    assert.strictEqual(formatSpeed(1.5), '1.5×');
    assert.strictEqual(formatSpeed(2), '2.0×');
    assert.strictEqual(formatSpeed(0.8), '0.8×');
  });

  test('effectiveSpeed takes the first usable rate, else 1', () => {
    assert.strictEqual(effectiveSpeed(null, 1.25), 1.25);
    assert.strictEqual(effectiveSpeed(1.5, 1.25), 1.5);
    assert.strictEqual(effectiveSpeed(0, -1, 'x'), 1);
    assert.strictEqual(effectiveSpeed(99, 2), 2, 'out-of-range speeds are ignored');
    assert.strictEqual(validSpeed(1.234), 1.23);
  });

  console.log('\n━━━ time left at speed ━━━');

  const measured = { chapterCount: 3, chapterDurations: [600, 1200, 1800] };

  test('measured timelines use real chapter durations and the chapter position', () => {
    const progress = bookAudioProgress(measured, { chapterIndex: 1, timestamp: 300 });
    assert.strictEqual(progress.elapsed, 900);
    assert.strictEqual(progress.total, 3600);
    assert.strictEqual(progress.remaining, 2700);
    assert.strictEqual(progress.percent, 25);
    assert.strictEqual(progress.measured, true);
  });

  test('unmeasured books estimate equal chapter slices from the total duration', () => {
    const book = { chapterCount: 4, totalDuration: 4000 };
    const progress = bookAudioProgress(book, { chapterIndex: 2, timestamp: 500 });
    assert.strictEqual(progress.elapsed, 2500);
    assert.strictEqual(progress.remaining, 1500);
    assert.strictEqual(progress.measured, false);
  });

  test('a cached chapter count can stand in for a missing one', () => {
    const book = { totalDuration: 1000 };
    assert.strictEqual(bookAudioProgress(book, { chapterIndex: 0 }), null);
    assert.strictEqual(bookAudioProgress(book, { chapterIndex: 1 }, 2).remaining, 500);
  });

  test('time left divides remaining audio by the effective speed', () => {
    assert.strictEqual(timeLeftAtSpeed(3600, 1.25), 2880);
    assert.strictEqual(timeLeftAtSpeed(3600, null), 3600);
    const result = bookTimeLeft(measured, { chapterIndex: 1, timestamp: 300 }, 1.5);
    assert.strictEqual(result.timeLeft, 1800);
    assert.strictEqual(result.speed, 1.5);
  });

  test('finished books have no time left', () => {
    const result = bookTimeLeft(measured, { chapterIndex: 2, timestamp: 10, finished: true }, 1);
    assert.strictEqual(result.timeLeft, 0);
    assert.strictEqual(result.percent, 100);
    assert.strictEqual(timeLeftLabel(0, 1), 'Finished');
  });

  test('labels state the speed unless it matches the speed already on screen', () => {
    const seconds = 9 * 3600 + 12 * 60;
    assert.strictEqual(timeLeftLabel(seconds, 1.25), '9h 12m left at 1.25×');
    assert.strictEqual(timeLeftLabel(seconds, 1.25, { referenceSpeed: 1.25 }), '9h 12m left');
    assert.strictEqual(timeLeftLabel(6 * 3600 + 120, 1, { referenceSpeed: 1.25 }), '6h 02m left at 1.0×');
    assert.strictEqual(timeLeftLabel(seconds, 1.25, { withSpeed: false }), '9h 12m left');
    assert.strictEqual(timeLeftLabel(null, 1), '');
  });

  test('library and player agree for the same book, position and speed', () => {
    const book = { chapterCount: 50, chapterDurations: Array.from({ length: 50 }, () => 1000) };
    const position = { chapterIndex: 11, timestamp: 744 };
    const fromLibrary = timeLeftLabel(bookTimeLeft(book, position, 1.25).timeLeft, 1.25, { referenceSpeed: 1 });
    const fromPlayer = timeLeftLabel(bookTimeLeft(book, { ...position, currentTime: 744, timestamp: undefined }, 1.25).timeLeft, 1.25);
    assert.strictEqual(fromLibrary, fromPlayer);
  });

  test('narrative chapter context shortens to "Ch N of M"', () => {
    assert.strictEqual(shortChapterContext('Chapter 12 of 50'), 'Ch 12 of 50');
    assert.strictEqual(shortChapterContext('Acknowledgments'), 'Acknowledgments');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
