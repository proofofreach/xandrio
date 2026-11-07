const assert = require('assert');
const { createOfflinePlaybackStitcher } = require('../lib/offline-playback-stitch');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function eventually(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met before timeout');
}

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
    console.error(`    ${error.stack || error.message}`);
  }
}

(async () => {
  await test('stitches one chapter at a time in schedule order and deduplicates a queued chapter', async () => {
    const gates = new Map();
    const started = [];
    let active = 0;
    let maximum = 0;
    const stitcher = createOfflinePlaybackStitcher({
      stitch: async ({ bookId, chapterIndex }) => {
        const key = `${bookId}:${chapterIndex}`;
        started.push(key);
        active += 1;
        maximum = Math.max(maximum, active);
        const gate = deferred();
        gates.set(key, gate);
        await gate.promise;
        active -= 1;
      }
    });
    // Scheduling returns at once: the caller never waits for a stitch.
    assert.strictEqual(stitcher.schedule({ key: 'a:0', bookId: 'a', chapterIndex: 0 }), true);
    assert.strictEqual(stitcher.schedule({ key: 'a:1', bookId: 'a', chapterIndex: 1 }), true);
    assert.strictEqual(stitcher.schedule({ key: 'a:1', bookId: 'a', chapterIndex: 1 }), false);
    assert.strictEqual(stitcher.schedule({ key: 'b:0', bookId: 'b', chapterIndex: 0 }), true);
    await eventually(() => started.length === 1);
    gates.get('a:0').resolve();
    await eventually(() => started.length === 2);
    gates.get('a:1').resolve();
    await eventually(() => started.length === 3);
    gates.get('b:0').resolve();
    await stitcher.waitForIdle();
    assert.deepStrictEqual(started, ['a:0', 'a:1', 'b:0']);
    assert.strictEqual(maximum, 1);
  });

  await test('holds the chapter against eviction only while its stitch runs', async () => {
    const holds = [];
    const gate = deferred();
    const stitcher = createOfflinePlaybackStitcher({
      retain: (bookId, chapterIndex) => {
        const hold = { key: `${bookId}:${chapterIndex}`, released: false };
        holds.push(hold);
        return () => { hold.released = true; };
      },
      stitch: async ({ chapterIndex }) => {
        assert.strictEqual(holds.at(-1).released, false);
        if (chapterIndex === 0) await gate.promise;
        if (chapterIndex === 1) throw new Error('chunk vanished');
      },
      onError: () => {}
    });
    stitcher.schedule({ key: 'a:0', bookId: 'a', chapterIndex: 0 });
    stitcher.schedule({ key: 'a:1', bookId: 'a', chapterIndex: 1 });
    await eventually(() => holds.length === 1);
    assert.deepStrictEqual(holds.map(hold => hold.key), ['a:0'], 'a queued chapter is not held');
    gate.resolve();
    await stitcher.waitForIdle();
    assert.deepStrictEqual(holds.map(hold => [hold.key, hold.released]), [['a:0', true], ['a:1', true]]);
  });

  await test('reports failures, ignores cancellation, and keeps working afterwards', async () => {
    const errors = [];
    let calls = 0;
    const stitcher = createOfflinePlaybackStitcher({
      stitch: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ffmpeg failed');
      },
      onError: (error, job) => errors.push(`${job.key}:${error.message}`)
    });
    stitcher.schedule({ key: 'a:0', bookId: 'a', chapterIndex: 0 });
    stitcher.schedule({ key: 'a:1', bookId: 'a', chapterIndex: 1 });
    await stitcher.waitForIdle();
    assert.deepStrictEqual(errors, ['a:0:ffmpeg failed']);
    assert.strictEqual(calls, 2);
  });

  await test('cancelBook drops queued chapters and aborts the active stitch for that title only', async () => {
    const started = [];
    const errors = [];
    const stitcher = createOfflinePlaybackStitcher({
      stitch: ({ key, bookId, signal }) => {
        started.push(key);
        if (bookId === 'b') return Promise.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(
          Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
      },
      onError: error => errors.push(error.message)
    });
    stitcher.schedule({ key: 'a:0', bookId: 'a', chapterIndex: 0 });
    stitcher.schedule({ key: 'a:1', bookId: 'a', chapterIndex: 1 });
    stitcher.schedule({ key: 'b:0', bookId: 'b', chapterIndex: 0 });
    await eventually(() => started.length === 1);
    await stitcher.cancelBook('a');
    await stitcher.waitForIdle();
    assert.deepStrictEqual(started, ['a:0', 'b:0']);
    assert.deepStrictEqual(errors, []);
    // The title can be stitched again after its cancellation.
    started.length = 0;
    stitcher.schedule({ key: 'b:1', bookId: 'b', chapterIndex: 1 });
    await stitcher.waitForIdle();
    assert.deepStrictEqual(started, ['b:1']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
