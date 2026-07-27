const assert = require('assert');
const { createPlaybackPrefetchCoordinator } = require('../lib/playback-prefetch');

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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  await test('meaningful playback maintains a three-chapter forward window', async () => {
    const prepared = [];
    const cancelled = [];
    const chapters = Array.from({ length: 7 }, (_, index) => ({
      title: `Chapter ${index + 1}`,
      text: `Narration for chapter ${index + 1}`
    }));
    const coordinator = createPlaybackPrefetchCoordinator({
      getChapters: async () => chapters,
      prepareChapter: request => {
        prepared.push(request);
        return Promise.resolve();
      },
      cancelChapters: request => { cancelled.push(request); }
    });

    const first = await coordinator.observe({
      bookId: 'book-1',
      chapterIndex: 0,
      sessionId: 'reader-device',
      tier: 'active',
      variantKey: 'voice-a',
      voice: 'reader-a',
      chunkSize: 2400
    });
    const second = await coordinator.observe({
      bookId: 'book-1',
      chapterIndex: 1,
      sessionId: 'reader-device',
      tier: 'active',
      variantKey: 'voice-a',
      voice: 'reader-a',
      chunkSize: 2400
    });

    assert.deepStrictEqual(first.window, [1, 2, 3]);
    assert.deepStrictEqual(first.scheduled, [1, 2, 3]);
    assert.deepStrictEqual(second.window, [2, 3, 4]);
    assert.deepStrictEqual(second.scheduled, [4]);
    assert.deepStrictEqual(prepared.map(request => request.chapterIndex), [1, 2, 3, 4]);
    assert.deepStrictEqual(cancelled.map(request => request.chapterIndexes), [[1]]);
    assert(prepared.every(request => request.priority === 'lookahead'));
    assert(prepared.every(request => request.origin === 'playback-lookahead'));
    assert(prepared.every(request => request.voice === 'reader-a'));
    assert(prepared.every(request => request.chunkSize === 2400));
  });

  await test('active sessions share a union window before retired chapters cancel', async () => {
    const prepared = [];
    const cancelled = [];
    const chapters = Array.from({ length: 7 }, (_, index) => ({
      text: `Substantive narration for chapter ${index + 1}`
    }));
    const coordinator = createPlaybackPrefetchCoordinator({
      getChapters: async () => chapters,
      prepareChapter: request => { prepared.push(request); },
      cancelChapters: request => { cancelled.push(request); }
    });

    await coordinator.observe({
      bookId: 'shared-book',
      chapterIndex: 0,
      sessionId: 'session-a',
      tier: 'active',
      variantKey: 'voice-a'
    });
    await coordinator.observe({
      bookId: 'shared-book',
      chapterIndex: 1,
      sessionId: 'session-b',
      tier: 'active',
      variantKey: 'voice-a'
    });
    assert.deepStrictEqual(prepared.map(request => request.chapterIndex), [1, 2, 3, 4]);
    assert.deepStrictEqual(cancelled, []);

    await coordinator.observe({
      bookId: 'shared-book',
      chapterIndex: 1,
      sessionId: 'session-a',
      tier: 'active',
      variantKey: 'voice-a'
    });
    assert.deepStrictEqual(cancelled.map(request => request.chapterIndexes), [[1]]);
  });

  await test('a voice change replaces the session horizon for the new variant', async () => {
    const prepared = [];
    const cancelled = [];
    const chapters = Array.from({ length: 5 }, (_, index) => ({
      text: `Substantive narration for chapter ${index + 1}`
    }));
    const coordinator = createPlaybackPrefetchCoordinator({
      getChapters: async () => chapters,
      prepareChapter: request => { prepared.push(request); },
      cancelChapters: request => { cancelled.push(request); }
    });

    await coordinator.observe({
      bookId: 'voice-book',
      chapterIndex: 0,
      sessionId: 'voice-session',
      tier: 'active',
      variantKey: 'voice-a'
    });
    await coordinator.observe({
      bookId: 'voice-book',
      chapterIndex: 0,
      sessionId: 'voice-session',
      tier: 'active',
      variantKey: 'voice-b'
    });

    assert.deepStrictEqual(
      prepared.map(request => [request.variantKey, request.chapterIndex]),
      [
        ['voice-a', 1], ['voice-a', 2], ['voice-a', 3],
        ['voice-b', 1], ['voice-b', 2], ['voice-b', 3]
      ]
    );
    assert.deepStrictEqual(
      cancelled.map(request => [request.variantKey, request.chapterIndexes]),
      [['voice-a', [1, 2, 3]]]
    );
  });

  await test('an inactive session autonomously releases its look-ahead window', async () => {
    const cancelled = [];
    const coordinator = createPlaybackPrefetchCoordinator({
      sessionTtlMs: 20,
      getChapters: async () => Array.from({ length: 5 }, (_, index) => ({
        text: `Substantive narration for chapter ${index + 1}`
      })),
      prepareChapter: async () => {},
      cancelChapters: request => { cancelled.push(request); }
    });

    await coordinator.observe({
      bookId: 'expired-book',
      chapterIndex: 0,
      sessionId: 'expired-session',
      tier: 'active',
      variantKey: 'voice-a'
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.deepStrictEqual(cancelled.map(request => request.chapterIndexes), [[1, 2, 3]]);
  });

  await test('an older observation cannot overwrite a newer playback horizon', async () => {
    const loads = [deferred(), deferred()];
    const prepared = [];
    const cancelled = [];
    let loadIndex = 0;
    const chapters = Array.from({ length: 6 }, (_, index) => ({
      text: `Substantive narration for chapter ${index + 1}`
    }));
    const coordinator = createPlaybackPrefetchCoordinator({
      getChapters: async () => {
        const gate = loads[loadIndex++];
        await gate.promise;
        return chapters;
      },
      prepareChapter: request => { prepared.push(request.chapterIndex); },
      cancelChapters: request => { cancelled.push(request.chapterIndexes); }
    });

    const older = coordinator.observe({
      bookId: 'ordered-book',
      chapterIndex: 0,
      sessionId: 'ordered-session',
      variantKey: 'voice-a'
    });
    const newer = coordinator.observe({
      bookId: 'ordered-book',
      chapterIndex: 1,
      sessionId: 'ordered-session',
      variantKey: 'voice-a'
    });
    loads[1].resolve();
    await newer;
    loads[0].resolve();
    const stale = await older;

    assert.strictEqual(stale.stale, true);
    assert.deepStrictEqual(prepared, [2, 3, 4]);
    assert.deepStrictEqual(cancelled, []);
  });

  await test('retirement aborts preparation before a late enqueue', async () => {
    const gate = deferred();
    const prepared = [];
    const cancelled = [];
    const coordinator = createPlaybackPrefetchCoordinator({
      getChapters: async () => Array.from({ length: 4 }, (_, index) => ({
        text: `Substantive narration for chapter ${index + 1}`
      })),
      prepareChapter: async request => {
        await gate.promise;
        if (request.signal?.aborted) {
          const error = new Error('retired');
          error.name = 'AbortError';
          throw error;
        }
        prepared.push(request.chapterIndex);
      },
      cancelChapters: request => { cancelled.push(request.chapterIndexes); }
    });

    await coordinator.observe({
      bookId: 'retired-book',
      chapterIndex: 0,
      sessionId: 'retired-session',
      variantKey: 'voice-a'
    });
    await coordinator.removeSession('retired-session');
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(prepared, []);
    assert(cancelled.some(indexes => indexes.includes(1)));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
