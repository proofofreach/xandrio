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
      const firstIdentity = await firstQueue.renderedOutputIdentity({
        text: 'The same prepared narration.',
        outputPath: firstPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 350,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      assert.strictEqual(firstIdentity.provenance, 'verified');
      assert.match(firstIdentity.contentHash, /^sha256-[a-f0-9]{64}$/);
      assert.deepStrictEqual(
        JSON.parse(await fs.readFile(firstPath + '.narration-artifact.json', 'utf8')),
        {
          version: 2,
          fingerprint: firstIdentity.fingerprint,
          bytes: Buffer.byteLength('shared-audio'),
          contentHash: firstIdentity.contentHash,
          provenance: 'verified'
        }
      );

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

  await test('a corrupted v2 output and canonical artifact regenerate instead of downgrading', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-corrupt-'));
    try {
      const variant = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350';
      const outputPath = path.join(cacheDir, 'book_current_ch0_chunk0.mp3');
      const activity = { bookId: 'book', chapterIndex: 0, chunkIndex: 0 };
      const firstAdapter = kokoroAdapter(variant, async ({ outputPath: destination }) => {
        await fs.writeFile(destination, Buffer.from('trusted-audio'));
      });
      const firstQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: firstAdapter.registry
      });
      const params = {
        text: 'The same prepared narration.',
        outputPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 350,
        reuseExistingOutput: true,
        activity
      };
      const firstJob = await firstQueue.enqueue(params);
      await firstQueue.waitFor(firstJob);
      const fingerprint = firstQueue.renderedOutputFingerprint(params);
      const canonicalPath = path.join(
        cacheDir,
        'book_narration_artifacts_v1',
        'ch0',
        fingerprint + '.mp3'
      );
      const corruptBytes = Buffer.alloc(Buffer.byteLength('trusted-audio'), 120);
      await Promise.all([
        fs.writeFile(outputPath, corruptBytes),
        fs.writeFile(canonicalPath, corruptBytes)
      ]);

      let regenerations = 0;
      const secondAdapter = kokoroAdapter(variant, async ({ outputPath: destination }) => {
        regenerations += 1;
        await fs.writeFile(destination, Buffer.from('repaired-audio'));
      });
      const secondQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: secondAdapter.registry
      });
      const secondJob = await secondQueue.enqueue(params);
      await secondQueue.waitFor(secondJob);

      assert.strictEqual(regenerations, 1);
      assert.strictEqual((await fs.readFile(outputPath)).toString(), 'repaired-audio');
      assert.strictEqual(
        (await secondQueue.renderedOutputIdentity(params)).provenance,
        'verified'
      );
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('reconstruction marks corrupt v2 bytes pending after cache rejection deletes them', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-reconstruct-corrupt-'));
    try {
      const variant = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350';
      const adapter = kokoroAdapter(variant, async ({ outputPath }) => {
        await fs.writeFile(outputPath, Buffer.from('trusted-chunk'));
      });
      const queue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: adapter.registry
      });
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 420,
        variantKeyProvider: () => variant,
        voiceProvider: () => 'kokoro:am_onyx'
      });
      const text = 'This chapter text creates one verified narration chunk for reconstruction.';
      const generated = await tts.generateChapter('book', 0, text, 'en');
      await Promise.all(generated.chunks.map(chunk => queue.waitFor(chunk.jobId)));
      const outputPath = tts.chunkPath('book', 0, 0);
      const marker = JSON.parse(await fs.readFile(outputPath + '.narration-artifact.json', 'utf8'));
      const canonicalPath = path.join(
        cacheDir,
        'book_narration_artifacts_v1',
        'ch0',
        marker.fingerprint + '.mp3'
      );
      const corrupt = Buffer.alloc(Buffer.byteLength('trusted-chunk'), 121);
      await Promise.all([
        fs.writeFile(outputPath, corrupt),
        fs.writeFile(canonicalPath, corrupt)
      ]);

      const reconstructed = await tts.reconstructChapterManifest('book', 0, text, 'en');

      assert.strictEqual(reconstructed.chunks[0].status, 'pending');
      assert.strictEqual(reconstructed.chunks[0].path, null);
      await assert.rejects(fs.stat(outputPath), error => error.code === 'ENOENT');
      await assert.rejects(fs.stat(canonicalPath), error => error.code === 'ENOENT');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a v2 recipe mismatch regenerates an existing output path', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-artifact-recipe-'));
    try {
      const variant = 'kokoro:am_onyx:profilequality:chunk420:fmtwav:outmp3:prep10:audio7:br160k:pause350';
      const outputPath = path.join(cacheDir, 'book_current_ch0_chunk0.mp3');
      const activity = { bookId: 'book', chapterIndex: 0, chunkIndex: 0 };
      const adapter = kokoroAdapter(variant, async ({ outputPath: destination, padEndMs }) => {
        await fs.writeFile(destination, Buffer.from(padEndMs === 5000 ? 'new-recipe' : 'old-recipe'));
      });
      const firstQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: adapter.registry
      });
      const baseline = {
        text: 'The same prepared narration.',
        outputPath,
        voice: 'kokoro:am_onyx',
        padEndMs: 350,
        reuseExistingOutput: true,
        activity
      };
      const firstJob = await firstQueue.enqueue(baseline);
      await firstQueue.waitFor(firstJob);

      let regenerations = 0;
      const changedAdapter = kokoroAdapter(variant, async ({ outputPath: destination }) => {
        regenerations += 1;
        await fs.writeFile(destination, Buffer.from('new-recipe'));
      });
      const changedQueue = new TTSQueue({
        cacheDir,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: changedAdapter.registry
      });
      const changed = { ...baseline, padEndMs: 5000 };
      const changedJob = await changedQueue.enqueue(changed);
      await changedQueue.waitFor(changedJob);

      assert.strictEqual(regenerations, 1);
      assert.strictEqual((await fs.readFile(outputPath)).toString(), 'new-recipe');
      assert.strictEqual((await changedQueue.renderedOutputIdentity(changed)).provenance, 'verified');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('job cancellation aborts cache reuse before completion is published', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-cache-reuse-abort-'));
    try {
      let reuseCalls = 0;
      let reuseStarted;
      const started = new Promise(resolve => { reuseStarted = resolve; });
      let sawAbort = false;
      const artifactCache = {
        snapshot: () => ({}),
        resolve: async () => false,
        reuseExisting: async (_request, { signal } = {}) => {
          reuseCalls += 1;
          if (reuseCalls === 1) return false;
          reuseStarted();
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            }, { once: true });
          });
        },
        publishVerified: async () => true
      };
      const adapter = kokoroAdapter('kokoro:test:outmp3', async () => {
        throw new Error('generation must not start');
      });
      const queue = new TTSQueue({
        cacheDir,
        artifactCache,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: adapter.registry
      });
      const jobId = await queue.enqueue({
        text: 'The same prepared narration.',
        outputPath: path.join(cacheDir, 'book_ch0_chunk0.mp3'),
        voice: 'kokoro:am_onyx',
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await started;
      assert.strictEqual(queue.cancel(jobId), true);
      await assert.rejects(queue.waitFor(jobId), /cancelled/i);
      assert.strictEqual(sawAbort, true);
      assert.strictEqual(queue.getStatus(jobId), null);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('job cancellation aborts cache publication before queue completion', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-cache-publish-abort-'));
    try {
      let publishStarted;
      const started = new Promise(resolve => { publishStarted = resolve; });
      let sawAbort = false;
      const artifactCache = {
        snapshot: () => ({}),
        resolve: async () => false,
        reuseExisting: async () => false,
        publishVerified: async (_request, _identity, { signal } = {}) => {
          publishStarted();
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
              sawAbort = true;
              reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            }, { once: true });
          });
        }
      };
      const adapter = kokoroAdapter('kokoro:test:outmp3', async ({ outputPath }) => {
        await fs.writeFile(outputPath, 'generated');
      });
      const queue = new TTSQueue({
        cacheDir,
        artifactCache,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: adapter.registry
      });
      const outputPath = path.join(cacheDir, 'book_ch0_chunk0.mp3');
      const jobId = await queue.enqueue({
        text: 'The same prepared narration.',
        outputPath,
        voice: 'kokoro:am_onyx',
        reuseExistingOutput: true,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0 }
      });
      await started;
      assert.strictEqual(queue.cancel(jobId), true);
      await assert.rejects(queue.waitFor(jobId), /cancelled/i);
      assert.strictEqual(sawAbort, true);
      await assert.rejects(fs.stat(outputPath), error => error.code === 'ENOENT');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('concurrent enqueue joins the incumbent created during cache inspection', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-cache-enqueue-race-'));
    try {
      let entrants = 0;
      let bothEntered;
      let releaseInspections;
      const entered = new Promise(resolve => { bothEntered = resolve; });
      const release = new Promise(resolve => { releaseInspections = resolve; });
      const artifactCache = {
        snapshot: () => ({}),
        resolve: async () => false,
        reuseExisting: async () => {
          entrants += 1;
          if (entrants === 2) bothEntered();
          if (entrants <= 2) await release;
          return false;
        },
        publishVerified: async () => true
      };
      let generations = 0;
      const adapter = kokoroAdapter('kokoro:test:outmp3', async ({ outputPath }) => {
        generations += 1;
        await fs.writeFile(outputPath, 'generated');
      });
      const queue = new TTSQueue({
        cacheDir,
        artifactCache,
        defaultVoice: 'kokoro:am_onyx',
        engineAdapters: adapter.registry
      });
      const outputPath = path.join(cacheDir, 'book_ch0_chunk0.mp3');
      const base = {
        text: 'The same prepared narration.',
        outputPath,
        voice: 'kokoro:am_onyx',
        reuseExistingOutput: true
      };
      const first = queue.enqueue({
        ...base,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0, requestId: 'first' }
      });
      const second = queue.enqueue({
        ...base,
        activity: { bookId: 'book', chapterIndex: 0, chunkIndex: 0, requestId: 'second' }
      });
      await entered;
      releaseInspections();
      const [firstId, secondId] = await Promise.all([first, second]);

      assert.strictEqual(secondId, firstId);
      assert.strictEqual(queue.getActivityClaims(firstId).length, 2);
      await queue.waitFor(firstId);
      assert.strictEqual(generations, 1);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('an unproved reconstructed chunk stays local and does not seed another namespace', async () => {
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
      assert.strictEqual(newManifest.chunks[0].status, 'pending');
      assert.strictEqual(generated, 0);
      await assert.rejects(fs.stat(newTts.chunkPath('book', 0, 0)), error => error.code === 'ENOENT');
      assert.strictEqual(
        (await fs.readFile(oldTts.chunkPath('book', 0, 0))).toString(),
        'existing-onyx-audio',
        'legacy audio must remain usable in its original namespace'
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

  await test('concatenateChunks aborts and reaps ffmpeg before removing unique temporaries', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-concat-abort-'));
    try {
      let commandStarted;
      const started = new Promise(resolve => { commandStarted = resolve; });
      const signals = [];
      const execFile = (_command, _args, callback) => {
        const child = {
          exitCode: null,
          signalCode: null,
          kill(signal) {
            signals.push(signal);
            commandStarted();
            setImmediate(() => {
              child.exitCode = 1;
              child.signalCode = signal;
              callback(new Error('killed'), '', 'killed');
            });
            return true;
          }
        };
        commandStarted();
        return child;
      };
      const tts = new ChunkedTTS(cacheDir, null, {
        variantKeyProvider: () => 'edge:test:outmp3',
        outputFormatProvider: () => 'mp3',
        execFile
      });
      const chunks = [];
      for (let index = 0; index < 2; index += 1) {
        const chunkPath = tts.chunkPath('book', 0, index);
        await fs.writeFile(chunkPath, 'chunk-' + index);
        chunks.push({ index, status: 'ready', path: chunkPath });
      }
      tts.manifests.set(tts._manifestKey('book', 0), {
        bookId: 'book',
        chapterIndex: 0,
        totalChunks: chunks.length,
        chunks
      });
      const controller = new AbortController();
      const concatenating = tts.concatenateChunks('book', 0, {
        signal: controller.signal,
        timeoutMs: 1000
      });
      await started;
      controller.abort();

      await assert.rejects(concatenating, error => error.name === 'AbortError');
      assert.deepStrictEqual(signals, ['SIGTERM']);
      const names = await fs.readdir(cacheDir);
      assert.strictEqual(names.some(name => /(?:\.tmp|\.part\.mp3)$/.test(name)), false);
      await assert.rejects(fs.stat(tts.chapterPath('book', 0)), error => error.code === 'ENOENT');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  console.log(`narration-artifact-cache tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
