/**
 * Smart Rewind position-sync tests.
 *
 * Run: /opt/homebrew/opt/node@24/bin/node test/test-smart-rewind-sync.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createUserLibraryState } = require('../lib/user-library-state');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function functionSource(name) {
  const start = appSource.indexOf(`function ${name}()`);
  assert.notStrictEqual(start, -1, `${name} exists`);
  const bodyStart = appSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === '{') depth += 1;
    if (appSource[index] === '}' && --depth === 0) return appSource.slice(start, index + 1);
  }
  throw new Error(`Could not find the end of ${name}`);
}

const applySource = functionSource('applySmartRewindForResume');
const retrySource = functionSource('retryDeferredSmartRewind');

function createHarness(outcome, player) {
  const saved = [];
  const run = new Function('deps', `
    let currentBook = deps.currentBook;
    let currentChapter = deps.currentChapter;
    let chunkPlayer = deps.player;
    let deferredSmartRewind = null;
    const smartRewind = { clear() {} };
    const smartRewindIsEnabled = () => true;
    const applyRewindForResume = deps.applyRewindForResume;
    const saved = deps.saved;
    const savePosition = options => { saved.push(options); return Promise.resolve(); };
    const showToast = () => {};
    ${applySource}
    ${retrySource}
    return { applySmartRewindForResume, retryDeferredSmartRewind, saved };
  `);
  return run({
    currentBook: { id: 'book-a' },
    currentChapter: 3,
    player,
    saved,
    applyRewindForResume: () => outcome
  });
}

function assertBackwardPayloadIsAccepted(options) {
  assert.deepStrictEqual(options, { allowBackward: true });
  const now = 1_735_689_600_000;
  const state = createUserLibraryState({ now: () => now });
  const positions = { users: { reader: { book: {
    chapterIndex: 3,
    timestamp: 100,
    updatedAtMs: now,
    finished: false
  } } } };
  const result = state.recordPosition(positions, {
    userId: 'reader',
    bookId: 'book',
    chapterIndex: 3,
    timestamp: 90,
    updatedAtMs: now,
    allowBackward: options.allowBackward
  });
  assert.strictEqual(result.ignored, undefined, 'the server accepts the backward rewind payload');
  assert.strictEqual(result.position.timestamp, 90);
}

{
  const harness = createHarness(
    { status: 'applied', rewindSeconds: 10, targetSeconds: 90 },
    { getCurrentTime: () => 100 }
  );
  harness.applySmartRewindForResume();
  assert.strictEqual(harness.saved.length, 1, 'an immediate rewind saves once');
  assertBackwardPayloadIsAccepted(harness.saved[0]);
}

{
  const player = {
    getCurrentTime: () => 100,
    trySeekSync: () => false
  };
  const harness = createHarness(
    { status: 'deferred', rewindSeconds: 10, targetSeconds: 90 },
    player
  );
  harness.applySmartRewindForResume();
  harness.retryDeferredSmartRewind();
  assert.strictEqual(harness.saved.length, 0, 'a deferred rewind is not saved before it applies');
  player.trySeekSync = target => target === 90;
  harness.retryDeferredSmartRewind();
  assert.strictEqual(harness.saved.length, 1, 'an applied deferred rewind saves once');
  assertBackwardPayloadIsAccepted(harness.saved[0]);
}

assert.match(applySource, /currentBook\?\.id === bookId/);
assert.match(applySource, /currentChapter === chapterIndex/);
assert.match(retrySource, /deferredSmartRewind !== pending/);
assert.match(retrySource, /pending\.bookId !== currentBook\?\.id/);
assert.match(retrySource, /pending\.chapterIndex !== currentChapter/);

console.log('2 passed, 0 failed');
