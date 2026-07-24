const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

// Minimal stand-in for an HTMLAudioElement: records listeners so a test can
// fire media events by hand and assert which loads they settle.
function fakeAudio() {
  const listeners = new Map();
  return {
    listeners,
    src: '',
    preload: '',
    volume: 1,
    playbackRate: 1,
    currentTime: 0,
    duration: 10,
    paused: true,
    ended: false,
    error: null,
    loadCalls: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    countFor(type) {
      return listeners.get(type)?.size || 0;
    },
    emit(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn();
    },
    load() { this.loadCalls += 1; },
    pause() { this.paused = true; },
    async play() { this.paused = false; },
    removeAttribute() { this.src = ''; }
  };
}

(async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'single-file-chapter-player.js'),
    'utf8'
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { SingleFileChapterPlayer } = await import(moduleUrl);

  function makePlayer(audio, extra = {}) {
    const ready = [];
    const player = new SingleFileChapterPlayer(audio, {
      onReady: () => ready.push(player.chapterIndex),
      loadTimeoutMs: 50,
      ...extra
    });
    return { player, ready };
  }

  await test('a superseded load never fires onReady', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    const second = player.loadChapter('book1', 1);
    audio.emit('loadedmetadata');
    await Promise.all([first, second]);

    assert.deepStrictEqual(ready, [1], 'only the current chapter reports ready');
  });

  await test('the second load\'s events cannot resolve the first load', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    // The first load's listeners must be gone before the second one arms its own.
    const second = player.loadChapter('book1', 1);
    assert.strictEqual(audio.countFor('loadedmetadata'), 1, 'stale listener was left attached');
    assert.strictEqual(audio.countFor('canplay'), 1, 'stale listener was left attached');

    audio.emit('canplay');
    await Promise.all([first, second]);
    assert.deepStrictEqual(ready, [1]);
  });

  await test('a superseded load settles instead of hanging forever', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    const second = player.loadChapter('book1', 1);
    audio.emit('loadedmetadata');

    // Neither promise may outlive the test; a hung first load would time out here.
    await assert.doesNotReject(Promise.all([first, second]));
  });

  await test('a stalled media element rejects instead of hanging', async () => {
    const audio = fakeAudio();
    const errors = [];
    const { player, ready } = makePlayer(audio, { onError: error => errors.push(error) });

    // No 'canplay', no 'error' — exactly the backgrounded-iOS stall case.
    await assert.rejects(player.loadChapter('book1', 0), /playback failed/i);
    assert.deepStrictEqual(ready, [], 'a timed-out load must not report ready');
    assert.strictEqual(errors.length, 1, 'a timed-out load must clear the loading UI through onError');
  });

  await test('a settled load leaves no listeners or timer behind', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(audio.countFor('loadedmetadata'), 0);
    assert.strictEqual(audio.countFor('canplay'), 0);
    // 'error' keeps only the long-lived engine handler attached by _attach().
    assert.strictEqual(audio.countFor('error'), 1);
  });

  await test('a rejected play attempt removes its fallback listeners immediately', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.play = async () => { throw new Error('autoplay denied'); };

    await assert.rejects(player.play(), /autoplay denied/);
    assert.strictEqual(audio.countFor('playing'), 1, 'only the engine-level playing listener should remain');
    assert.strictEqual(audio.countFor('error'), 1, 'only the engine-level error listener should remain');
  });

  await test('dispose during a load suppresses onReady', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const load = player.loadChapter('book1', 0);
    player.dispose();
    audio.emit('loadedmetadata');
    await load;

    assert.deepStrictEqual(ready, [], 'a disposed engine must not report ready');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
