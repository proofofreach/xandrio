const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const {
    createSmartRewindController,
    rewindSecondsForIdle
  } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'smart-rewind.mjs')).href);

  assert.strictEqual(rewindSecondsForIdle(29_999), 0);
  assert.strictEqual(rewindSecondsForIdle(30_000), 5);
  assert.strictEqual(rewindSecondsForIdle(2 * 60_000), 10);
  assert.strictEqual(rewindSecondsForIdle(10 * 60_000), 20);
  assert.strictEqual(rewindSecondsForIdle(60 * 60_000), 30);

  let now = 1_000_000;
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const rewind = createSmartRewindController({ storage, now: () => now });

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 4 * 60_000;
  assert.deepStrictEqual(rewind.planResume({
    bookId: 'book-a',
    chapterIndex: 2,
    positionSeconds: 100
  }), {
    rewindSeconds: 10,
    targetSeconds: 90,
    idleMs: 4 * 60_000
  });
  assert.strictEqual(rewind.planResume({
    bookId: 'book-a',
    chapterIndex: 2,
    positionSeconds: 90
  }), null, 'a pause anchor must be consumed once');

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 3 });
  now += 70 * 60_000;
  assert.strictEqual(rewind.planResume({
    bookId: 'book-a',
    chapterIndex: 2,
    positionSeconds: 3
  }).targetSeconds, 0);

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 5 * 60_000;
  assert.strictEqual(rewind.planResume({
    bookId: 'book-b',
    chapterIndex: 2,
    positionSeconds: 100
  }), null, 'rewind must never cross books');

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 5 * 60_000;
  assert.strictEqual(rewind.planResume({
    bookId: 'book-a',
    chapterIndex: 3,
    positionSeconds: 100
  }), null, 'rewind must never cross chapters');

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 5 * 60_000;
  assert.strictEqual(rewind.planResume({
    bookId: 'book-a',
    chapterIndex: 2,
    positionSeconds: 500
  }), null, 'an explicit seek must consume the old pause anchor without rewinding');

  console.log('9 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
