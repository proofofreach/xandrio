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
  load() {}
  removeAttribute() {}
}

(async () => {
  global.window = {};
  global.Audio = FakeAudio;
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'chunk-player.js'),
    'utf8'
  );
  Function(source)();
  const ChunkPlayer = global.window.ChunkPlayer;

  await test('cancelling a manifest fetch suppresses stale readiness and state', async () => {
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
    await load;

    assert.strictEqual(ready, 0);
    assert.strictEqual(player.manifest, null);
    assert.strictEqual(player.servedTier, null);
  });

  await test('cancelling a chunk poll settles immediately and ignores its late response', async () => {
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
    await Promise.race([
      load,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled poll did not settle')), 100))
    ]);

    refreshResponse.resolve({
      ok: true,
      async json() { return { totalChunks: 1, chunks: [{ status: 'ready' }], servedTier: 'premium' }; }
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(ready, 0);
    assert.strictEqual(player.manifest.chunks[0].status, 'queued');
    assert.strictEqual(player.servedTier, 'instant');
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
