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
    playCalls: 0,
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
    async play() { this.playCalls += 1; this.paused = false; },
    removeAttribute() { this.src = ''; }
  };
}

(async () => {
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'),
    'utf8'
  );
  Function(lifecycleSource)();
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

  await test('a superseded load rejects promptly and never fires onReady', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    const second = player.loadChapter('book1', 1);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    audio.emit('loadedmetadata');
    await Promise.all([firstCancelled, second]);

    assert.deepStrictEqual(ready, [1], 'only the current chapter reports ready');
  });

  await test('loads the stable chapter stream first and falls back on the same media element', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const load = player.loadChapter('book 1', 2);
    assert.strictEqual(audio.src, '/api/audio-stream/book%201/2');

    audio.error = { message: 'stream unavailable' };
    audio.emit('error');
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(audio.src, '/api/audio/book%201/2');
    audio.error = null;
    audio.emit('loadedmetadata');
    await load;
  });

  await test('continuous first listening needs only the original play call', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    const play = player.play();
    audio.emit('playing');
    await play;
    audio.currentTime = 45;
    audio.emit('timeupdate');
    audio.currentTime = 90;
    audio.emit('timeupdate');

    assert.strictEqual(audio.src, '/api/audio-stream/book1/0');
    assert.strictEqual(audio.playCalls, 1);
    assert.deepStrictEqual(
      { backend: player.getPosition().backend, isPlaying: player.getPosition().isPlaying },
      { backend: 'audio-stream', isPlaying: true }
    );
  });

  await test('streamed WAV uses chapter timing and preserves the resolved tier', async () => {
    const audio = fakeAudio();
    audio.duration = Infinity;
    audio.currentTime = 30;
    const { player } = makePlayer(audio, {
      getEstimatedDuration: (_bookId, chapterIndex) => chapterIndex === 2 ? 120 : 0,
      resolveServedTier: async () => 'instant'
    });
    const load = player.loadChapter('book1', 2);
    await new Promise(resolve => setImmediate(resolve));
    audio.emit('loadedmetadata');
    await load;

    assert.strictEqual(player.getTotalTime(), 120);
    assert.strictEqual(player.getProgressPercent(), 25);
    assert.strictEqual(player.servedTier, 'instant');
    assert.strictEqual(player.getPosition().totalEstimatedTime, 30);
    assert.strictEqual(audio.src, '/api/audio-stream/book1/2?tier=instant');
  });

  await test('the second load\'s events cannot resolve the first load', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    // The first load's listeners must be gone before the second one arms its own.
    const second = player.loadChapter('book1', 1);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    assert.strictEqual(audio.countFor('loadedmetadata'), 1, 'stale listener was left attached');
    assert.strictEqual(audio.countFor('canplay'), 1, 'stale listener was left attached');

    audio.emit('canplay');
    await Promise.all([firstCancelled, second]);
    assert.deepStrictEqual(ready, [1]);
  });

  await test('a superseded load rejects instead of hanging forever', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);

    const first = player.loadChapter('book1', 0);
    const second = player.loadChapter('book1', 1);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    audio.emit('loadedmetadata');

    // Neither promise may outlive the test; a hung first load would time out here.
    await Promise.race([
      Promise.all([firstCancelled, second]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('superseded load did not settle')), 100))
    ]);
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

  await test('a rejected play reports paused state to the session UI', async () => {
    const audio = fakeAudio();
    const changes = [];
    const { player } = makePlayer(audio, {
      onPlaybackChange: (playing, detail) => changes.push([playing, detail.reason])
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.play = async () => {
      const error = new Error('autoplay denied');
      error.name = 'NotAllowedError';
      throw error;
    };

    await assert.rejects(player.play(), error => error.name === 'NotAllowedError');

    assert.strictEqual(player.isPlaying, false);
    assert.deepStrictEqual(changes, [[false, 'app']]);
  });

  await test('distinguishes app controls from native playback interruptions', async () => {
    const audio = fakeAudio();
    const changes = [];
    const { player } = makePlayer(audio, {
      onPlaybackChange: (playing, detail) => changes.push([playing, detail.reason])
    });
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;

    const play = player.play();
    audio.emit('play');
    audio.emit('playing');
    await play;
    player.pause();
    audio.emit('pause');

    audio.paused = false;
    audio.emit('play');
    audio.emit('playing');
    audio.paused = true;
    audio.emit('pause');

    assert.deepStrictEqual(changes, [
      [true, 'app'],
      [false, 'app'],
      [true, 'external'],
      [false, 'external']
    ]);
  });

  await test('a rejected native play does not leave an unhandled media wait rejection', async () => {
    const audio = fakeAudio();
    const { player } = makePlayer(audio);
    const load = player.loadChapter('book1', 0);
    audio.emit('loadedmetadata');
    await load;
    audio.play = async () => { throw new Error('autoplay denied'); };
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(player.play(), /autoplay denied/);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  await test('a media error during load notifies onError exactly once', async () => {
    const audio = fakeAudio();
    const errors = [];
    const { player } = makePlayer(audio, { onError: error => errors.push(error) });
    const load = player.loadChapter('book1', 0);
    audio.error = { message: 'decode failed' };
    audio.emit('error');

    await assert.rejects(load, /decode failed/);
    assert.strictEqual(errors.length, 1);
  });

  await test('dispose during a load suppresses onReady', async () => {
    const audio = fakeAudio();
    const { player, ready } = makePlayer(audio);

    const load = player.loadChapter('book1', 0);
    player.dispose();
    audio.emit('loadedmetadata');
    await assert.rejects(load, error => error?.cancelled === true);

    assert.deepStrictEqual(ready, [], 'a disposed engine must not report ready');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
