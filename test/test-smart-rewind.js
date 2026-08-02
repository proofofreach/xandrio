const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const {
    applyRewindForResume,
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

  // --- Activation-safe application -----------------------------------------
  // iOS only honours audio.play() inside the user-activation window opened by
  // the tap. applyRewindForResume must therefore complete synchronously and
  // report what it did, so the caller can play immediately either way.

  const seekablePlayer = { trySeekSync: () => true, seeks: [] };
  const nonseekablePlayer = { trySeekSync: () => false };

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 4 * 60_000;
  assert.deepStrictEqual(
    applyRewindForResume({
      controller: rewind,
      player: { trySeekSync: seconds => { seekablePlayer.seeks.push(seconds); return true; } },
      bookId: 'book-a',
      chapterIndex: 2,
      positionSeconds: 100,
      enabled: true
    }),
    { status: 'applied', rewindSeconds: 10, targetSeconds: 90 },
    'a seekable source rewinds synchronously'
  );
  assert.deepStrictEqual(seekablePlayer.seeks, [90]);

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 4 * 60_000;
  assert.deepStrictEqual(
    applyRewindForResume({
      controller: rewind,
      player: nonseekablePlayer,
      bookId: 'book-a',
      chapterIndex: 2,
      positionSeconds: 100,
      enabled: true
    }),
    { status: 'deferred', rewindSeconds: 10, targetSeconds: 90 },
    'a nonseekable source defers the rewind instead of reloading'
  );

  rewind.recordPause({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 });
  now += 4 * 60_000;
  assert.deepStrictEqual(
    applyRewindForResume({
      controller: rewind,
      player: seekablePlayer,
      bookId: 'book-a',
      chapterIndex: 2,
      positionSeconds: 100,
      enabled: false
    }),
    { status: 'skipped', rewindSeconds: 0, targetSeconds: null },
    'a disabled rewind is skipped and the anchor cleared'
  );
  assert.strictEqual(
    rewind.planResume({ bookId: 'book-a', chapterIndex: 2, positionSeconds: 100 }),
    null,
    'disabling clears the stored anchor'
  );

  assert.deepStrictEqual(
    applyRewindForResume({
      controller: rewind,
      player: seekablePlayer,
      bookId: 'book-a',
      chapterIndex: 2,
      positionSeconds: 100,
      enabled: true
    }),
    { status: 'skipped', rewindSeconds: 0, targetSeconds: null },
    'no pause anchor means nothing to apply'
  );

  // A player that cannot seek synchronously at all (no trySeekSync) must not
  // throw and must not fall back to an awaiting seek.
  assert.strictEqual(
    applyRewindForResume({
      controller: rewind,
      player: {},
      bookId: 'book-a',
      chapterIndex: 2,
      positionSeconds: 100,
      enabled: true
    }).status,
    'skipped'
  );

  console.log('15 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
