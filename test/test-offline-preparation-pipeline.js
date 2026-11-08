const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const GenerationJournal = require('../lib/generation-journal');
const { createOfflinePreparationCoordinator } = require('../lib/offline-preparation-coordinator');
const { createOfflineAudioPackage } = require('../lib/offline-audio-package');
const { createAudioCacheBudget } = require('../lib/audio-cache-budget');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function eventually(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met before timeout');
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject);
  });
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function renderTone(outputPath, frequency, seconds) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '160k', outputPath
  ]);
  if (result.status !== 0) throw new Error(`fixture render failed: ${result.stderr}`);
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

async function tempJournal(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, journalPath: path.join(dir, 'generation-state.json') };
}

function chapterBook(count) {
  return async bookId => ({
    book: { id: bookId },
    chapters: Array.from({ length: count }, () => ({}))
  });
}

(async () => {
  await test('narration of the next chapter starts while the previous chapter is still packaging', async () => {
    const { dir, journalPath } = await tempJournal('offline-pipeline-overlap-');
    const journal = new GenerationJournal(journalPath);
    const packaged = new Set();
    const events = [];
    const encodeGates = [deferred(), deferred(), deferred()];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: chapterBook(3),
      chapterStatus: async ({ chapterIndex }) => ({
        ready: packaged.has(chapterIndex),
        size: packaged.has(chapterIndex) ? 100 : 0,
        totalChunks: 1,
        readyChunks: 1
      }),
      prepareChapter: async request => {
        events.push(`narrate:${request.chapterIndex}`);
        assert.strictEqual(request.priority, 'download');
        assert.strictEqual(request.origin, 'offline-download');
        return { handle: request.chapterIndex };
      },
      finalizeChapter: async (request, source) => {
        assert.strictEqual(source.handle, request.chapterIndex);
        events.push(`encode-start:${request.chapterIndex}`);
        await abortable(encodeGates[request.chapterIndex].promise, request.signal);
        packaged.add(request.chapterIndex);
        events.push(`encode-done:${request.chapterIndex}`);
      }
    });

    await coordinator.request('book');
    await eventually(() => events.includes('narrate:1') && events.includes('encode-start:0'));
    // Chapter 1 narrated before chapter 0's encode finished.
    assert(!events.includes('encode-done:0'));
    // One bounded encode worker: chapter 1 waits for chapter 0's slot.
    await eventually(() => events.includes('narrate:2'));
    assert(!events.includes('encode-start:1'));

    encodeGates[0].resolve();
    await eventually(() => events.includes('encode-start:1'));
    encodeGates[1].resolve();
    encodeGates[2].resolve();
    await coordinator.waitForIdle('book');
    const record = await journal.getOfflinePreparation('book');
    assert.strictEqual(record.state, 'ready');
    assert.strictEqual(record.readyChapters, 3);
    assert.strictEqual(record.nextChapter, 3);
    assert.strictEqual(record.preparedBytes, 300);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('packaging is bounded to one encode across titles', async () => {
    const { dir, journalPath } = await tempJournal('offline-pipeline-bound-');
    const journal = new GenerationJournal(journalPath);
    const packaged = new Set();
    let active = 0;
    let maximum = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 2,
      getBookChapters: chapterBook(2),
      chapterStatus: async ({ bookId, chapterIndex }) => ({
        ready: packaged.has(`${bookId}:${chapterIndex}`),
        size: 1
      }),
      prepareChapter: async () => ({}),
      finalizeChapter: async ({ bookId, chapterIndex }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        packaged.add(`${bookId}:${chapterIndex}`);
        active -= 1;
      }
    });
    await coordinator.request('book-a');
    await coordinator.request('book-b');
    await coordinator.waitForIdle('book-a');
    await coordinator.waitForIdle('book-b');
    assert.strictEqual(maximum, 1);
    assert.strictEqual((await journal.getOfflinePreparation('book-a')).state, 'ready');
    assert.strictEqual((await journal.getOfflinePreparation('book-b')).state, 'ready');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('the durable frontier never passes a chapter whose artifact is not published', async () => {
    const { dir, journalPath } = await tempJournal('offline-pipeline-frontier-');
    const journal = new GenerationJournal(journalPath);
    const published = new Set();
    const encodeGate = deferred();
    const narrated = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: chapterBook(3),
      chapterStatus: async ({ chapterIndex }) => ({ ready: published.has(chapterIndex), size: 10 }),
      prepareChapter: async ({ chapterIndex }) => {
        narrated.push(chapterIndex);
        return {};
      },
      finalizeChapter: async ({ chapterIndex, signal }) => {
        if (chapterIndex === 0) await abortable(encodeGate.promise, signal);
        published.add(chapterIndex);
      }
    });
    await coordinator.request('book');
    await eventually(() => narrated.length === 3);
    // Every chapter is narrated, but chapter 0 has not published its artifact.
    const waiting = await journal.getOfflinePreparation('book');
    assert.strictEqual(waiting.state, 'preparing');
    assert.strictEqual(waiting.nextChapter, 0);
    assert.strictEqual(waiting.readyChapters, 0);
    assert.strictEqual(waiting.preparedBytes, 0);
    assert.strictEqual((await coordinator.status('book')).readyChapters, 0);
    encodeGate.resolve();
    await coordinator.waitForIdle('book');
    const done = await journal.getOfflinePreparation('book');
    assert.strictEqual(done.state, 'ready');
    assert.strictEqual(done.preparedBytes, 30);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('a finalize call that returns without a published artifact is an error, not readiness', async () => {
    const { dir, journalPath } = await tempJournal('offline-pipeline-unpublished-');
    const journal = new GenerationJournal(journalPath);
    const published = new Set();
    const narrated = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: chapterBook(3),
      chapterStatus: async ({ chapterIndex }) => ({ ready: published.has(chapterIndex), size: 10 }),
      prepareChapter: async ({ chapterIndex, signal }) => {
        narrated.push(chapterIndex);
        // Narration that ran ahead is stopped once packaging fails.
        if (chapterIndex === 2) await abortable(new Promise(() => {}), signal);
        return {};
      },
      finalizeChapter: async ({ chapterIndex }) => {
        if (chapterIndex !== 1) published.add(chapterIndex);
      },
      onError: () => {}
    });
    await coordinator.request('book');
    await coordinator.waitForIdle('book');
    const record = await journal.getOfflinePreparation('book');
    assert.strictEqual(record.state, 'error');
    assert.strictEqual(record.nextChapter, 1);
    assert.strictEqual(record.readyChapters, 1);
    assert.match(record.lastError, /not ready for chapter 2/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('a narration failure still commits earlier packaged chapters in order', async () => {
    const { dir, journalPath } = await tempJournal('offline-pipeline-narration-error-');
    const journal = new GenerationJournal(journalPath);
    const published = new Set();
    const encodeGate = deferred();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: chapterBook(3),
      chapterStatus: async ({ chapterIndex }) => ({ ready: published.has(chapterIndex), size: 10 }),
      prepareChapter: async ({ chapterIndex }) => {
        if (chapterIndex === 1) {
          setTimeout(() => encodeGate.resolve(), 20);
          throw new Error('TTS engine failed');
        }
        return {};
      },
      finalizeChapter: async ({ chapterIndex }) => {
        await encodeGate.promise;
        published.add(chapterIndex);
      },
      onError: () => {}
    });
    await coordinator.request('book');
    await coordinator.waitForIdle('book');
    const record = await journal.getOfflinePreparation('book');
    assert.strictEqual(record.state, 'error');
    assert.strictEqual(record.nextChapter, 1);
    assert.strictEqual(record.readyChapters, 1);
    assert.strictEqual(record.preparedBytes, 10);
    assert.strictEqual(record.lastError, 'TTS engine failed');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('pausing during an encode aborts it, persists paused, and resume redoes that chapter', async () => {
    const { dir, journalPath } = await tempJournal('offline-pipeline-pause-');
    const journal = new GenerationJournal(journalPath);
    const published = new Set();
    const finalizeCalls = [];
    let holdChapterOne = true;
    let abortedEncode = false;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: chapterBook(3),
      chapterStatus: async ({ chapterIndex }) => ({ ready: published.has(chapterIndex), size: 5 }),
      prepareChapter: async () => ({}),
      finalizeChapter: async ({ chapterIndex, signal }) => {
        finalizeCalls.push(chapterIndex);
        if (chapterIndex === 1 && holdChapterOne) {
          try {
            await abortable(new Promise(() => {}), signal);
          } catch (error) {
            abortedEncode = true;
            throw error;
          }
        }
        published.add(chapterIndex);
      }
    });
    await coordinator.request('book');
    await eventually(() => finalizeCalls.includes(1));
    assert.strictEqual((await coordinator.cancel('book')).state, 'paused');
    await coordinator.waitForIdle('book');
    assert.strictEqual(abortedEncode, true);
    const paused = await journal.getOfflinePreparation('book');
    assert.strictEqual(paused.state, 'paused');
    assert.strictEqual(paused.nextChapter, 1);
    assert.strictEqual(paused.readyChapters, 1);
    assert(!published.has(1));

    holdChapterOne = false;
    finalizeCalls.length = 0;
    await coordinator.request('book');
    await coordinator.waitForIdle('book');
    assert.deepStrictEqual(finalizeCalls, [1, 2]);
    const record = await journal.getOfflinePreparation('book');
    assert.strictEqual(record.state, 'ready');
    assert.strictEqual(record.preparedBytes, 15);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('a process crash mid-encode leaves no ready artifact and restart redoes the chapter (real ffmpeg)', async () => {
    if (!hasFfmpeg) {
      console.log('    skipped: ffmpeg and ffprobe are unavailable');
      return;
    }
    const { dir, journalPath } = await tempJournal('offline-pipeline-crash-');
    const chunkPaths = [0, 1].map(chapterIndex => [0, 1].map(chunkIndex => {
      const chunkPath = path.join(dir, `book_ch${chapterIndex}_chunk${chunkIndex}.mp3`);
      renderTone(chunkPath, 300 + (chapterIndex * 200) + (chunkIndex * 100), 0.6);
      return chunkPath;
    }));
    const sourceVariantKey = 'fixture-voice';
    const fingerprint = chapterIndex => `sha256-${String(chapterIndex + 1).repeat(64)}`;
    const ensureRequest = (audioPackage, request) => audioPackage.ensureChapter({
      bookId: 'book',
      chapterIndex: request.chapterIndex,
      sourcePaths: chunkPaths[request.chapterIndex],
      sourceVariantKey,
      sourceFingerprint: fingerprint(request.chapterIndex),
      provenance: 'verified',
      signal: request.signal
    });
    const inspect = (audioPackage, chapterIndex) => audioPackage.inspectChapter({
      bookId: 'book',
      chapterIndex,
      sourceVariantKey,
      sourceFingerprint: fingerprint(chapterIndex)
    });

    // First process: the chapter 1 encode writes partial output and then the
    // process "dies". Its worker never settles and never touches state again.
    const encodeStarted = deferred();
    const crashedPackage = createOfflineAudioPackage({
      cacheDir: dir,
      maxConcurrentJobs: 1,
      spawn: (command, args, options) => {
        const output = args.at(-1);
        if (command === 'ffmpeg' && args.includes('concat') && output.includes('_ch1.mp3.')) {
          // Write partial bytes, then hang like a killed process.
          require('fs').writeFileSync(output, Buffer.alloc(512, 1));
          encodeStarted.resolve(output);
          return spawn('sleep', ['30'], options);
        }
        return spawn(command, args, options);
      }
    });
    const firstJournal = new GenerationJournal(journalPath);
    const crashController = new AbortController();
    const first = createOfflinePreparationCoordinator({
      stateStore: firstJournal,
      getBookChapters: chapterBook(2),
      chapterStatus: async ({ chapterIndex }) => inspect(crashedPackage, chapterIndex),
      prepareChapter: async () => ({}),
      finalizeChapter: request => ensureRequest(crashedPackage, {
        ...request,
        signal: AbortSignal.any([request.signal, crashController.signal])
      })
    });
    await first.request('book');
    const partialPath = await encodeStarted.promise;
    await eventually(async () => (await firstJournal.getOfflinePreparation('book'))?.readyChapters === 1);

    // The partial output exists, but nothing names it as a ready artifact.
    assert((await fs.stat(partialPath)).size > 0);
    const freshPackage = createOfflineAudioPackage({ cacheDir: dir, maxConcurrentJobs: 1 });
    assert.strictEqual((await inspect(freshPackage, 0)).ready, true);
    assert.strictEqual((await inspect(freshPackage, 1)).ready, false);
    const crashedRecord = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    assert(JSON.stringify(crashedRecord).includes('"nextChapter":1'));

    // Second process: restore from the same durable journal.
    const secondJournal = new GenerationJournal(journalPath);
    const finalized = [];
    const second = createOfflinePreparationCoordinator({
      stateStore: secondJournal,
      getBookChapters: chapterBook(2),
      chapterStatus: async ({ chapterIndex }) => inspect(freshPackage, chapterIndex),
      prepareChapter: async () => ({}),
      finalizeChapter: request => {
        finalized.push(request.chapterIndex);
        return ensureRequest(freshPackage, request);
      }
    });
    const restored = await second.restore();
    assert.strictEqual(restored.resumedBooks, 1);
    await second.waitForIdle('book');
    assert.deepStrictEqual(finalized, [1]);
    const record = await secondJournal.getOfflinePreparation('book');
    assert.strictEqual(record.state, 'ready');
    const chapterOne = await inspect(freshPackage, 1);
    assert.strictEqual(chapterOne.ready, true);
    const chapterZero = await inspect(freshPackage, 0);
    assert.strictEqual(record.preparedBytes, chapterOne.size + chapterZero.size);

    crashController.abort();
    await first.waitForIdle('book').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Chunks reused from an earlier session are older than the recency window
  // and have no loaded manifest. Only the coordinator's hold protects them
  // while they wait for the single encode worker.
  async function evictionFixture(prefix, chapterCount) {
    const { dir, journalPath } = await tempJournal(prefix);
    const cacheDir = path.join(dir, 'cache');
    await fs.mkdir(cacheDir);
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const writeOld = async name => {
      const filePath = path.join(cacheDir, name);
      await fs.writeFile(filePath, Buffer.alloc(1000, 1));
      await fs.utimes(filePath, old, old);
    };
    for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex += 1) {
      await writeOld(`book_ch${chapterIndex}_chunk0.mp3`);
      await writeOld(`book_ch${chapterIndex}_chunk1.mp3`);
    }
    await writeOld('other_ch0_chunk0.mp3');
    // Free space stays below the floor, so every sweep evicts all it may.
    const real = fs;
    const budget = createAudioCacheBudget({
      cacheDir,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      log: { log() {}, warn() {} },
      fsp: {
        readdir: real.readdir,
        lstat: real.lstat,
        unlink: real.unlink,
        rm: real.rm,
        async statfs() { return { blocks: 1e6, bsize: 4096, bavail: 0 }; }
      }
    });
    const chunksOf = async chapterIndex => (await fs.readdir(cacheDir))
      .filter(name => name.startsWith(`book_ch${chapterIndex}_chunk`)).length;
    return { dir, journalPath, cacheDir, budget, chunksOf };
  }

  await test('a sweep while chapters wait to be packaged keeps their chunks, and finalize releases them', async () => {
    const fixture = await evictionFixture('offline-pipeline-evict-', 3);
    const journal = new GenerationJournal(fixture.journalPath);
    const published = new Set();
    const gates = [deferred(), deferred(), deferred()];
    const narrated = [];
    const finalizing = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: chapterBook(3),
      chapterStatus: async ({ chapterIndex }) => ({ ready: published.has(chapterIndex), size: 1 }),
      retainChapter: ({ bookId, chapterIndex }) => fixture.budget.retain(bookId, chapterIndex),
      prepareChapter: async ({ chapterIndex }) => {
        narrated.push(chapterIndex);
        return {};
      },
      finalizeChapter: async ({ chapterIndex, signal }) => {
        finalizing.push(chapterIndex);
        // The encode reads chunks that must still exist.
        assert.strictEqual(await fixture.chunksOf(chapterIndex), 2);
        await abortable(gates[chapterIndex].promise, signal);
        published.add(chapterIndex);
      }
    });
    await coordinator.request('book');
    await eventually(() => narrated.length === 3 && finalizing.includes(0));
    const sweep = await fixture.budget.sweep();
    assert.strictEqual(sweep.evictedChapters, 1, 'only the unrelated stale chapter is evicted');
    for (const chapterIndex of [0, 1, 2]) assert.strictEqual(await fixture.chunksOf(chapterIndex), 2);

    gates[0].resolve();
    await eventually(() => finalizing.includes(1));
    await fixture.budget.sweep();
    assert.strictEqual(await fixture.chunksOf(0), 0, 'a packaged chapter releases its hold');
    assert.strictEqual(await fixture.chunksOf(1), 2);
    assert.strictEqual(await fixture.chunksOf(2), 2);
    gates[1].resolve();
    gates[2].resolve();
    await coordinator.waitForIdle('book');
    assert.strictEqual((await journal.getOfflinePreparation('book')).state, 'ready');
    await fixture.budget.sweep();
    for (const chapterIndex of [1, 2]) assert.strictEqual(await fixture.chunksOf(chapterIndex), 0);
    await fs.rm(fixture.dir, { recursive: true, force: true });
  });

  await test('cancel and failure release every chapter hold, including queued ones', async () => {
    for (const outcome of ['cancel', 'failure']) {
      const fixture = await evictionFixture(`offline-pipeline-release-${outcome}-`, 4);
      const journal = new GenerationJournal(fixture.journalPath);
      const gate = deferred();
      const narrated = [];
      let narrationThree = null;
      const coordinator = createOfflinePreparationCoordinator({
        stateStore: journal,
        getBookChapters: chapterBook(4),
        chapterStatus: async () => ({ ready: false }),
        retainChapter: ({ bookId, chapterIndex }) => fixture.budget.retain(bookId, chapterIndex),
        prepareChapter: async ({ chapterIndex, signal }) => {
          narrated.push(chapterIndex);
          // Chapter 3 is mid-narration when the run ends; its hold is released too.
          if (chapterIndex === 3) {
            narrationThree = abortable(new Promise(() => {}), signal);
            await narrationThree;
          }
          return {};
        },
        finalizeChapter: async ({ chapterIndex, signal }) => {
          await abortable(gate.promise, signal);
          if (outcome === 'failure' && chapterIndex === 0) throw new Error('encoder crashed');
        },
        onError: () => {}
      });
      await coordinator.request('book');
      await eventually(() => narrated.includes(3));
      await fixture.budget.sweep();
      for (const chapterIndex of [0, 1, 2, 3]) assert.strictEqual(await fixture.chunksOf(chapterIndex), 2);
      if (outcome === 'cancel') await coordinator.cancel('book');
      else gate.resolve();
      await coordinator.waitForIdle('book');
      const record = await journal.getOfflinePreparation('book');
      assert.strictEqual(record.state, outcome === 'cancel' ? 'paused' : 'error', outcome);
      assert.strictEqual(record.nextChapter, 0, outcome);
      await fixture.budget.sweep();
      for (const chapterIndex of [0, 1, 2, 3]) {
        assert.strictEqual(await fixture.chunksOf(chapterIndex), 0, `${outcome} released chapter ${chapterIndex}`);
      }
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  for (const mode of ['narrate', 'package']) {
    await test(`every coordinator invariant holds with the two-phase pipeline (${mode} mode)`, async () => {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'test-offline-preparation-coordinator.js')], {
        env: { ...process.env, XANDRIO_OFFLINE_PREP_PIPELINE: mode },
        encoding: 'utf8'
      });
      assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /\n\d+ passed, 0 failed/);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
