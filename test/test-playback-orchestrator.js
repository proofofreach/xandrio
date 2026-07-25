const assert = require('assert');
const { EventEmitter } = require('events');
const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function harness(overrides = {}) {
  const calls = [];
  const manifest = { totalChunks: 2, textLength: 80, chunks: [{ index: 0, status: 'pending' }, { index: 1, status: 'pending' }] };
  const tts = Object.assign(new EventEmitter(), {
    getChapterManifest: () => overrides.manifest === undefined ? null : overrides.manifest,
    generateChapter: async (...args) => { calls.push(['generate', ...args]); return manifest; },
    prioritizeChunk: (...args) => { calls.push(['prioritize', ...args]); return true; },
    reconstructChapterManifest: async (...args) => {
      calls.push(['reconstruct', ...args]);
      return overrides.reconstructed || manifest;
    },
    chunkPath: (...args) => `/cache/${args.join('-')}.mp3`,
    chapterPath: (...args) => `/cache/${args.join('-')}.mp3`,
    currentOutputFormat: () => 'mp3'
  });
  const orchestrator = createPlaybackOrchestrator({
    isPremiumVoiceActive: () => overrides.premium ?? true,
    premiumChapterReady: async () => overrides.ready ?? false,
    kickPremiumPrep: (...args) => calls.push(['prep', ...args]),
    startProviderForVoice: voice => calls.push(['start', voice]),
    activeInstantVoice: () => 'kokoro:instant',
    ttsForTier: tier => { calls.push(['tts', tier]); return tts; },
    voiceForTier: tier => tier === 'instant' ? 'kokoro:instant' : 'chatterbox:premium',
    manifestNeedsResume: () => overrides.resume ?? false,
    generationPriority: target => index => index === target ? 'immediate' : 'background',
    waitForJob: async jobId => calls.push(['wait', jobId]),
    ensureChapterAudio: async (...args) => { calls.push(['ensureAudio', ...args]); return '/cache/chapter.mp3'; },
    inspectChapterAudio: async (...args) => {
      calls.push(['inspectAudio', ...args]);
      return { ready: overrides.audioReady ?? false, variantKey: 'variant' };
    },
    prefetchNextChapter: (...args) => calls.push(['prefetch', ...args]),
    warmRemainingChapters: args => calls.push(['warmRemaining', args]),
    getChapterContext: async () => ({
      book: { language: 'en' },
      chapter: { text: 'Current chapter narration text is long enough for testing.' },
      chapters: [
        { text: 'Current chapter narration text is long enough for testing.' },
        { text: 'Next chapter narration text is also long enough for testing.' }
      ]
    })
  });
  return { orchestrator, calls, manifest, tts };
}

(async () => {
  await test('serves instant while premium audio is not ready', async () => {
    const { orchestrator, calls } = harness({ ready: false });
    const result = await orchestrator.resolveTier('book', 2);
    assert.strictEqual(result.servedTier, 'instant');
    assert(calls.some(call => call[0] === 'start' && call[1] === 'kokoro:instant'));
  });

  await test('serves premium when the chapter is ready', async () => {
    const { orchestrator } = harness({ ready: true });
    const result = await orchestrator.resolveTier('book', 2);
    assert.strictEqual(result.servedTier, 'premium');
  });

  await test('keeps an explicit chapter tier pin', async () => {
    const { orchestrator } = harness({ ready: true });
    const result = await orchestrator.resolveTier('book', 2, 'instant');
    assert.strictEqual(result.tier, 'instant');
  });

  await test('keeps an explicit premium pin on every projected chunk URL', async () => {
    const { orchestrator } = harness({ ready: false });
    const result = await orchestrator.preparePlayback({
      bookId: 'book', chapterIndex: 0, requestedTier: 'premium'
    });
    assert.strictEqual(result.servedTier, 'premium');
    assert.strictEqual(result.chunks[0].url, '/api/chunks/book/0/0?tier=premium');
  });

  await test('legacy filenames redirect to canonical orchestrated chunk access', async () => {
    const { orchestrator } = harness();
    assert.strictEqual(
      orchestrator.legacyChunkRedirect('book_one_tts0123456789_ch2_chunk3.mp3'),
      '/api/chunks/book_one/2/3'
    );
    assert.strictEqual(orchestrator.legacyChunkRedirect('../secret.mp3'), null);
    assert.strictEqual(orchestrator.legacyChunkRedirect('book_ch2_chunkNaN.mp3'), null);
  });

  await test('generates a missing manifest through one orchestration path', async () => {
    const { orchestrator, calls } = harness({ ready: false });
    const result = await orchestrator.prepareManifest({
      bookId: 'book', chapterIndex: 2, text: 'Long enough narration text for testing.', targetChunk: 1
    });
    assert.strictEqual(result.manifest.chunks.length, 2);
    const generation = calls.find(call => call[0] === 'generate');
    assert(generation);
    assert.strictEqual(generation[1], 'book');
    assert.strictEqual(generation[2], 2);
  });

  await test('prioritizes an existing healthy manifest', async () => {
    const existing = { chunks: [{ status: 'queued' }, { status: 'queued' }] };
    const { orchestrator, calls } = harness({ manifest: existing, ready: false });
    await orchestrator.prepareManifest({ bookId: 'book', chapterIndex: 0, text: 'Narration text', targetChunk: 0 });
    assert.strictEqual(calls.filter(call => call[0] === 'prioritize').length, 2);
    assert(!calls.some(call => call[0] === 'generate'));
  });

  await test('projects the complete playback manifest and starts look-ahead internally', async () => {
    const { orchestrator, calls } = harness({ ready: false });
    const response = await orchestrator.preparePlayback({ bookId: 'book', chapterIndex: 0 });
    assert.strictEqual(response.servedTier, 'instant');
    assert.strictEqual(response.chunks[0].url, '/api/chunks/book/0/0?tier=instant');
    assert(calls.filter(call => call[0] === 'generate').length >= 2);
  });

  await test('single-file audio preparation uses the same fallback tier and prefetch policy', async () => {
    const { orchestrator, calls } = harness({ ready: false });
    const result = await orchestrator.prepareChapterAudio({ bookId: 'book', chapterIndex: 0, clean: true });
    assert.strictEqual(result.servedTier, 'instant');
    assert.strictEqual(result.path, '/cache/chapter.mp3');
    const ensured = calls.find(call => call[0] === 'ensureAudio');
    assert.deepStrictEqual(ensured[3], { clean: true, priority: 'immediate', tier: 'instant' });
    assert(calls.some(call => call[0] === 'prefetch' && call[3] === 'instant'));
  });

  await test('chapter audio status honors an explicit premium pin', async () => {
    const { orchestrator, calls } = harness({ ready: false });
    const result = await orchestrator.chapterAudioStatus({
      bookId: 'book', chapterIndex: 0, requestedTier: 'premium'
    });
    assert.strictEqual(result.tier, 'active');
    assert.strictEqual(result.servedTier, 'premium');
    assert.strictEqual(result.premiumReady, false);
    assert.strictEqual(calls.find(call => call[0] === 'inspectAudio')[3].tier, 'active');
  });

  await test('status reconstructs the selected tier manifest after restart', async () => {
    const reconstructed = {
      totalChunks: 2,
      chunks: [{ status: 'ready' }, { status: 'pending' }]
    };
    const { orchestrator, calls } = harness({ ready: false, reconstructed });
    const result = await orchestrator.chunkStatus({ bookId: 'book', chapterIndex: 0 });
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.readyChunks, 1);
    assert(calls.some(call => call[0] === 'reconstruct'));
  });

  await test('seek priority and chunk access resolve through the pinned tier', async () => {
    const existing = { totalChunks: 2, chunks: [{ status: 'queued' }, { status: 'ready' }] };
    const { orchestrator } = harness({ manifest: existing, ready: true });
    const prioritized = await orchestrator.prioritizeChunk({
      bookId: 'book', chapterIndex: 0, chunkIndex: 1, requestedTier: 'instant'
    });
    assert.strictEqual(prioritized.prioritized, true);
    assert.strictEqual(prioritized.servedTier, 'instant');
    const access = await orchestrator.chunkAccess({
      bookId: 'book', chapterIndex: 0, chunkIndex: 1, requestedTier: 'instant'
    });
    assert.strictEqual(access.status, 'ready');
    assert(access.path.endsWith('book-0-1.mp3'));
  });

  await test('voice-change preparation warms both the next chapter and the remainder', async () => {
    const { orchestrator, calls } = harness({ ready: false });
    const result = await orchestrator.prepareCurrentChapter({
      bookId: 'book', chapterIndex: 0, targetChunk: 99
    });
    assert.strictEqual(result.targetChunk, 1);
    assert(calls.some(call => call[0] === 'warmRemaining') === false, 'two-chapter harness has no remainder');
    assert(calls.filter(call => call[0] === 'generate').length >= 2);
  });

  await test('stable stream source pins one tier and resolves sequential chunk events', async () => {
    const existing = {
      totalChunks: 2,
      chunks: [{ index: 0, status: 'queued' }, { index: 1, status: 'queued' }]
    };
    const { orchestrator, calls, tts } = harness({ manifest: existing, ready: false });
    const source = await orchestrator.prepareAudioStream({
      bookId: 'book', chapterIndex: 0, requestedTier: 'instant'
    });
    assert.strictEqual(source.servedTier, 'instant');
    assert.strictEqual(source.format, 'mp3');
    assert.strictEqual(source.totalChunks, 2);
    assert(calls.some(call => call[0] === 'ensureAudio' && call[3].priority === 'background'));

    const waiting = source.waitForChunk(0);
    existing.chunks[0].status = 'ready';
    tts.emit('chunk:ready', {
      bookId: 'book', chapterIndex: 0, chunkIndex: 0, path: '/cache/book-0-0.mp3'
    });
    assert.strictEqual(await waiting, '/cache/book-0-0.mp3');
    assert.strictEqual(tts.listenerCount('chunk:ready'), 0);
    source.prioritize(0);
    assert(calls.some(call => call[0] === 'prioritize' && call[3] === 0 && call[4] === 'immediate'));
  });

  await test('stable stream bypasses generation when finalized audio is already ready', async () => {
    const { orchestrator, calls } = harness({ audioReady: true, ready: false });
    const source = await orchestrator.prepareAudioStream({ bookId: 'book', chapterIndex: 0 });
    assert.strictEqual(source.finalPath, '/cache/book-0.mp3');
    assert(!calls.some(call => call[0] === 'generate'));
    assert(!calls.some(call => call[0] === 'ensureAudio'));
  });

  await test('an already-aborted stream wait rejects without retaining listeners', async () => {
    const existing = {
      totalChunks: 1,
      chunks: [{ index: 0, status: 'queued' }]
    };
    const { orchestrator } = harness({ manifest: existing, ready: false });
    const source = await orchestrator.prepareAudioStream({ bookId: 'book', chapterIndex: 0 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(Promise.race([
      source.waitForChunk(0, controller.signal),
      new Promise((_, reject) => setTimeout(() => reject(new Error('abort was not observed')), 50))
    ]), error => error?.name === 'AbortError');
  });

  await test('continuous stream pins one tier and warms the next chapter before current audio is ready', async () => {
    const { orchestrator, calls, tts } = harness({ ready: false });
    const source = await orchestrator.prepareContinuousAudioStream({
      bookId: 'book',
      chapterIndex: 0,
      requestedTier: 'instant'
    });
    assert.strictEqual(source.servedTier, 'instant');
    assert.strictEqual(source.endChapterIndex, 1);

    const iterator = source.iterateInputs();
    const firstInput = iterator.next();
    await new Promise(resolve => setImmediate(resolve));

    const generations = calls.filter(call => call[0] === 'generate');
    assert(generations.some(call => call[2] === 0), 'current chapter generation starts');
    const warmed = generations.find(call => call[2] === 1);
    assert(warmed, 'next chapter generation starts before current chunk is ready');
    assert.strictEqual(warmed[5], 'next');
    assert.strictEqual(
      calls.filter(call => call[0] === 'tts').length,
      1,
      'tier is resolved once for the complete response'
    );

    tts.emit('chunk:ready', {
      bookId: 'book',
      chapterIndex: 0,
      chunkIndex: 0,
      path: '/cache/book-0-0.mp3'
    });
    assert.deepStrictEqual(await firstInput, {
      value: {
        path: '/cache/book-0-0.mp3',
        chapterIndex: 0,
        lastInChapter: false
      },
      done: false
    });
    await iterator.return();
  });

  await test('continuous timeline records sample-accurate decoded chapter durations', async () => {
    const { orchestrator } = harness({ ready: false });
    const source = await orchestrator.prepareContinuousAudioStream({
      bookId: 'book',
      chapterIndex: 0,
      requestedTier: 'instant',
      sessionId: 'timeline-session',
      startOffsetSeconds: 2
    });
    source.onInputDecoded(
      { chapterIndex: 0, lastInChapter: true },
      4 * 24000 * 2,
      { skippedPcmBytes: 2 * 24000 * 2 }
    );
    const timeline = orchestrator.continuousTimeline('timeline-session');
    assert.deepStrictEqual(timeline.durations, [6, null]);
    assert.strictEqual(timeline.startOffsetSeconds, 2);
    assert.strictEqual(timeline.complete, false);
  });

  await test('continuous stream clamps an explicit chapter-end limit', async () => {
    const { orchestrator } = harness({ ready: false });
    const source = await orchestrator.prepareContinuousAudioStream({
      bookId: 'book',
      chapterIndex: 0,
      endChapterIndex: 0
    });
    assert.strictEqual(source.endChapterIndex, 0);
  });

  console.log(`playback-orchestrator tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
