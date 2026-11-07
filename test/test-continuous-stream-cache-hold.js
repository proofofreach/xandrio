// Continuous and HLS streams name only their start chapter in the request
// path, so the per-request use stamp covers that chapter alone. A later
// chapter the stream is playing from an old cached file must stay out of the
// disk-pressure sweep, and must count as used once played, so a seek back
// into it does not regenerate it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAudioCacheBudget } = require('../lib/audio-cache-budget');
const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 1);
const quiet = { log() {}, warn() {} };

// Free space stays below the floor, so every unprotected chapter is evicted.
function fakeFs() {
  const real = fs.promises;
  return {
    readdir: real.readdir,
    lstat: real.lstat,
    async statfs() { return { blocks: (100 * GIB) / 4096, bsize: 4096, bavail: 1 }; },
    unlink: real.unlink,
    rm: real.rm
  };
}

function fixture(chapterCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-stream-hold-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
  const old = new Date(NOW - 60 * 24 * HOUR_MS);
  for (let index = 0; index < chapterCount; index++) {
    const file = path.join(cacheDir, `book_ch${index}.mp3`);
    fs.writeFileSync(file, Buffer.alloc(1024, 1));
    fs.utimesSync(file, old, old);
  }
  return { root, cacheDir, exists: index => fs.existsSync(path.join(cacheDir, `book_ch${index}.mp3`)) };
}

function orchestratorFor(budget, cacheDir, chapterCount) {
  // No worker holds a manifest: every chapter is served from its stitched file.
  const tts = Object.assign(new EventEmitter(), {
    getChapterManifest: () => null,
    chapterPath: (bookId, chapterIndex) => path.join(cacheDir, `${bookId}_ch${chapterIndex}.mp3`),
    chunkPath: (bookId, chapterIndex, chunkIndex) => path.join(cacheDir, `${bookId}_ch${chapterIndex}_chunk${chunkIndex}.mp3`),
    currentOutputFormat: () => 'mp3'
  });
  const chapters = Array.from({ length: chapterCount }, (_v, index) => ({
    text: `Chapter ${index} narration text is long enough for testing.`
  }));
  return createPlaybackOrchestrator({
    isPremiumVoiceActive: () => false,
    premiumChapterReady: async () => false,
    kickPremiumPrep: () => {},
    startProviderForVoice: () => {},
    activeInstantVoice: () => null,
    ttsForTier: () => tts,
    voiceForTier: () => 'kokoro:test',
    manifestNeedsResume: () => false,
    generationPriority: () => () => 'immediate',
    waitForJob: async () => {},
    ensureChapterAudio: async () => null,
    inspectChapterAudio: async () => ({ ready: true, variantKey: 'variant' }),
    getChapterContext: async (_bookId, chapterIndex) => ({
      book: { language: 'en' }, chapter: chapters[chapterIndex], chapters
    }),
    holdChapterAudio: (bookId, chapterIndex) => budget.holdForPlayback(bookId, chapterIndex)
  });
}

(async () => {
  console.log('\nContinuous stream cache hold');

  await test('a chapter a continuous stream is playing survives a sweep and counts as used afterwards', async () => {
    const { root, cacheDir, exists } = fixture(3);
    try {
      let clock = NOW;
      const budget = createAudioCacheBudget({ cacheDir, fsp: fakeFs(), now: () => clock, minFreeBytes: 1, log: quiet });
      const orchestrator = orchestratorFor(budget, cacheDir, 3);
      // The route middleware stamps the start chapter only.
      budget.recordUse('book', 0);
      const source = await orchestrator.prepareContinuousAudioStream({ bookId: 'book', chapterIndex: 0, sessionId: 's1' });
      const inputs = source.iterateInputs();
      assert.equal((await inputs.next()).value.chapterIndex, 0);
      assert.equal((await inputs.next()).value.chapterIndex, 1);
      // Chapter 1 is now being decoded. Even past the recency window it stays.
      clock += 49 * HOUR_MS;
      await budget.sweep();
      assert.ok(exists(1), 'the chapter being played is not evicted');
      assert.equal((await inputs.next()).value.chapterIndex, 2);
      assert.equal((await inputs.next()).done, true);
      // After playback a seek back into chapter 1 must find its audio.
      await budget.sweep();
      assert.ok(exists(1), 'a chapter played by the stream counts as recently used');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('an aborted stream releases its hold even if the iterator is never resumed', async () => {
    const { root, cacheDir, exists } = fixture(2);
    try {
      let clock = NOW;
      const budget = createAudioCacheBudget({ cacheDir, fsp: fakeFs(), now: () => clock, minFreeBytes: 1, log: quiet });
      const orchestrator = orchestratorFor(budget, cacheDir, 2);
      const source = await orchestrator.prepareContinuousAudioStream({ bookId: 'book', chapterIndex: 0, sessionId: 's2' });
      const controller = new AbortController();
      const inputs = source.iterateInputs(controller.signal);
      assert.equal((await inputs.next()).value.chapterIndex, 0);
      controller.abort();
      clock += 49 * HOUR_MS;
      await budget.sweep();
      assert.ok(!exists(0), 'an abandoned stream does not pin its chapter forever');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
