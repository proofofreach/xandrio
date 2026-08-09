const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const TTSQueue = require('../lib/tts-queue');
const ChunkedTTS = require('../lib/chunked-tts');
const { narrationRenderRecipe } = require('../lib/narration-render-recipe');

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

function kokoroAdapter(variantKey, onGenerate = async () => {}) {
  const adapter = {
    id: 'kokoro',
    usesGpu: false,
    variantKey: () => variantKey,
    generate: onGenerate
  };
  return {
    adapter,
    registry: { resolve: () => adapter }
  };
}

function recipe(adapter, overrides = {}) {
  return narrationRenderRecipe({
    adapter,
    text: 'The same prepared narration.',
    outputPath: '/tmp/chunk.mp3',
    language: 'en',
    voice: 'kokoro:am_onyx',
    padEndMs: 350,
    narration: { pauseIntent: 'paragraph', segments: [] },
    ...overrides
  });
}

(async () => {
  await test('prep and audio namespace bumps preserve an unchanged chunk fingerprint', async () => {
    const oldAdapter = kokoroAdapter(
      'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep8:audio6:br160k:pause350'
    ).adapter;
    const newAdapter = kokoroAdapter(
      'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350'
    ).adapter;
    assert.strictEqual(recipe(oldAdapter).fingerprint, recipe(newAdapter).fingerprint);
  });

  await test('prepared text and actual pause changes produce different fingerprints', async () => {
    const adapter = kokoroAdapter(
      'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350'
    ).adapter;
    const baseline = recipe(adapter).fingerprint;
    assert.notStrictEqual(
      recipe(adapter, { text: 'The materially changed prepared narration.' }).fingerprint,
      baseline
    );
    assert.notStrictEqual(recipe(adapter, { padEndMs: 5000 }).fingerprint, baseline);
  });

  await test('a new namespace reuses one shared artifact without another Kokoro call', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-cache-'));
    try {
      const firstPath = path.join(cacheDir, 'book_ttsold_ch0_chunk0.mp3');
      let firstGenerations = 0;
      const firstAdapter = kokoroAdapter(
        'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep8:audio6:br160k:pause350',
        async ({ outputPath }) => {
          firstGenerations++;
          await fs.writeFile(outputPath, Buffer.from('shared-audio'));
        }
      );
      const firstQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: firstAdapter.registry
      });
      const firstJob = await firstQueue.enqueue({
        text: 'The same prepared narration.',
        outputPath: firstPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 350,
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await firstQueue.waitFor(firstJob);
      assert.strictEqual(firstGenerations, 1);

      const secondPath = path.join(cacheDir, 'book_ttsnew_ch0_chunk0.mp3');
      let secondGenerations = 0;
      const secondAdapter = kokoroAdapter(
        'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350',
        async ({ outputPath }) => {
          secondGenerations++;
          await fs.writeFile(outputPath, Buffer.from('unexpected-regeneration'));
        }
      );
      const secondQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: secondAdapter.registry
      });
      const secondJob = await secondQueue.enqueue({
        text: 'The same prepared narration.',
        outputPath: secondPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 350,
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await secondQueue.waitFor(secondJob);
      assert.strictEqual(secondGenerations, 0);
      assert.strictEqual((await fs.readFile(secondPath)).toString(), 'shared-audio');
      assert.strictEqual(secondQueue.getQueueStatus().artifacts.hits, 1);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a changed final-chunk pause regenerates instead of reusing', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-pause-'));
    try {
      const adapter = kokoroAdapter(
        'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350',
        async ({ outputPath }) => fs.writeFile(outputPath, Buffer.from('new-pause'))
      );
      const queue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: adapter.registry
      });
      const oldPath = path.join(cacheDir, 'book_old_ch0_chunk0.mp3');
      await fs.writeFile(oldPath, Buffer.from('old-pause'));
      await queue.reuseRenderedOutput({
        text: 'The same prepared narration.',
        outputPath: oldPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 350,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });

      const newPath = path.join(cacheDir, 'book_new_ch0_chunk0.mp3');
      const job = await queue.enqueue({
        text: 'The same prepared narration.',
        outputPath: newPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 5000,
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await queue.waitFor(job);
      assert.strictEqual((await fs.readFile(newPath)).toString(), 'new-pause');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a reconstructed current manifest seeds the next namespace without generation', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-backfill-'));
    try {
      const oldVariant = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep8:audio6:br160k:pause350';
      const newVariant = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350';
      const oldAdapter = kokoroAdapter(oldVariant);
      const oldQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: oldAdapter.registry
      });
      const oldTts = new ChunkedTTS(cacheDir, oldQueue, {
        chunkSize: 420,
        variantKeyProvider: () => oldVariant,
        voiceProvider: () => 'kokoro:am_onyx'
      });
      const text = 'This existing Onyx narration is long enough to be a valid reusable audio chunk.';
      await fs.writeFile(oldTts.chunkPath('book', 0, 0), Buffer.from('existing-onyx-audio'));
      const oldManifest = await oldTts.reconstructChapterManifest('book', 0, text, 'en');
      assert.strictEqual(oldManifest.chunks[0].status, 'ready');

      let generated = 0;
      const newAdapter = kokoroAdapter(newVariant, async ({ outputPath }) => {
        generated++;
        await fs.writeFile(outputPath, Buffer.from('unexpected-regeneration'));
      });
      const newQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: newAdapter.registry
      });
      const newTts = new ChunkedTTS(cacheDir, newQueue, {
        chunkSize: 420,
        variantKeyProvider: () => newVariant,
        voiceProvider: () => 'kokoro:am_onyx'
      });
      const newManifest = await newTts.reconstructChapterManifest('book', 0, text, 'en');
      assert.strictEqual(newManifest.chunks[0].status, 'ready');
      assert.strictEqual(generated, 0);
      assert.strictEqual(
        (await fs.readFile(newTts.chunkPath('book', 0, 0))).toString(),
        'existing-onyx-audio'
      );
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('explicit repair evicts the reusable artifact instead of resurrecting it', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-invalidate-'));
    try {
      const variant = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350';
      const firstPath = path.join(cacheDir, 'book_first_ch0_chunk0.mp3');
      const firstAdapter = kokoroAdapter(variant, async ({ outputPath }) => {
        await fs.writeFile(outputPath, Buffer.from('suspect-audio'));
      });
      const firstQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: firstAdapter.registry
      });
      const firstJob = await firstQueue.enqueue({
        text: 'The same prepared narration.',
        outputPath: firstPath,
        voice: 'kokoro:am_onyx',
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await firstQueue.waitFor(firstJob);
      assert.strictEqual(await firstQueue.invalidateRenderedOutput({
        bookId: 'book', chapterIndex: 0, outputPath: firstPath
      }), true);
      await fs.unlink(firstPath);

      let regenerated = 0;
      const secondPath = path.join(cacheDir, 'book_second_ch0_chunk0.mp3');
      const secondAdapter = kokoroAdapter(variant, async ({ outputPath }) => {
        regenerated++;
        await fs.writeFile(outputPath, Buffer.from('repaired-audio'));
      });
      const secondQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: secondAdapter.registry
      });
      const secondJob = await secondQueue.enqueue({
        text: 'The same prepared narration.',
        outputPath: secondPath,
        voice: 'kokoro:am_onyx',
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await secondQueue.waitFor(secondJob);
      assert.strictEqual(regenerated, 1);
      assert.strictEqual((await fs.readFile(secondPath)).toString(), 'repaired-audio');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  console.log(`narration-artifact-cache tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
