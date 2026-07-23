const assert = require('assert');
const { pathToFileURL } = require('url');
const path = require('path');

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
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'util', 'book-timeline.mjs'));
  const { bookTimelinePosition, bookTimelineSeekTarget } = await import(moduleUrl.href);

  test('position weights chapters by measured duration', () => {
    const position = bookTimelinePosition([100, 200, 300], 1, 50);
    assert.strictEqual(position.elapsed, 150);
    assert.strictEqual(position.total, 600);
    assert.strictEqual(position.remaining, 450);
    assert.strictEqual(position.percent, 25);
  });

  test('seek maps an exact chapter boundary to the next chapter', () => {
    const target = bookTimelineSeekTarget([100, 200, 300], 50);
    assert.strictEqual(target.chapterIndex, 2);
    assert.strictEqual(target.chapterTime, 0);
  });

  test('seek clamps the end of the book to the final chapter', () => {
    const target = bookTimelineSeekTarget([100, 200, 300], 100);
    assert.strictEqual(target.chapterIndex, 2);
    assert.strictEqual(target.chapterTime, 300);
  });

  test('partial or invalid duration data disables the timeline', () => {
    assert.strictEqual(bookTimelinePosition([100, 0, 300], 0, 0), null);
    assert.strictEqual(bookTimelineSeekTarget([], 50), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
