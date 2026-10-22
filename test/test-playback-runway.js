const assert = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const {
  MAX_PLAYBACK_RATE,
  EARLY_START_SAFETY_FACTOR,
  EARLY_START_ALLOWANCE_SECONDS,
  PLAYBACK_BUFFER_CHARS,
  nextChunkArrivesInTime,
  playbackBufferIndexes,
  playbackChunkPriority
} = require('../lib/playback-runway');
const fsp = require('fs').promises;
const path = require('path');
const ChunkedTTS = require('../lib/chunked-tts');
const TTSQueue = require('../lib/tts-queue');

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

const NOW = 1_000_000;
function input(overrides = {}) {
  return {
    ready: { status: 'ready', textLength: 400 },
    next: { status: 'generating', textLength: 800 },
    readyTiming: { startedAt: NOW - 1500, synthesisMs: 1500 },
    nextTiming: { startedAt: NOW - 1500, synthesisMs: null },
    readyDurationSeconds: 27,
    now: NOW,
    ...overrides
  };
}

(async () => {
  await test('a fast engine may start on one chunk', () => {
    // Next predicted at 3 s total, 1.5 s left: 1.5 * 2 + 2 = 5 <= 27 / 3.
    assert.strictEqual(nextChunkArrivesInTime(input()), true);
  });

  await test('the budget assumes the fastest playback speed', () => {
    // 4 s remaining needs 4 * 2 + 2 = 10 s, more than 27 s at 3x (9 s).
    const slowNext = input({ readyTiming: { synthesisMs: 2750 }, nextTiming: { startedAt: NOW - 1500 } });
    assert.strictEqual(nextChunkArrivesInTime(slowNext), false);
    const remainingSeconds = 2750 * 2 / 1000 - 1.5;
    assert(remainingSeconds * EARLY_START_SAFETY_FACTOR + EARLY_START_ALLOWANCE_SECONDS > 27 / MAX_PLAYBACK_RATE);
  });

  await test('the reported listener speed sets the budget; unknown means fastest', () => {
    // Kokoro-like: 440 chars took 4.3 s; the next 440 just started.
    const kokoro = input({
      ready: { status: 'ready', textLength: 440 },
      next: { status: 'generating', textLength: 440 },
      readyTiming: { synthesisMs: 4300 },
      nextTiming: { startedAt: NOW - 100 },
      readyDurationSeconds: 29
    });
    // 4.2 s left: 4.2 * 2 + 2 = 10.4 s needed.
    assert.strictEqual(nextChunkArrivesInTime({ ...kokoro, playbackRate: 1 }), true);
    assert.strictEqual(nextChunkArrivesInTime({ ...kokoro, playbackRate: 3 }), false);
    assert.strictEqual(nextChunkArrivesInTime(kokoro), false);
    assert.strictEqual(nextChunkArrivesInTime({ ...kokoro, playbackRate: 'fast' }), false);
    // Slow listening earns no more than the 1x budget.
    const tight = { ...kokoro, readyDurationSeconds: 10.3 };
    assert.strictEqual(nextChunkArrivesInTime({ ...tight, playbackRate: 1 }), false);
    assert.strictEqual(nextChunkArrivesInTime({ ...tight, playbackRate: 0.5 }), false);
  });

  await test('an engine slower than real time never starts on one chunk', () => {
    const slow = input({
      readyTiming: { synthesisMs: 30000 },
      nextTiming: { startedAt: NOW - 29000 },
      next: { status: 'generating', textLength: 400 }
    });
    // Even nearly finished, the next chunk's prediction is trusted only while
    // it is not overdue, and a long synthesis cannot fit a short budget.
    assert.strictEqual(nextChunkArrivesInTime({ ...slow, now: NOW - 28000 }), false);
    assert.strictEqual(nextChunkArrivesInTime({ ...slow, now: NOW - 28000, playbackRate: 1 }), false);
  });

  await test('an overdue next chunk is waited for', () => {
    assert.strictEqual(nextChunkArrivesInTime(input({ nextTiming: { startedAt: NOW - 10000 } })), false);
  });

  await test('a shorter next chunk is not predicted faster than the measured one', () => {
    // 100-character next chunk still needs the full 1.5 s measured for chunk 0.
    const result = nextChunkArrivesInTime(input({
      next: { status: 'generating', textLength: 100 },
      nextTiming: { startedAt: NOW },
      readyDurationSeconds: 3 * (1.5 * 2 + 2) - 0.1
    }));
    assert.strictEqual(result, false);
  });

  await test('a manifest still marked queued may start once the queue reports synthesis', () => {
    assert.strictEqual(nextChunkArrivesInTime(input({ next: { status: 'queued', textLength: 800 } })), true);
    assert.strictEqual(nextChunkArrivesInTime(input({ next: { status: 'queued', textLength: 800 }, nextTiming: null })), false);
  });

  await test('missing evidence keeps the two-chunk rule', () => {
    for (const overrides of [
      { readyTiming: null },
      { readyTiming: { synthesisMs: null } },
      { nextTiming: null },
      { readyDurationSeconds: null },
      { next: { status: 'pending', textLength: 800 } },
      { next: { status: 'error', textLength: 800 } },
      { ready: { status: 'generating', textLength: 400 } },
      { ready: { status: 'ready' } }
    ]) {
      assert.strictEqual(nextChunkArrivesInTime(input(overrides)), false, JSON.stringify(overrides));
    }
  });

  await test('ChunkedTTS exposes live synthesis start and measured time, never for reuse', async () => {
    const queue = new EventEmitter();
    const started = new Map([['job-1', 1234], ['job-2', 5678]]);
    queue.synthesisStartedAt = jobId => started.get(jobId) ?? null;
    const tts = new ChunkedTTS(os.tmpdir(), queue);
    const chunk = { index: 0, status: 'generating', jobId: 'job-1' };
    const other = { index: 1, status: 'generating', jobId: 'job-2' };
    tts.manifests.set('book_0', { bookId: 'book', chapterIndex: 0, chunks: [chunk, other] });
    tts._jobMap.set('job-1', { manifestKey: 'book_0', chunkIndex: 0, bookId: 'book' });
    tts._jobMap.set('job-2', { manifestKey: 'book_0', chunkIndex: 1, bookId: 'book' });

    assert.deepStrictEqual(tts.chunkGenerationTiming(chunk), { startedAt: 1234, synthesisMs: null });
    queue.emit('complete', { jobId: 'job-1', outputPath: '/tmp/chunk0.mp3', synthesisMs: 4200 });
    assert.strictEqual(chunk.status, 'ready');
    assert.deepStrictEqual(tts.chunkGenerationTiming(chunk), { startedAt: null, synthesisMs: 4200 });

    queue.emit('complete', { jobId: 'job-2', outputPath: '/tmp/chunk1.mp3', reused: true, synthesisMs: null });
    assert.strictEqual(tts.chunkGenerationTiming(other), null, 'reused audio carries no engine timing');
    assert.strictEqual(tts.chunkGenerationTiming({ index: 2, status: 'queued', jobId: 'job-3' }), null);
  });

  await test('queue stamps synthesis after admission and reports its duration', async () => {
    const queue = new TTSQueue({ maxConcurrent: 1 });
    let release;
    let observedStart = null;
    queue._generateTTS = async () => {
      await new Promise(resolve => { release = resolve; });
    };
    const completions = [];
    queue.on('complete', event => completions.push(event));
    const id = await queue.enqueue({ text: 'Long enough narration for a timing test.', outputPath: '/tmp/x-timing.mp3' });
    await new Promise(resolve => setImmediate(resolve));
    observedStart = queue.synthesisStartedAt(id);
    assert(Number.isFinite(observedStart), 'an active synthesizing job reports its start');
    await new Promise(resolve => setTimeout(resolve, 15));
    release();
    await queue.waitFor(id);
    assert.strictEqual(queue.synthesisStartedAt(id), null, 'finished jobs report no live start');
    assert(completions[0].synthesisMs >= 10, JSON.stringify(completions[0]));
  });

  await test('the playback buffer outranks look-ahead, then yields to it', () => {
    const ramp = [396, 726, 1533, 3170, 2522, 4000, 4000].map(textLength => ({ textLength }));
    const priority = playbackChunkPriority(0);
    assert.deepStrictEqual(
      ramp.map((_, index) => priority(index, false, ramp)),
      ['immediate', 'next', 'next', 'next', 'next', 'background', 'background']
    );
    const kokoro = Array.from({ length: 30 }, () => ({ textLength: 440 }));
    const window = playbackBufferIndexes(kokoro, 10);
    assert.strictEqual(window[0], 11);
    assert(window.length * 440 >= PLAYBACK_BUFFER_CHARS - 440 && window.length * 440 < PLAYBACK_BUFFER_CHARS + 440);
    // Seeking moves the window with the target; earlier chunks stay background.
    const seek = playbackChunkPriority(10);
    assert.strictEqual(seek(10, false, kokoro), 'immediate');
    assert.strictEqual(seek(11, false, kokoro), 'next');
    assert.strictEqual(seek(window.at(-1), false, kokoro), 'next');
    assert.strictEqual(seek(window.at(-1) + 1, false, kokoro), 'background');
    assert.strictEqual(seek(3, false, kokoro), 'background');
    // Without chunk lengths, only the target and the chunk after it are raised.
    assert.strictEqual(priority(2, false), 'background');
  });

  await test('two engine slots generate the current chapter buffer before the next chapter look-ahead', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-runway-priority-'));
    // No cacheDir: no artifact store, so the stubbed synthesis is the only work.
    // Two slots, as for Edge: a chunk enqueued while its predecessor is still
    // synthesizing is not the chapter's first pending chunk.
    const queue = new TTSQueue({ maxConcurrent: 2, defaultVoice: 'en-US-AndrewMultilingualNeural' });
    const order = [];
    queue._generateTTS = async (text, outputPath) => {
      order.push(path.basename(outputPath));
      await new Promise(resolve => setTimeout(resolve, 2));
      await fsp.writeFile(outputPath, Buffer.alloc(64, 1));
    };
    const tts = new ChunkedTTS(dir, queue, {
      splitPolicyProvider: () => 'ramp-v1',
      chunkSizeProvider: () => 4000,
      variantKeyProvider: () => 'en-US-AndrewMultilingualNeural:chunk4000:outmp3:splitramp1',
      voiceProvider: () => 'en-US-AndrewMultilingualNeural'
    });
    const chapter = Array.from({ length: 260 }, (_, index) =>
      `Sentence ${index + 1} carries the listener a little further along the road home.`).join(' ');
    try {
      // prepare-chapter-audio: the current chapter's runway claim, then the
      // whole-chapter assembly claim, then the next chapter's look-ahead.
      await tts.generateChapter('book', 0, chapter, 'en', 'immediate', {
        priorityForChunk: playbackChunkPriority(0),
        chunkIndexes: [0, 1]
      });
      await tts.claimChapter('book', 0, { origin: 'playback-current', requestId: 'playback-assembly' }, 'background', {});
      tts.getChapterManifest('book', 0).chunks.forEach((chunk, index) => {
        if (chunk.status !== 'ready') tts.prioritizeChunk('book', 0, index, 'background');
      });
      await tts.generateChapter('book', 1, chapter, 'en', 'lookahead', { priorityForChunk: () => 'lookahead' });
      await Promise.all([tts.waitForChapter('book', 0), tts.waitForChapter('book', 1)]);

      const current = tts.getChapterManifest('book', 0).chunks;
      // 400 + 800 + 1600 + 3200 characters of ramp: chunks 1-4 are the
      // buffer behind chunk 0 (independent of the constant under test).
      const buffer = [0, 1, 2, 3, 4];
      assert(current.length > buffer.length, 'the chapter extends beyond its playback buffer');
      const firstLookahead = order.findIndex(name => name.includes('_ch1_'));
      // With two slots, the last buffer chunk may start beside the first
      // look-ahead chunk, never after a second one.
      const secondLookahead = order.findIndex((name, at) => at > firstLookahead && name.includes('_ch1_'));
      for (const index of buffer) {
        const at = order.findIndex(name => name.endsWith(`_ch0_chunk${index}.mp3`));
        assert(at >= 0 && at < secondLookahead, `current chunk ${index} ran after look-ahead: ${order.join(' ')}`);
      }
      const beyond = order.findIndex(name => name.endsWith(`_ch0_chunk${buffer.length}.mp3`));
      assert(firstLookahead < beyond, `look-ahead still runs once the buffer is generated: ${order.join(' ')}`);
      assert(current.slice(0, 4).reduce((sum, chunk) => sum + chunk.textLength, 0) < PLAYBACK_BUFFER_CHARS + 400);
    } finally {
      tts.cancelBook?.('book');
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  console.log(`playback-runway tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
  process.exit();
})();
