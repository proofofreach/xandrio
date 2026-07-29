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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 1;
    this.playbackRate = 1;
    this.error = null;
    this.src = '';
    this.playCalls = 0;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn();
  }
  countFor(type) {
    return this.listeners.get(type)?.size || 0;
  }
  pause() { this.paused = true; }
  async play() {
    this.playCalls += 1;
    this.paused = false;
  }
  load() {}
  removeAttribute() {}
}

(async () => {
  global.window = {};
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'),
    'utf8'
  );
  Function(lifecycleSource)();
  global.Audio = FakeAudio;
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'chunk-player.js'),
    'utf8'
  );
  Function(source)();
  const ChunkPlayer = global.window.ChunkPlayer;

  await test('cancelling a manifest fetch rejects promptly and suppresses stale state', async () => {
    const manifestResponse = deferred();
    global.fetch = () => manifestResponse.promise;
    let ready = 0;
    const player = new ChunkPlayer({ onReady: () => { ready += 1; } });

    const load = player.loadChapter('book-a', 1);
    player.cancelPendingLoad();
    manifestResponse.resolve({
      ok: true,
      async json() { return { totalChunks: 0, chunks: [], servedTier: 'instant' }; }
    });
    await assert.rejects(load, error => error?.cancelled === true);

    assert.strictEqual(ready, 0);
    assert.strictEqual(player.manifest, null);
    assert.strictEqual(player.servedTier, null);
  });

  await test('cancelling a chunk poll rejects immediately and ignores its late response', async () => {
    const refreshResponse = deferred();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: true,
          async json() {
            return { totalChunks: 1, chunks: [{ status: 'queued' }], servedTier: 'instant' };
          }
        };
      }
      return refreshResponse.promise;
    };
    let ready = 0;
    const player = new ChunkPlayer({ onReady: () => { ready += 1; } });

    const load = player.loadChapter('book-a', 1);
    await new Promise(resolve => setImmediate(resolve));
    player.cancelPendingLoad();
    await assert.rejects(
      Promise.race([
        load,
        new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled poll did not settle')), 100))
      ]),
      error => error?.cancelled === true
    );

    refreshResponse.resolve({
      ok: true,
      async json() { return { totalChunks: 1, chunks: [{ status: 'ready' }], servedTier: 'premium' }; }
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(ready, 0);
    assert.strictEqual(player.manifest.chunks[0].status, 'queued');
    assert.strictEqual(player.servedTier, 'instant');
  });

  await test('a new chapter load cancels an older poll wait without an explicit cancel call', async () => {
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      if (fetchCount <= 2) {
        return {
          ok: true,
          async json() {
            return { totalChunks: 1, chunks: [{ status: 'queued' }], servedTier: 'instant' };
          }
        };
      }
      return {
        ok: true,
        async json() { return { totalChunks: 0, chunks: [], servedTier: 'instant' }; }
      };
    };
    const ready = [];
    const player = new ChunkPlayer({ onReady: () => ready.push(player.chapterIndex) });

    const first = player.loadChapter('book-a', 1);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert(player._pollTimer, 'the first chapter should be sleeping between manifest polls');

    const second = player.loadChapter('book-a', 2);
    const firstCancelled = assert.rejects(first, error => error?.cancelled === true);
    await Promise.race([
      Promise.all([firstCancelled, second]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('superseded load did not settle')), 100))
    ]);

    assert.deepStrictEqual(ready, [2]);
  });

  await test('a failed manifest rejects instead of committing a broken engine', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    const errors = [];
    const player = new ChunkPlayer({ onError: error => errors.push(error) });

    await assert.rejects(player.loadChapter('book-a', 1), /manifest fetch failed/i);
    assert.strictEqual(errors.length, 1);
  });

  await test('a silent chunk media load times out and reaches onError', async () => {
    global.fetch = async () => ({
      ok: true,
      async json() {
        return { totalChunks: 1, chunks: [{ status: 'ready', url: '/chunk.mp3' }] };
      }
    });
    const errors = [];
    const player = new ChunkPlayer({
      chunkLoadTimeoutMs: 25,
      maxChunkLoadRetries: 0,
      onError: error => errors.push(error)
    });

    await assert.rejects(
      Promise.race([
        player.loadChapter('book-a', 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('chunk media load did not time out')), 100))
      ]),
      /timed out/i
    );
    assert.strictEqual(errors.length, 1);
  });

  await test('continues across chunk sources on the user-owned media element', async () => {
    const audio = new FakeAudio();
    global.fetch = async () => ({
      ok: true,
      async json() {
        return {
          totalChunks: 2,
          servedTier: 'instant',
          chunks: [
            { status: 'ready', url: '/chunk-0.mp3' },
            { status: 'ready', url: '/chunk-1.mp3' }
          ]
        };
      }
    });
    const player = new ChunkPlayer({ audio, maxChunkLoadRetries: 0 });

    const load = player.loadChapter('book-a', 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(audio.src, '/chunk-0.mp3');
    audio.duration = 8;
    audio.emit('loadedmetadata');
    await load;
    await player.play();

    audio.emit('ended');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(audio.src, '/chunk-1.mp3');
    audio.duration = 9;
    audio.emit('loadedmetadata');
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(player.currentChunk, 1);
    assert.strictEqual(audio.playCalls, 2);
  });

  function readyPlayer(durations, { currentChunk = 0, currentTime = 0 } = {}) {
    const audio = new FakeAudio();
    const player = new ChunkPlayer({ audio, maxChunkLoadRetries: 0 });
    player.bookId = 'book-a';
    player.chapterIndex = 2;
    player.totalChunks = durations.length;
    player.currentChunk = currentChunk;
    player.manifest = {
      totalChunks: durations.length,
      chunks: durations.map((_, index) => ({ status: 'ready', url: `/chunk-${index}.mp3` }))
    };
    player.chunkDurations = durations.map((duration, index) => index === currentChunk ? duration : null);
    audio.src = `/chunk-${currentChunk}.mp3`;
    audio.duration = durations[currentChunk];
    audio.currentTime = currentTime;
    player._refreshManifest = async () => true;
    player._preloadNext = () => {};
    player._loadChunkInto = async (target, chunkIndex) => {
      target.src = `/chunk-${chunkIndex}.mp3`;
      target.duration = durations[chunkIndex];
      target.currentTime = 0;
      player.chunkDurations[chunkIndex] = durations[chunkIndex];
    };
    return { player, audio };
  }

  await test('forward skip crosses chunks using measured durations', async () => {
    const { player, audio } = readyPlayer([12, 20, 30], { currentTime: 10 });
    await player.skip(15);
    assert.strictEqual(player.currentChunk, 1);
    assert.strictEqual(audio.currentTime, 13);
  });

  await test('forward skip prioritizes an unrendered target before continuing', async () => {
    const { player, audio } = readyPlayer([12, 20], { currentTime: 10 });
    player.manifest.chunks[1].status = 'queued';
    const prioritized = [];
    player._prioritizeChunk = async chunkIndex => { prioritized.push(chunkIndex); };
    player._pollUntilChunkReady = async chunkIndex => {
      player.manifest.chunks[chunkIndex].status = 'ready';
    };

    await player.skip(15);
    assert.deepStrictEqual(prioritized, [1]);
    assert.strictEqual(player.currentChunk, 1);
    assert.strictEqual(audio.currentTime, 13);
  });

  await test('rapid forward skips serialize across an unrendered boundary', async () => {
    const { player, audio } = readyPlayer([12, 20, 30], { currentTime: 10 });
    player.manifest.chunks[1].status = 'queued';
    const release = deferred();
    player._prioritizeChunk = async () => {};
    player._pollUntilChunkReady = async chunkIndex => {
      await release.promise;
      player.manifest.chunks[chunkIndex].status = 'ready';
    };

    const first = player.skip(15);
    await new Promise(resolve => setImmediate(resolve));
    const second = player.skip(15);
    release.resolve();
    await Promise.all([first, second]);

    assert.strictEqual(player.currentChunk, 2);
    assert.strictEqual(audio.currentTime, 8);
  });

  await test('backward skip crosses chunks using measured durations', async () => {
    const { player, audio } = readyPlayer([12, 20, 30], { currentChunk: 2, currentTime: 3 });
    await player.skip(-10);
    assert.strictEqual(player.currentChunk, 1);
    assert.strictEqual(audio.currentTime, 13);
  });

  await test('multi-chunk skip resumes playback only after the final landing point', async () => {
    const { player, audio } = readyPlayer([12, 20, 30], { currentTime: 10 });
    player._isPlaying = true;
    audio.paused = false;
    await player.skip(30);
    assert.strictEqual(player.currentChunk, 2);
    assert.strictEqual(audio.currentTime, 8);
    assert.strictEqual(audio.playCalls, 1);
  });

  await test('targeted manifest refresh identifies the skipped-to chunk', async () => {
    const player = new ChunkPlayer({ audio: new FakeAudio() });
    player.bookId = 'book-a';
    player.chapterIndex = 2;
    player.servedTier = 'instant';
    let requestedUrl = null;
    global.fetch = async url => {
      requestedUrl = url;
      return {
        ok: true,
        async json() { return { totalChunks: 0, chunks: [] }; }
      };
    };
    await player._fetchManifest(undefined, 7);
    assert.strictEqual(requestedUrl, '/api/chunks/book-a/2/manifest?tier=instant&targetChunk=7');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
