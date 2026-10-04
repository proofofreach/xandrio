'use strict';

// Failure modes recorded before implementation:
// 1. Cancelling a book while its manifest is reading disk can install a new
//    manifest after cancellation and return success to the HTTP caller.
// 2. A callback from a cancelled job can mark a replacement manifest ready
//    when the same book/chapter key is reused.
// 3. Releasing a foreground owner can lower the queue job while leaving its
//    scarce-resource admission promoted, starving genuine foreground work.
// 4. A durable claim promoted in place can become impossible to remove with
//    the owner's original claim record.
// 5. A provider failure must remain retryable across restart; completed audio
//    must then recover from disk without another provider call.
// 6. Pausing one owner must retain a shared job; pausing the final owner must
//    cancel it, and a later resume must create useful work again.
// 7. A cancelled manifest build finishing after resume must not overwrite or
//    remove the replacement manifest while its new provider job is running.
// 8. A cancelled build paused in a cache hash read must not delete replacement
//    audio or overwrite its hash after a resumed build uses different text.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ChunkedTTS = require('../lib/chunked-tts');
const GenerationJournal = require('../lib/generation-journal');
const GenerationScheduler = require('../lib/generation-scheduler');
const TTSQueue = require('../lib/tts-queue');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output/deep-reliability/scheduler');
const phase = String(process.env.SCHEDULER_RECOVERY_PHASE || `verification-${Date.now()}`)
  .replace(/[^a-zA-Z0-9._-]/g, '-');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function until(check, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function fixtureAdapters(generate) {
  return {
    resolve() {
      return {
        id: 'fixture',
        minimumTextLength: 1,
        usesGpu: true,
        schedulingResource: 'fixture-gpu',
        synthesisInput(text, language, voice) {
          return { text, language, voice, sourceFormat: 'wav' };
        },
        generate
      };
    }
  };
}

function makeQueue(cacheDir, generate, options = {}) {
  return new TTSQueue({
    cacheDir,
    maxConcurrent: 1,
    defaultVoice: 'fixture:voice',
    engineAdapters: fixtureAdapters(generate),
    ...options
  });
}

function makeTts(cacheDir, queue, journal, options = {}) {
  return new ChunkedTTS(cacheDir, queue, {
    chunkSize: 1000,
    maxMaterializedChunks: 2,
    reconcileIntervalMs: 0,
    variantKeyProvider: () => 'fixture:voice:recovery-v1',
    outputFormatProvider: () => 'wav',
    voiceProvider: () => 'fixture:voice',
    generationJournal: journal,
    ...options
  });
}

function audioBytes(text) {
  return Buffer.from(`fixture-audio:${text}`);
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexandrio-scheduler-recovery-'));
  const results = [];
  const check = async (name, work) => {
    const startedAt = Date.now();
    try {
      const evidence = await work();
      results.push({ name, passed: true, elapsedMs: Date.now() - startedAt, evidence });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({
        name,
        passed: false,
        elapsedMs: Date.now() - startedAt,
        error: error.stack || error.message
      });
      console.error(`FAIL ${name}: ${error.message}`);
    }
  };

  try {
    await check('HTTP cancellation during manifest creation leaves no replacement manifest', async () => {
      const cacheDir = path.join(tempDir, 'cancel-cache');
      await fs.mkdir(cacheDir);
      const journal = new GenerationJournal(path.join(tempDir, 'cancel-journal.json'));
      const queue = makeQueue(cacheDir, async ({ text, outputPath }) => {
        await fs.writeFile(outputPath, audioBytes(text));
      });
      const tts = makeTts(cacheDir, queue, journal);
      const manifestRead = deferred();
      const releaseManifestRead = deferred();
      const originalReuse = queue.reuseRenderedOutput.bind(queue);
      queue.reuseRenderedOutput = async params => {
        if (params?.activity?.bookId === 'cancel-race') {
          manifestRead.resolve();
          await releaseManifestRead.promise;
        }
        return originalReuse(params);
      };
      const text = 'Cancellation must win while the manifest is still resolving cached audio.';
      const server = http.createServer(async (req, res) => {
        try {
          if (req.method === 'POST' && req.url === '/generate/cancel-race') {
            await tts.generateChapter('cancel-race', 0, text, 'en', 'background', {
              voice: 'fixture:voice', origin: 'offline-download', requestId: 'cancel-request'
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ cancelled: false }));
            return;
          }
          if (req.method === 'DELETE' && req.url === '/books/cancel-race') {
            tts.cancelBook('cancel-race');
            await tts.waitForIdle('cancel-race');
            res.writeHead(204).end();
            return;
          }
          res.writeHead(404).end();
        } catch (error) {
          res.writeHead(error?.name === 'AbortError' ? 409 : 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ cancelled: error?.name === 'AbortError', error: error.message }));
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const generation = fetch(`${base}/generate/cancel-race`, { method: 'POST' });
        await manifestRead.promise;
        const cancellation = await fetch(`${base}/books/cancel-race`, { method: 'DELETE' });
        assert.equal(cancellation.status, 204);
        releaseManifestRead.resolve();
        const response = await generation;
        const body = await response.json();
        await until(async () => (await journal.listChapters()).length === 0, 'cancelled journal cleanup');
        assert.equal(body.cancelled, true, JSON.stringify(body));
        assert.equal(tts.getChapterManifest('cancel-race', 0), null);
        return { responseStatus: response.status, body, durableEntries: 0 };
      } finally {
        releaseManifestRead.resolve();
        tts.cancelBook('cancel-race');
        tts.stopReconcileLoop();
        await closeServer(server);
      }
    });

    await check('cancelled manifest creation cannot remove a resumed generation', async () => {
      const cacheDir = path.join(tempDir, 'resume-overlap-cache');
      await fs.mkdir(cacheDir);
      const journal = new GenerationJournal(path.join(tempDir, 'resume-overlap-journal.json'));
      const oldRead = deferred();
      const releaseOldRead = deferred();
      const providerGate = deferred();
      const queue = makeQueue(cacheDir, async ({ text, outputPath }) => {
        await providerGate.promise;
        await fs.writeFile(outputPath, audioBytes(text));
      });
      const tts = makeTts(cacheDir, queue, journal);
      const reuse = queue.reuseRenderedOutput.bind(queue);
      let intercepted = false;
      queue.reuseRenderedOutput = async params => {
        if (!intercepted) {
          intercepted = true;
          oldRead.resolve();
          await releaseOldRead.promise;
        }
        return reuse(params);
      };
      const text = 'The same narration is requested again after cancellation.';
      try {
        const oldGeneration = tts.generateChapter('resume-overlap', 0, text, 'en', 'background', {
          voice: 'fixture:voice', origin: 'offline-download', requestId: 'old-owner'
        }).then(() => 'success', error => error.name);
        await oldRead.promise;
        tts.cancelBook('resume-overlap');
        await tts.waitForIdle('resume-overlap');
        const resumed = tts.generateChapter('resume-overlap', 0, text, 'en', 'background', {
          voice: 'fixture:voice', origin: 'offline-download', requestId: 'new-owner'
        });
        // Let an unsafe overlapping build finish; a serialized build may wait
        // for the retired disk operation to settle before it can proceed.
        await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, 100))]);
        releaseOldRead.resolve();
        const oldResult = await oldGeneration;
        const replacement = await resumed;
        const newJobId = replacement.chunks[0].jobId;
        assert.equal(oldResult, 'AbortError');
        assert.equal(tts.getChapterManifest('resume-overlap', 0), replacement,
          'retired manifest build removed the live replacement');
        providerGate.resolve();
        await tts.waitForChapter('resume-overlap', 0);
        assert(replacement.chunks.every(chunk => chunk.status === 'ready'));
        await until(async () => (await journal.listChapters()).length === 0, 'resumed journal cleanup');
        return { oldResult, newJobId, replacementRetained: true, replacementStatus: replacement.chunks[0].status };
      } finally {
        releaseOldRead.resolve();
        providerGate.resolve();
        tts.cancelBook('resume-overlap');
        tts.stopReconcileLoop();
      }
    });

    for (const checkpoint of ['hash-read', 'cache-reuse']) {
      await check(`cancelled ${checkpoint} cannot delete resumed audio or its hash`, async () => {
        const cacheDir = path.join(tempDir, `disk-overlap-${checkpoint}-cache`);
        await fs.mkdir(cacheDir);
        const journal = new GenerationJournal(path.join(tempDir, `disk-overlap-${checkpoint}-journal.json`));
        const queue = makeQueue(cacheDir, async ({ text, outputPath }) => {
          await fs.writeFile(outputPath, audioBytes(text));
        });
        const tts = makeTts(cacheDir, queue, journal);
        const hashPath = tts._chapterHashPath('disk-overlap', 0);
        await fs.writeFile(hashPath, 'previous-text-hash');
        const oldRead = deferred();
        const releaseOldRead = deferred();
        const originalReadFile = fs.readFile;
        const originalReuse = queue.reuseRenderedOutput.bind(queue);
        let intercepted = false;
        fs.readFile = async function (file, ...args) {
          const result = await originalReadFile.call(this, file, ...args);
          if (checkpoint === 'hash-read' && file === hashPath && !intercepted) {
            intercepted = true;
            oldRead.resolve();
            await releaseOldRead.promise;
          }
          return result;
        };
        queue.reuseRenderedOutput = async params => {
          if (checkpoint === 'cache-reuse' && !intercepted) {
            intercepted = true;
            oldRead.resolve();
            await releaseOldRead.promise;
          }
          return originalReuse(params);
        };
        try {
          const oldGeneration = tts.generateChapter('disk-overlap', 0,
            'The cancelled build has obsolete narration text.', 'en', 'background', {
              voice: 'fixture:voice', origin: 'offline-download', requestId: 'old-disk-owner'
            }).then(() => 'success', error => error.name);
          await oldRead.promise;
          tts.cancelBook('disk-overlap');
          await tts.waitForIdle('disk-overlap');
          const text = 'The resumed build has corrected narration text.';
          const resumed = (async () => {
            const manifest = await tts.generateChapter('disk-overlap', 0, text, 'en', 'background', {
              voice: 'fixture:voice', origin: 'offline-download', requestId: 'new-disk-owner'
            });
            await tts.waitForChapter('disk-overlap', 0);
            return manifest;
          })();
          await Promise.race([resumed, new Promise(resolve => setTimeout(resolve, 100))]);
          // A blocked chapter must not hold up another chapter's cache build.
          await tts.generateChapter('disk-overlap', 1, 'An unrelated chapter still makes progress.', 'en', 'background', {
            voice: 'fixture:voice', origin: 'offline-download', requestId: 'unrelated-disk-owner'
          });
          await tts.waitForChapter('disk-overlap', 1);
          releaseOldRead.resolve();
          const oldResult = await oldGeneration;
          const replacement = await resumed;
          const audioPath = replacement.chunks[0].path;
          const expectedHash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
          assert.equal(oldResult, 'AbortError');
          assert.equal(tts.getChapterManifest('disk-overlap', 0), replacement);
          assert.deepEqual(await fs.readFile(audioPath), audioBytes(text),
            'retired build deleted or changed replacement audio');
          assert.equal(await fs.readFile(hashPath, 'utf8'), expectedHash,
            'retired build overwrote replacement text hash');
          return { checkpoint, oldResult, replacementStatus: replacement.chunks[0].status,
            audioPreserved: true, hashPreserved: true, unrelatedChapterReady: true };
        } finally {
          fs.readFile = originalReadFile;
          releaseOldRead.resolve();
          tts.cancelBook('disk-overlap');
          tts.stopReconcileLoop();
        }
      });
    }

    await check('stale callbacks cannot mutate a replacement manifest', async () => {
      const cacheDir = path.join(tempDir, 'stale-cache');
      await fs.mkdir(cacheDir);
      const journal = new GenerationJournal(path.join(tempDir, 'stale-journal.json'));
      const providerGates = [];
      const queue = makeQueue(cacheDir, async ({ text, outputPath, signal }) => {
        const gate = deferred();
        providerGates.push({ gate, outputPath });
        await new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('fixture cancelled'), { name: 'AbortError' }));
          signal.addEventListener('abort', abort, { once: true });
          gate.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
          if (signal.aborted) abort();
        });
        await fs.writeFile(outputPath, audioBytes(text));
      });
      const tts = makeTts(cacheDir, queue, journal);
      try {
        const first = await tts.generateChapter('stale-book', 0, 'The first generation must never complete the replacement.', 'en', 'background', {
          voice: 'fixture:voice', origin: 'offline-download', requestId: 'old-request'
        });
        const oldJobId = first.chunks[0].jobId;
        const oldPath = tts.chunkPath('stale-book', 0, 0);
        await until(() => queue.getStatus(oldJobId)?.status === 'generating', 'old provider start');
        tts.cancelBook('stale-book');
        await until(() => queue.getStatus(oldJobId) === null, 'old provider cancellation');

        const replacement = await tts.generateChapter('stale-book', 0, 'The replacement generation has different narration text.', 'en', 'background', {
          voice: 'fixture:voice', origin: 'offline-download', requestId: 'new-request'
        });
        const newJobId = replacement.chunks[0].jobId;
        await until(() => queue.getStatus(newJobId)?.status === 'generating', 'replacement provider start');
        queue.emit('complete', { jobId: oldJobId, outputPath: oldPath });
        assert.notEqual(replacement.chunks[0].status, 'ready');
        assert.equal(replacement.chunks[0].jobId, newJobId);
        return { oldJobId, newJobId, replacementStatus: replacement.chunks[0].status };
      } finally {
        tts.cancelBook('stale-book');
        for (const { gate } of providerGates) gate.resolve();
        tts.stopReconcileLoop();
      }
    });

    await check('released foreground claims lose scarce-resource priority', async () => {
      const cacheDir = path.join(tempDir, 'priority-cache');
      await fs.mkdir(cacheDir);
      const scheduler = new GenerationScheduler({ capacities: { 'fixture-gpu': 1 } });
      const blocker = deferred();
      const active = scheduler.run({ resource: 'fixture-gpu', priority: 'background' }, () => blocker.promise);
      const starts = [];
      const generate = async ({ text, outputPath }) => {
        starts.push(text);
        await fs.writeFile(outputPath, audioBytes(text));
      };
      const firstQueue = makeQueue(cacheDir, generate, { generationScheduler: scheduler });
      const secondQueue = makeQueue(cacheDir, generate, { generationScheduler: scheduler });
      const sharedId = await firstQueue.enqueue({
        text: 'released-background', outputPath: path.join(cacheDir, 'released.wav'),
        voice: 'fixture:voice', priority: 'background',
        activity: { bookId: 'shared', chapterIndex: 0, variantKey: 'fixture', requestId: 'background' }
      });
      await until(() => scheduler.getStatus('fixture-gpu').queued === 1, 'background admission');
      assert.equal(firstQueue.claim(sharedId, {
        bookId: 'shared', chapterIndex: 0, variantKey: 'fixture', requestId: 'foreground'
      }, 'immediate'), true);
      firstQueue.cancelWhere({ requestId: 'foreground' });
      const foregroundId = await secondQueue.enqueue({
        text: 'genuine-next', outputPath: path.join(cacheDir, 'genuine.wav'),
        voice: 'fixture:voice', priority: 'next',
        activity: { bookId: 'genuine', chapterIndex: 0, variantKey: 'fixture', requestId: 'genuine' }
      });
      await until(() => scheduler.getStatus('fixture-gpu').queued === 2, 'both pending admissions');
      blocker.resolve();
      await Promise.all([active, firstQueue.waitFor(sharedId), secondQueue.waitFor(foregroundId)]);
      assert.deepEqual(starts, ['genuine-next', 'released-background']);
      return { starts };
    });

    await check('durable claim removal follows owner identity after promotion', async () => {
      const journal = new GenerationJournal(path.join(tempDir, 'claim-journal.json'));
      const base = {
        bookId: 'claim-book', chapterIndex: 0, variantKey: 'fixture',
        text: 'Durable ownership must not depend on its mutable priority.',
        origin: 'offline-download', requestId: 'claim-request', sessionId: 'claim-session'
      };
      await journal.putChapter({ ...base, priority: 'background' });
      await journal.addChapterClaim({ ...base, priority: 'immediate' });
      const removed = await journal.removeChapterClaim({ ...base, priority: 'background' });
      const remaining = await journal.listChapters();
      assert.equal(removed, true);
      assert.equal(remaining.length, 0);
      return { removed, remaining: remaining.length };
    });

    await check('provider failure retries after restart and cached restart does no provider work', async () => {
      const cacheDir = path.join(tempDir, 'restart-cache');
      await fs.mkdir(cacheDir);
      const journal = new GenerationJournal(path.join(tempDir, 'restart-journal.json'));
      const text = 'A retryable provider failure must survive restart and preserve completed audio.';
      let failingCalls = 0;
      const failingQueue = makeQueue(cacheDir, async () => {
        failingCalls++;
        throw new Error('fixture provider unavailable');
      });
      const failingTts = makeTts(cacheDir, failingQueue, journal);
      const failed = await failingTts.generateChapter('restart-book', 0, text, 'en', 'background', {
        voice: 'fixture:voice', origin: 'offline-download', requestId: 'restart-request'
      });
      await assert.rejects(failingTts.waitForChapter('restart-book', 0), /unavailable|failed/);
      await until(async () => (await journal.listChapters())[0]?.status === 'retryable', 'retryable journal record');
      failingTts.stopReconcileLoop();

      let retryCalls = 0;
      const retryQueue = makeQueue(cacheDir, async ({ text: chunkText, outputPath }) => {
        retryCalls++;
        await fs.writeFile(outputPath, audioBytes(chunkText));
      });
      const retryTts = makeTts(cacheDir, retryQueue, journal);
      const retryReport = await retryTts.resumePendingChapters();
      assert.equal(retryReport.failed.length, 0);
      assert.equal(retryReport.resumed.length, 1);
      await retryTts.waitForChapter('restart-book', 0);
      await until(async () => (await journal.listChapters()).length === 0, 'completed retry journal cleanup');
      retryTts.stopReconcileLoop();

      await journal.putChapter({
        bookId: 'restart-book', chapterIndex: 0, variantKey: 'fixture:voice:recovery-v1',
        text, language: 'en', priority: 'download', origin: 'offline-download',
        requestId: 'cached-restart', voice: 'fixture:voice', chunkSize: 1000
      });
      let cachedCalls = 0;
      const cachedQueue = makeQueue(cacheDir, async () => { cachedCalls++; });
      const cachedTts = makeTts(cacheDir, cachedQueue, journal);
      const cachedReport = await cachedTts.resumePendingChapters();
      assert.equal(cachedReport.failed.length, 0);
      assert.equal(cachedReport.resumed.length, 1);
      assert(cachedReport.resumed[0].manifest.chunks.every(chunk => chunk.status === 'ready'));
      assert.equal(cachedCalls, 0);
      assert.equal((await journal.listChapters()).length, 0);
      cachedTts.stopReconcileLoop();
      return {
        failingCalls,
        failedStatus: failed.chunks[0].status,
        retryCalls,
        cachedCalls,
        cachedChunks: cachedReport.resumed[0].manifest.totalChunks
      };
    });

    await check('shared pause retains work and final pause permits resume', async () => {
      const cacheDir = path.join(tempDir, 'pause-cache');
      await fs.mkdir(cacheDir);
      const journal = new GenerationJournal(path.join(tempDir, 'pause-journal.json'));
      const providerGate = deferred();
      let calls = 0;
      const queue = makeQueue(cacheDir, async ({ text, outputPath, signal }) => {
        calls++;
        await Promise.race([
          providerGate.promise,
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(
            Object.assign(new Error('fixture cancelled'), { name: 'AbortError' })
          ), { once: true }))
        ]);
        if (signal.aborted) throw Object.assign(new Error('fixture cancelled'), { name: 'AbortError' });
        await fs.writeFile(outputPath, audioBytes(text));
      });
      const tts = makeTts(cacheDir, queue, journal);
      const text = 'Shared owners must pause independently and later resume from durable intent.';
      try {
        const manifest = await tts.generateChapter('pause-book', 0, text, 'en', 'background', {
          voice: 'fixture:voice', origin: 'premium-prep', requestId: 'background-owner'
        });
        const jobId = manifest.chunks[0].jobId;
        await tts.claimChapter('pause-book', 0, {
          origin: 'playback-current', requestId: 'playback-owner'
        }, 'immediate', { chunkIndexes: [0] });
        await tts.releaseRequestClaims('pause-book', 'background-owner');
        assert(['queued', 'generating'].includes(queue.getStatus(jobId)?.status));
        let durable = (await journal.listChapters())[0];
        assert.deepEqual(durable.claims.map(claim => claim.requestId), ['playback-owner']);
        await tts.releaseRequestClaims('pause-book', 'playback-owner');
        await until(() => queue.getStatus(jobId) === null, 'final owner cancellation');
        assert.equal((await journal.listChapters()).length, 0);

        const resumed = await tts.generateChapter('pause-book', 0, text, 'en', 'background', {
          voice: 'fixture:voice', origin: 'premium-prep', requestId: 'resumed-owner'
        });
        providerGate.resolve();
        await tts.waitForChapter('pause-book', 0);
        assert(resumed.chunks.every(chunk => chunk.status === 'ready'));
        return { calls, retainedAfterFirstPause: true, resumedStatus: resumed.chunks[0].status };
      } finally {
        providerGate.resolve();
        tts.cancelBook('pause-book');
        tts.stopReconcileLoop();
      }
    });
  } finally {
    // Cancellation also retires durable records asynchronously. Let any final
    // atomic rename finish, then retry removal if it briefly recreates a file.
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }

  const report = {
    phase,
    createdAt: new Date().toISOString(),
    passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length,
    results
  };
  const reportPath = path.join(outputDir, `${phase}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, passed: report.passed, failed: report.failed }, null, 2));
  if (report.failed) process.exitCode = 1;
}

run().catch(async error => {
  await fs.mkdir(outputDir, { recursive: true }).catch(() => {});
  const reportPath = path.join(outputDir, `${phase}-fatal.json`);
  await fs.writeFile(reportPath, `${JSON.stringify({ phase, fatal: error.stack || error.message }, null, 2)}\n`).catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
