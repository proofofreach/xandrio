const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const ChunkedTTS = require('../lib/chunked-tts');
const GenerationJournal = require('../lib/generation-journal');
const TTSQueue = require('../lib/tts-queue');

class ControlledQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.enqueued = [];
    this.claims = [];
    this.counter = 0;
  }

  async enqueue(job) {
    if (Number.isInteger(this.failEnqueueAfter) && this.enqueued.length >= this.failEnqueueAfter) {
      throw new Error('Synthetic enqueue failure');
    }
    const id = `job-${this.counter++}`;
    const record = { ...job, id, status: 'queued' };
    this.jobs.set(id, record);
    this.enqueued.push(record);
    return id;
  }

  getStatus(id) {
    const job = this.jobs.get(id);
    return job ? { status: job.status } : null;
  }

  claim(id, activity, priority) {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'generating'].includes(job.status)) return false;
    this.claims.push({ id, activity, priority });
    if (priority === 'immediate') job.priority = priority;
    return true;
  }

  prioritize(id, priority) {
    const job = this.jobs.get(id);
    if (!job || !['queued', 'generating'].includes(job.status)) return false;
    job.priority = priority;
    return true;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    job.status = 'cancelled';
    this.jobs.delete(id);
    return true;
  }

  waitFor(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`Unknown job: ${id}`));
    if (job.status === 'complete') return Promise.resolve(job.outputPath);
    return new Promise((resolve, reject) => {
      const complete = event => {
        if (event.jobId !== id) return;
        cleanup();
        resolve(event.outputPath);
      };
      const error = event => {
        if (event.jobId !== id) return;
        cleanup();
        reject(event.error);
      };
      const cleanup = () => {
        this.off('complete', complete);
        this.off('error', error);
      };
      this.on('complete', complete);
      this.on('error', error);
    });
  }

  complete(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'complete';
    this.emit('complete', { jobId: id, outputPath: job.outputPath });
  }

  live() {
    return [...this.jobs.values()].filter(job => ['queued', 'generating'].includes(job.status));
  }
}

function longChapter(sentences = 80) {
  return Array.from(
    { length: sentences },
    (_, index) => `Sentence ${index + 1} is long enough to create a deterministic narration chunk.`
  ).join(' ');
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

// Poll for a condition driven by a timer rather than a promise chain.
async function waitUntil(condition, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting until ${description}`);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

(async () => {
  await test('materializes at most three chunks for an oversized import warmup', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;

      const manifest = await tts.generateChapter(
        'warm-book',
        0,
        longChapter(),
        'en',
        'background',
        { origin: 'import-warmup' }
      );

      assert(manifest.totalChunks > 20);
      assert.strictEqual(queue.live().length, 3);
      assert.strictEqual(
        manifest.chunks.filter(chunk => chunk.status === 'queued').length,
        3
      );
      assert(manifest.chunks.some(chunk => chunk.status === 'pending'));
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('backfills one chunk when a materialized chunk completes', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('pump-book', 0, longChapter(), 'en', 'background');
      const initialCount = queue.enqueued.length;

      queue.complete(queue.live()[0].id);
      await settle();

      assert.strictEqual(initialCount, 3);
      assert.strictEqual(queue.enqueued.length, 4);
      assert.strictEqual(queue.live().length, 3);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('playback-current claims only the requested chunk and successor', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      const manifest = await tts.generateChapter(
        'play-book',
        0,
        longChapter(),
        'en',
        'background',
        { origin: 'import-warmup' }
      );
      assert(manifest.totalChunks > 12);

      await tts.claimChapter(
        'play-book',
        0,
        { origin: 'playback-current' },
        'immediate',
        { chunkIndexes: [10, 11] }
      );

      const playbackClaims = [...new Set([
        ...queue.claims
          .filter(claim => claim.activity.origin === 'playback-current')
          .map(claim => claim.activity.chunkIndex),
        ...queue.enqueued
          .filter(job => job.activity.origin === 'playback-current')
          .map(job => job.activity.chunkIndex)
      ])].sort((left, right) => left - right);
      assert.deepStrictEqual(playbackClaims, [10, 11]);
      assert.strictEqual(queue.live().length, 3);
      assert(['queued', 'generating', 'ready'].includes(manifest.chunks[10].status));
      assert(['queued', 'generating', 'ready'].includes(manifest.chunks[11].status));
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('fresh playback generation does not label background continuation as playback-current', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('fresh-play-book', 0, longChapter(), 'en', 'immediate', {
        origin: 'playback-current',
        chunkIndexes: [10, 11],
        priorityForChunk: index => index === 10 ? 'immediate' : (index === 11 ? 'next' : 'background')
      });

      for (let turn = 0; turn < 3; turn++) {
        for (const job of queue.live()) queue.complete(job.id);
        await settle();
      }

      const playbackIndexes = [...new Set(queue.enqueued
        .filter(job => job.activity.origin === 'playback-current')
        .map(job => job.activity.chunkIndex))]
        .sort((left, right) => left - right);
      assert.deepStrictEqual(playbackIndexes, [10, 11]);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('hybrid playback keeps its first chunk near 420 under the fast profile size', async () => {
    const tts = new ChunkedTTS('/tmp/test-cache', null, {
      chunkSize: 900,
      splitPolicyProvider: () => 'hybrid-v1'
    });
    const chunks = tts.splitIntoChunks(longChapter(), 900);
    assert(chunks.length > 3);
    assert(chunks[0].length <= 420);
    assert(chunks.slice(1).some(chunk => chunk.length > 420));
    assert(chunks.slice(1).every(chunk => chunk.length <= 900));
  });

  await test('waitForChapter follows lazy materialization through chapter readiness', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      const manifest = await tts.generateChapter('wait-book', 0, longChapter(12), 'en', 'download');
      const waiting = tts.waitForChapter('wait-book', 0);

      while (!manifest.chunks.every(chunk => chunk.status === 'ready')) {
        const live = queue.live();
        assert(live.length > 0);
        for (const job of live) queue.complete(job.id);
        await settle();
      }

      await waiting;
      assert(manifest.chunks.every(chunk => chunk.status === 'ready'));
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a chapter whose queued jobs vanish is revived rather than left hanging', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-stranded-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        chapterLivenessIntervalMs: 10
      });
      tts._fileExists = async () => false;
      const manifest = await tts.generateChapter('stranded-book', 0, longChapter(12), 'en', 'download');
      const waiting = tts.waitForChapter('stranded-book', 0);

      // The production failure: the jobs disappear without completing or
      // erroring, so no event ever settles the wait.
      assert(queue.live().length > 0, 'work was scheduled to begin with');
      queue.jobs.clear();
      await waitUntil(() => queue.live().length > 0, 'liveness re-enqueued the stranded chunks');

      while (!manifest.chunks.every(chunk => chunk.status === 'ready')) {
        for (const job of queue.live()) queue.complete(job.id);
        await settle();
      }
      await waiting;
      assert(manifest.chunks.every(chunk => chunk.status === 'ready'));
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a chapter that cannot be revived fails instead of preparing forever', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-stranded-fail-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        chapterLivenessIntervalMs: 10,
        chapterLivenessRecoveries: 1
      });
      tts._fileExists = async () => false;
      const manifest = await tts.generateChapter('doomed-book', 0, longChapter(12), 'en', 'download');
      const waiting = tts.waitForChapter('doomed-book', 0);

      // Nothing scheduled and nothing that can reschedule it.
      manifest._generation.halted = true;
      queue.jobs.clear();

      await assert.rejects(waiting, error => {
        assert.strictEqual(error.code, 'CHAPTER_GENERATION_STRANDED');
        return true;
      });
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a chunk already rendered on disk is adopted, not synthesized again', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-adopt-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        reconcileIntervalMs: 0
      });
      const rendered = new Set();
      tts._fileExists = async filePath => rendered.has(filePath);

      const manifest = await tts.generateChapter('adopt-book', 0, longChapter(12), 'en', 'download');
      const firstLive = queue.live();
      assert(firstLive.length > 0);

      // The job finishes and writes its audio, but its completion never lands:
      // this is the dropped-edge case _onJobComplete returns early on.
      const finished = firstLive[0];
      rendered.add(finished.outputPath);
      queue.jobs.delete(finished.id);
      const enqueuedBefore = queue.enqueued.length;

      await tts._pumpManifest(manifest);

      const finishedIndex = manifest.chunks.findIndex(
        chunk => tts.chunkPath('adopt-book', 0, chunk.index) === finished.outputPath
      );
      assert.strictEqual(
        manifest.chunks[finishedIndex].status,
        'ready',
        'the rendered chunk is adopted rather than reset to pending'
      );
      const reEnqueuedSamePath = queue.enqueued
        .slice(enqueuedBefore)
        .filter(job => job.outputPath === finished.outputPath);
      assert.strictEqual(reEnqueuedSamePath.length, 0, 'its audio is never re-synthesized');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('reconcile revives a chapter whose last completion edge was lost', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-reconcile-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        reconcileIntervalMs: 0
      });
      tts._fileExists = async () => false;
      const manifest = await tts.generateChapter('reconcile-book', 0, longChapter(12), 'en', 'background');

      // Every live job disappears without completing, erroring or cancelling —
      // no event of any kind reaches the scheduler. Nothing is awaiting this
      // chapter either, so the waiter-side watchdog cannot help.
      queue.jobs.clear();
      assert.strictEqual(queue.live().length, 0, 'the chapter is stranded');
      assert(
        manifest.chunks.some(chunk => chunk.status !== 'ready'),
        'and it still has outstanding work'
      );

      const repaired = await tts.reconcile();

      assert.deepStrictEqual(repaired, ['reconcile-book_0'], 'reconcile reports the repair');
      assert(queue.live().length > 0, 'work is scheduled again');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('the reconcile loop repairs a stranded chapter without being asked', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-reconcile-loop-'));
    let tts;
    try {
      const queue = new ControlledQueue();
      tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        reconcileIntervalMs: 25
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('loop-book', 0, longChapter(12), 'en', 'background');

      // Nothing calls reconcile() here; only the timer armed by the first
      // generation plan can bring this chapter back.
      queue.jobs.clear();
      await waitUntil(
        () => queue.live().length > 0,
        'the background loop rescheduled the stranded chunks'
      );
    } finally {
      tts?.stopReconcileLoop();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('reconcile resumes a chapter a retired look-ahead intent abandoned', async () => {
    // The production shape. A look-ahead aborts ("Generation intent was
    // retired"), which throws out of the pump without marking the plan halted
    // or cancelled — deliberately, since an AbortError is not a failure. What
    // it leaves behind is a live manifest with pending chunks and no jobs.
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-retired-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        reconcileIntervalMs: 0
      });
      tts._fileExists = async () => false;
      const controller = new AbortController();
      const manifest = await tts.generateChapter(
        'retired-book', 0, longChapter(12), 'en', 'lookahead', { signal: controller.signal }
      );

      // The abort unwinds the generation chain, and the jobs it had already
      // scheduled go away with it. Nothing pumps the manifest afterwards —
      // that is the whole problem — so the chunks are left QUEUED against job
      // ids the queue no longer knows.
      controller.abort();
      queue.jobs.clear();

      assert.strictEqual(manifest._generation.halted, false, 'an abort is not a failure');
      assert.strictEqual(manifest._generation.cancelled, false, 'nor a cancellation');
      assert.deepStrictEqual(await tts.reconcile(), ['retired-book_0']);
      assert(queue.live().length > 0, 'the abandoned chapter is generating again');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('reconcile does not resurrect deliberately cancelled work', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-cancelled-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        reconcileIntervalMs: 0
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('cancelled-book', 0, longChapter(12), 'en', 'background');

      // A pronunciation repair quiesces the chapter on purpose. Reviving it
      // would recreate exactly the audio the repair set out to replace.
      await tts.quiesceChapter('cancelled-book', 0);
      const enqueuedBefore = queue.enqueued.length;

      assert.deepStrictEqual(await tts.reconcile(), [], 'left alone');
      assert.strictEqual(queue.enqueued.length, enqueuedBefore, 'and nothing re-enqueued');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('reconcile leaves a healthy chapter completely alone', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-reconcile-noop-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        reconcileIntervalMs: 0
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('healthy-book', 0, longChapter(12), 'en', 'background');
      const enqueuedBefore = queue.enqueued.length;

      assert.deepStrictEqual(await tts.reconcile(), [], 'nothing to repair');
      assert.strictEqual(queue.enqueued.length, enqueuedBefore, 'and nothing re-enqueued');
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('persists and restores the playback chunk scope without queue fan-out', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const journal = new GenerationJournal(path.join(cacheDir, 'generation-state.json'));
      const firstQueue = new ControlledQueue();
      const first = new ChunkedTTS(cacheDir, firstQueue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        variantKeyProvider: () => 'test-variant',
        generationJournal: journal
      });
      first._fileExists = async () => false;
      await first.generateChapter('restore-book', 0, longChapter(), 'en', 'background', {
        origin: 'import-warmup'
      });
      await first.claimChapter(
        'restore-book',
        0,
        { origin: 'playback-current' },
        'immediate',
        { chunkIndexes: [10, 11] }
      );

      const stored = (await journal.listChapters())[0];
      assert.deepStrictEqual(
        stored.claims.find(claim => claim.origin === 'playback-current').chunkIndexes,
        [10, 11]
      );

      const restartQueue = new ControlledQueue();
      const restarted = new ChunkedTTS(cacheDir, restartQueue, {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        variantKeyProvider: () => 'test-variant',
        generationJournal: journal
      });
      restarted._fileExists = async () => false;
      await restarted.resumePendingChapters();

      assert.strictEqual(restartQueue.live().length, 3);
      const restoredPlayback = restartQueue.enqueued
        .filter(job => job.activity.origin === 'playback-current')
        .map(job => job.activity.chunkIndex)
        .sort((left, right) => left - right);
      assert.deepStrictEqual(restoredPlayback, [10, 11]);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('title deletion retires the deferred chapter pump', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('delete-book', 0, longChapter(), 'en', 'background');
      const jobsBeforeDelete = queue.enqueued.length;

      assert.strictEqual(tts.cancelBook('delete-book'), 3);
      await settle();

      assert.strictEqual(queue.live().length, 0);
      assert.strictEqual(queue.enqueued.length, jobsBeforeDelete);
      assert.strictEqual(tts.getChapterManifest('delete-book', 0), null);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('chapter quiesce rejects a full-chapter waiter', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('quiesce-book', 0, longChapter(), 'en', 'download');
      const waiting = tts.waitForChapter('quiesce-book', 0);

      await tts.quiesceChapter('quiesce-book', 0);
      await assert.rejects(waiting, /cancelled/);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('a lazy backfill enqueue failure rejects the chapter waiter', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new ControlledQueue();
      const tts = new ChunkedTTS(cacheDir, queue, {
        chunkSize: 90,
        maxMaterializedChunks: 3
      });
      tts._fileExists = async () => false;
      await tts.generateChapter('failure-book', 0, longChapter(), 'en', 'download');
      queue.failEnqueueAfter = queue.enqueued.length;
      const waiting = tts.waitForChapter('failure-book', 0);

      queue.complete(queue.live()[0].id);
      await assert.rejects(waiting, /Synthetic enqueue failure/);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  await test('shared queue enforces one three-chunk window across same-variant workers', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-window-'));
    try {
      const queue = new TTSQueue({ maxConcurrent: 1 });
      queue._drain = () => {};
      const options = {
        chunkSize: 90,
        maxMaterializedChunks: 3,
        variantKeyProvider: () => 'shared-variant'
      };
      const first = new ChunkedTTS(cacheDir, queue, options);
      const second = new ChunkedTTS(cacheDir, queue, options);
      first._fileExists = async () => false;
      second._fileExists = async () => false;

      await first.generateChapter('shared-book', 0, longChapter(), 'en', 'background');
      await second.generateChapter('shared-book', 0, longChapter(), 'en', 'immediate', {
        origin: 'playback-current',
        chunkIndexes: [10, 11],
        priorityForChunk: index => index === 10 ? 'immediate' : (index === 11 ? 'next' : 'background')
      });

      assert.strictEqual(queue.getQueueStatus().queued, 3);
      assert.strictEqual(second.getChapterManifest('shared-book', 0)._generation.waitingForCapacity, true);
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  console.log(`chunk-materialization tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
