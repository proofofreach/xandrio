const assert = require('assert');
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
  const tts = {
    getChapterManifest: () => overrides.manifest === undefined ? null : overrides.manifest,
    generateChapter: async (...args) => { calls.push(['generate', ...args]); return manifest; },
    prioritizeChunk: (...args) => { calls.push(['prioritize', ...args]); return true; },
    reconstructChapterManifest: async (...args) => {
      calls.push(['reconstruct', ...args]);
      return overrides.reconstructed || manifest;
    },
    chunkPath: (...args) => `/cache/${args.join('-')}.mp3`
  };
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
  return { orchestrator, calls, manifest };
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

  console.log(`playback-orchestrator tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
