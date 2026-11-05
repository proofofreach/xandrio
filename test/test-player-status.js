// The player's one status model (public/js/player-status.mjs): failure words,
// state transitions, and the guard that keeps a late "preparing" callback from
// replacing a failure card.
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'player-status.mjs')).href);
  const labels = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'util', 'chapter-labels.mjs')).href);
  const { describePlaybackFailure, createPlayerStatus, isPlayerFailureState, playerStatusShortLabel } = mod;

  await test('server reasons become plain words with the right actions', () => {
    const limited = describePlaybackFailure({ status: 429, retryAfterSeconds: 12 });
    assert.strictEqual(limited.title, 'Too many requests');
    assert.strictEqual(limited.detail, 'Try again in 12 seconds.');
    assert.strictEqual(limited.instant, undefined, 'a narrator change cannot fix a rate limit');

    const engine = describePlaybackFailure({ status: 503, message: 'Narration engine is unavailable' });
    assert.strictEqual(engine.state, 'engine-starting');
    assert.strictEqual(engine.title, 'Narrator engine is starting');
    assert.strictEqual(engine.instant, true);

    const narration = describePlaybackFailure({ status: 500, message: 'Failed to prepare chapter audio' });
    assert.strictEqual(narration.title, 'Narration failed for this chapter');
    assert.strictEqual(narration.retry, true);

    assert.strictEqual(describePlaybackFailure({}, { online: false }).title, "You're offline");
    assert.strictEqual(describePlaybackFailure({ status: 404 }, { phase: 'open' }).retry, false);
    assert.strictEqual(describePlaybackFailure({ status: 500 }, { phase: 'open' }).title, "Couldn't open this book");
    assert.strictEqual(describePlaybackFailure({ code: 'PLAYBACK_PREPARATION_TIMEOUT' }).title, 'Narration is taking too long');
  });

  await test('one model holds idle, preparing, ready, failed and engine-starting', () => {
    const seen = [];
    const status = createPlayerStatus({ onChange: value => seen.push(value.state) });
    assert.strictEqual(status.get().state, 'idle');
    status.set({ state: 'preparing', bookId: 'b', chapterIndex: 2 });
    status.set({ state: 'failed', bookId: 'b', chapterIndex: 2, title: 'Too many requests', retry: true });
    status.set({ state: 'failed', bookId: 'b', chapterIndex: 2, title: 'Too many requests', retry: true });
    status.set({ state: 'engine-starting', bookId: 'b', chapterIndex: 2, title: 'Narrator engine is starting' });
    status.set({ state: 'ready', bookId: 'b', chapterIndex: 2 });
    status.set({ state: 'bogus' });
    assert.deepStrictEqual(seen, ['preparing', 'failed', 'engine-starting', 'ready', 'idle'],
      'an identical repeat does not notify again; unknown states fall back to idle');
    assert.ok(isPlayerFailureState('failed') && isPlayerFailureState('engine-starting'));
    assert.ok(!isPlayerFailureState('preparing'));
  });

  await test('a failure is owned per book and chapter until a new load intent', () => {
    const status = createPlayerStatus();
    status.set({ state: 'failed', bookId: 7, chapterIndex: 3, title: 'x' });
    assert.strictEqual(status.isFailedFor('7', 3), true);
    assert.strictEqual(status.isFailedFor('7', 4), false);
    assert.strictEqual(status.isFailedFor('8', 3), false);
    status.set({ state: 'failed', bookId: 'open', chapterIndex: null, title: "Couldn't open this book" });
    assert.strictEqual(status.isFailedFor('open', 0), true, 'an open failure covers any chapter');
    status.set({ state: 'preparing', bookId: 'open', chapterIndex: 0 });
    assert.strictEqual(status.isFailedFor('open', 0), false);
    assert.strictEqual(status.get().retry, false, 'only failure states carry Retry');
  });

  await test('compact surfaces get a short state word', () => {
    assert.strictEqual(playerStatusShortLabel({ state: 'engine-starting' }), 'Narrator engine is starting');
    assert.strictEqual(playerStatusShortLabel({ state: 'failed', title: 'Too many requests' }), 'Too many requests');
    assert.strictEqual(playerStatusShortLabel({ state: 'ready' }), '');
  });

  await test('chapter sheet: a title that repeats its number makes the number column redundant', () => {
    assert.strictEqual(labels.titleRepeatsChapterNumber('6. That he has received all blessings', 6), true);
    assert.strictEqual(labels.titleRepeatsChapterNumber('Chapter 12: The Road', 12), true);
    assert.strictEqual(labels.titleRepeatsChapterNumber('The Road', 12), false);
    assert.strictEqual(labels.titleRepeatsChapterNumber('7. Other', 6), false);
    assert.strictEqual(labels.titleLeadingNumber('1. He enters upon the years'), 1);
    assert.strictEqual(labels.titleLeadingNumber('The Road'), null);
    assert.strictEqual(labels.isNarrativeChapter({ type: 'toc' }), false);
    assert.strictEqual(labels.isNarrativeChapter({ type: 'chapter' }), true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
