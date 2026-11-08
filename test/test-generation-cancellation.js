/**
 * Cancelled generation must stay cancelled, and nobody may join work that is
 * already being torn down. Covers the queue, the chunk scheduler and the
 * server's chapter-preparation records.
 */
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const vm = require('vm');
const ChunkedTTS = require('../lib/chunked-tts');
const GenerationJournal = require('../lib/generation-journal');
const TTSQueue = require('../lib/tts-queue');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Abortable fake synthesis: a render takes `ms`, writes a plausible file, and
// rejects promptly when the job's signal aborts.
function fakeQueue(cacheDir, { ms = 60 } = {}) {
  const queue = new TTSQueue({ maxConcurrent: 1, cacheDir, defaultVoice: 'kokoro:am_michael' });
  queue.started = 0;
  queue._generateTTS = (text, outputPath, language, voice, padEndMs, signal) => new Promise((resolve, reject) => {
    queue.started++;
    const timer = setTimeout(() => {
      try {
        fs.writeFileSync(outputPath, Buffer.alloc(50000));
        resolve();
      } catch (error) {
        reject(error);
      }
    }, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
  return queue;
}

const chapterText = () => Array.from({ length: 6 }, (_, index) =>
  `Paragraph ${index} ` + 'word '.repeat(30)).join('\n\n');

const lookahead = claim => claim.origin === 'playback-lookahead' && claim.priority === 'lookahead';

(async () => {
  console.log('generation cancellation tests');

  await test('released lookahead claims are not resurrected by reconcile', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cancel-'));
    try {
      const queue = fakeQueue(cacheDir);
      const journal = new GenerationJournal(path.join(cacheDir, 'generation-state.json'));
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 200, reconcileIntervalMs: 0, generationJournal: journal
      });
      await tts.generateChapter('book', 0, chapterText(), 'en', 'lookahead', {
        origin: 'playback-lookahead', priorityForChunk: () => 'lookahead'
      });
      await delay(20);
      assert.strictEqual(queue.started, 1);
      assert.strictEqual((await journal.listChapters()).length, 1);

      const cancelled = await tts.releaseClaimsWhere(lookahead);
      assert.ok(cancelled >= 1, 'the queue work is cancelled');
      const manifest = tts.getChapterManifest('book', 0);
      assert.deepStrictEqual(manifest._generation.claims, []);
      assert.strictEqual(manifest._generation.baseActivity.origin, null);
      assert.strictEqual((await journal.listChapters()).length, 0, 'the durable claim is released');

      await delay(100);
      await tts.reconcile();
      await delay(100);
      assert.strictEqual(queue.started, 1, 'no cancelled chunk is synthesized again');
      assert.strictEqual(queue.getQueueStatus().queued + queue.getQueueStatus().active, 0);
      assert.strictEqual(tts._jobMap.size, 0, 'cancelled job ids are forgotten');
      assert.ok(manifest.chunks.every(chunk => chunk.status === 'pending' && !chunk.jobId));
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('releasing claims reaches variant workers and keeps other owners', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cancel-'));
    try {
      const queue = fakeQueue(cacheDir, { ms: 20 });
      const root = new ChunkedTTS(cacheDir, queue, { chunkSize: 200, reconcileIntervalMs: 0 });
      const worker = root.workerForVariant('fixed-variant', { chunkSize: 200 });
      await worker.generateChapter('book', 1, chapterText(), 'en', 'lookahead', {
        origin: 'playback-lookahead', priorityForChunk: () => 'lookahead'
      });
      await worker.claimChapter('book', 1, { origin: 'playback-current', sessionId: 's' }, 'immediate');
      await root.releaseClaimsWhere(lookahead);
      const manifest = worker.getChapterManifest('book', 1);
      assert.deepStrictEqual(manifest._generation.claims.map(claim => claim.origin), ['playback-current']);
      await worker.waitForChapter('book', 1);
      assert.ok(manifest.chunks.every(chunk => chunk.status === 'ready'), 'the remaining owner still gets the chapter');
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('server cancellations release manifest claims, not only queue claims', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(!/ttsQueue\.cancelWhere\(/.test(server), 'server.js must cancel through releaseClaimsWhere');
  });

  await test('a new caller does not join a job that is being cancelled', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cancel-'));
    try {
      const queue = fakeQueue(cacheDir);
      const outputPath = path.join(cacheDir, 'a.mp3');
      const text = 'hello world '.repeat(5);
      const first = await queue.enqueue({ text, outputPath, priority: 'lookahead',
        activity: { bookId: 'b', chapterIndex: 1, chunkIndex: 0, origin: 'playback-lookahead' } });
      await delay(20);
      assert.strictEqual(queue.getStatus(first).status, 'generating');
      queue.cancelWhere(claim => claim.origin === 'playback-lookahead');
      assert.strictEqual(queue.claim(first, { bookId: 'b', chapterIndex: 1, origin: 'x' }, 'immediate'), false,
        'claim refuses a cancelling job');
      const second = await queue.enqueue({ text, outputPath, priority: 'immediate',
        activity: { bookId: 'b', chapterIndex: 1, chunkIndex: 0, origin: 'playback-current' } });
      assert.notStrictEqual(second, first);
      assert.strictEqual(await queue.waitFor(second), outputPath);
      assert.ok(fs.existsSync(outputPath), 'the cancelled job did not delete the new output');
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a chunk whose job is cancelled under a live owner is rescheduled at once', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cancel-'));
    try {
      const queue = fakeQueue(cacheDir);
      const tts = new ChunkedTTS(cacheDir, queue, { chunkSize: 200, reconcileIntervalMs: 0 });
      await tts.generateChapter('book', 2, chapterText(), 'en', 'immediate', { origin: 'playback-current' });
      await delay(20);
      const manifest = tts.getChapterManifest('book', 2);
      const deadJobId = manifest.chunks[0].jobId;
      assert.strictEqual(queue.getStatus(deadJobId).status, 'generating');
      queue.cancel(deadJobId);
      await delay(30);
      assert.ok(!tts._jobMap.has(deadJobId), 'the cancelled job id is dropped');
      assert.notStrictEqual(manifest.chunks[0].jobId, deadJobId);
      assert.ok(['queued', 'generating'].includes(queue.getStatus(manifest.chunks[0].jobId)?.status),
        'chunk 0 is back in the queue without waiting for reconcile');
      await tts.waitForChapter('book', 2);
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('retired request ids are pruned once old and unreferenced, never while referenced', async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-cancel-'));
    try {
      const queue = fakeQueue(cacheDir, { ms: 5 });
      queue._drain = () => {};
      const tts = new ChunkedTTS(cacheDir, queue, { chunkSize: 200, reconcileIntervalMs: 0 });
      await tts.generateChapter('book', 3, chapterText(), 'en', 'background', {
        origin: 'premium-prep', requestId: 'referenced'
      });
      await tts.releaseRequestClaims('other-book', 'referenced');
      await tts.releaseRequestClaims('other-book', 'old');
      // Age both entries past the retention window.
      for (const id of ['referenced', 'old']) tts._retiredRequestIds.set(id, 0);
      await tts.releaseRequestClaims('other-book', 'fresh');
      assert.ok(tts._retiredRequestIds.has('referenced'), 'a manifest still names it');
      assert.ok(!tts._retiredRequestIds.has('old'), 'an old unreferenced id is pruned');
      assert.ok(tts._retiredRequestIds.has('fresh'));
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('ensureChapterAudioPrepared does not join an aborted, unsettled record', async () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const slice = (start, end) => {
      const begin = server.indexOf(start);
      const stop = server.indexOf(end, begin);
      assert(begin >= 0 && stop > begin, `missing ${start}`);
      return server.slice(begin, stop);
    };
    const source = [
      slice('function chapterPreparationAbortError(', '\nfunction closeImportJobSubscribers('),
      slice('async function ensureChapterAudioPrepared(', '\n/** The completed chapter file')
    ].join('\n');
    const generations = [];
    const manifests = new Map();
    const tts = {
      variantKeyProvider: () => 'v',
      chapterPath: () => '/missing.mp3',
      getChapterManifest: (bookId, chapterIndex) => manifests.get(chapterIndex) || null,
      claimChapter: async () => 1,
      prioritizeChunk: () => true,
      // The first generation ignores its abort until released, so its record
      // stays unsettled after every consumer left.
      generateChapter: (bookId, chapterIndex, text, language, priority, options) => new Promise((resolve, reject) => {
        const fresh = generations.length > 0;
        generations.push({ options, release: () => {
          if (!fresh) return reject(Object.assign(new Error('late'), { name: 'AbortError' }));
          const manifest = { chunks: [{ status: 'ready' }] };
          manifests.set(chapterIndex, manifest);
          resolve(manifest);
        } });
      }),
      waitForChapter: async () => {},
      concatenateChunks: async () => '/chapter.mp3'
    };
    const context = {
      loadJSON: async () => ({ book: { path: '/book' } }),
      BOOKS_FILE: 'books.json',
      getChaptersCached: async () => [{ text: 'chapter' }],
      fs: { access: async () => { throw new Error('missing'); } },
      recordMeasuredChapterDuration: async () => {},
      manifestNeedsResume: () => true,
      chapterAudioPrepareJobs: new Map(),
      cleanChapterAudioPrepareJobs: new Map(),
      chapterGenerationScope: require('../lib/audio-generation-intent').chapterGenerationScope,
      getChapterGenerationPriority: () => () => 'immediate',
      GENERATION_PRIORITY: { DOWNLOAD: 'download' },
      GENERATION_ORIGIN: { OFFLINE_DOWNLOAD: 'offline-download', PLAYBACK_CURRENT: 'playback-current' },
      ttsForTier: () => tts,
      voiceForTier: () => 'voice',
      Promise, Map, Set, Error, AbortController
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.prepare = ensureChapterAudioPrepared;`, context);

    const firstCaller = new AbortController();
    const first = context.prepare('book', 0, { signal: firstCaller.signal, tts });
    first.catch(() => {});
    await delay(10);
    assert.strictEqual(generations.length, 1);
    firstCaller.abort();
    await first.catch(() => {});
    const stale = context.chapterAudioPrepareJobs.get('book:0:v');
    assert.ok(stale?.controller.signal.aborted && !stale.settled, 'the old record is aborted but unsettled');

    const second = context.prepare('book', 0, { signal: new AbortController().signal, tts });
    await delay(10);
    assert.strictEqual(generations.length, 2, 'a fresh preparation starts');
    const current = context.chapterAudioPrepareJobs.get('book:0:v');
    assert.notStrictEqual(current, stale);
    generations[0].release();
    await delay(10);
    assert.strictEqual(context.chapterAudioPrepareJobs.get('book:0:v'), current,
      'the old record\'s cleanup leaves the new record in place');
    generations[1].release();
    assert.strictEqual(await second, '/chapter.mp3');
  });

  console.log(`generation cancellation tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  setImmediate(() => process.exit());
})();
