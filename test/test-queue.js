/**
 * Test suite for TTS Generation Queue
 * 
 * Tests priority ordering, concurrency limits, cancellation,
 * and status tracking — all with a mocked TTS backend.
 */

const TTSQueue = require('../lib/tts-queue');
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Test helper: subclass that stubs _generateTTS with a controllable delay
// ---------------------------------------------------------------------------

class TestableQueue extends TTSQueue {
  constructor(opts = {}) {
    super(opts);
    this.generationLog = [];   // records order of generation starts
    this.generateDelay = opts.generateDelay || 50; // ms
  }

  async _generateTTS(text, outputPath, language, voice) {
    this.generationLog.push({ text, outputPath, language, voice, startedAt: Date.now() });
    // Simulate work
    await new Promise(r => setTimeout(r, this.generateDelay));
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn()
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}`); console.error(`    ${err.message}`); });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log('\nTTS Queue Tests\n');

  // ----- 1. Basic enqueue and completion -----
  await test('enqueue returns a job id and job completes', async () => {
    const q = new TestableQueue({ maxConcurrent: 2, generateDelay: 10 });
    const id = await q.enqueue({ text: 'hello', outputPath: '/tmp/a.mp3', language: 'en' });
    assert.ok(typeof id === 'string' && id.length > 0, 'id should be a non-empty string');

    await q.waitFor(id);
    const status = q.getStatus(id);
    assert.strictEqual(status.status, 'complete');
  });

  // ----- 2. Immediate priority jobs run before background -----
  await test('immediate-priority jobs run before background jobs', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 30 });

    // Enqueue a blocking job first to fill the single worker slot
    const blockerId = await q.enqueue({ text: 'blocker', outputPath: '/tmp/block.mp3', priority: 'immediate' });

    // Now enqueue background, then immediate — immediate should run before background
    const bgId = await q.enqueue({ text: 'bg-1', outputPath: '/tmp/bg1.mp3', priority: 'background' });
    const immId = await q.enqueue({ text: 'imm-1', outputPath: '/tmp/imm1.mp3', priority: 'immediate' });
    const nextId = await q.enqueue({ text: 'next-1', outputPath: '/tmp/next1.mp3', priority: 'next' });

    // Wait for all to complete
    await Promise.all([
      q.waitFor(blockerId),
      q.waitFor(bgId),
      q.waitFor(immId),
      q.waitFor(nextId)
    ]);

    // generationLog order should be: blocker, imm-1, next-1, bg-1
    const order = q.generationLog.map(e => e.text);
    assert.strictEqual(order[0], 'blocker', 'blocker should run first (it was already active)');
    assert.strictEqual(order[1], 'imm-1', 'immediate job should run second');
    assert.strictEqual(order[2], 'next-1', 'next job should run third');
    assert.strictEqual(order[3], 'bg-1', 'background job should run last');
  });

  // ----- 3. Concurrency limit is respected -----
  await test('concurrency limit is respected (max 2)', async () => {
    const q = new TestableQueue({ maxConcurrent: 2, generateDelay: 60 });
    let maxConcurrentSeen = 0;
    let currentConcurrent = 0;

    q.on('progress', () => {
      currentConcurrent = q.getQueueStatus().active;
      if (currentConcurrent > maxConcurrentSeen) {
        maxConcurrentSeen = currentConcurrent;
      }
    });

    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = await q.enqueue({
        text: `job-${i}`,
        outputPath: `/tmp/job${i}.mp3`,
        priority: 'background'
      });
      ids.push(id);
    }

    // Wait for all
    await Promise.all(ids.map(id => q.waitFor(id)));

    assert.ok(maxConcurrentSeen <= 2, `max concurrent was ${maxConcurrentSeen}, expected <= 2`);
    assert.ok(maxConcurrentSeen >= 1, 'should have had at least 1 active');

    const status = q.getQueueStatus();
    assert.strictEqual(status.completed, 5);
    assert.strictEqual(status.active, 0);
    assert.strictEqual(status.queued, 0);
  });

  // ----- 4. Cancel a queued job -----
  await test('cancel removes a queued job', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 80 });

    // Fill the worker
    const id1 = await q.enqueue({ text: 'active', outputPath: '/tmp/active.mp3', priority: 'immediate' });
    // Queue two more
    const id2 = await q.enqueue({ text: 'queued-1', outputPath: '/tmp/q1.mp3', priority: 'background' });
    const id3 = await q.enqueue({ text: 'queued-2', outputPath: '/tmp/q2.mp3', priority: 'background' });

    // Let drain start so id1 becomes active and id2, id3 are queued
    await sleep(5);

    // Cancel id2 while it's still queued
    const cancelled = q.cancel(id2);
    assert.strictEqual(cancelled, true, 'cancel should return true for queued job');

    const statusAfterCancel = q.getQueueStatus();
    assert.strictEqual(statusAfterCancel.queued, 1, 'should have 1 queued after cancelling 1');

    // Active generation is abortable too.
    const cancelActive = q.cancel(id1);
    assert.strictEqual(cancelActive, true, 'should cancel an active job');

    // Wait for remaining jobs
    await assert.rejects(q.waitFor(id1), /cancelled/);
    await q.waitFor(id3);

    // id2's waitFor should reject
    try {
      await q.waitFor(id2);
      assert.fail('waitFor cancelled job should reject');
    } catch (err) {
      // Expected: either "Unknown job" or "Job cancelled"
      assert.ok(err.message.includes('cancelled') || err.message.includes('Unknown'),
        'should get cancellation or unknown error');
    }
  });

  // ----- 5. getStatus returns correct position -----
  await test('getStatus returns correct queue position', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 100 });

    const id1 = await q.enqueue({ text: 'a', outputPath: '/tmp/a.mp3', priority: 'immediate' });
    const id2 = await q.enqueue({ text: 'b', outputPath: '/tmp/b.mp3', priority: 'background' });
    const id3 = await q.enqueue({ text: 'c', outputPath: '/tmp/c.mp3', priority: 'background' });

    // Let drain start (next tick)
    await sleep(5);

    const s1 = q.getStatus(id1);
    assert.strictEqual(s1.status, 'generating', 'first job should be generating');
    assert.strictEqual(s1.position, 0);

    const s2 = q.getStatus(id2);
    assert.strictEqual(s2.status, 'queued');
    assert.strictEqual(s2.position, 0, 'id2 should be at position 0 in queue');

    const s3 = q.getStatus(id3);
    assert.strictEqual(s3.status, 'queued');
    assert.strictEqual(s3.position, 1, 'id3 should be at position 1 in queue');

    // Wait for all
    await Promise.all([q.waitFor(id1), q.waitFor(id2), q.waitFor(id3)]);
  });

  // ----- 6. Events are emitted -----
  await test('complete and progress events are emitted', async () => {
    const q = new TestableQueue({ maxConcurrent: 2, generateDelay: 10 });
    const events = { progress: 0, complete: 0 };

    q.on('progress', () => events.progress++);
    q.on('complete', () => events.complete++);

    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await q.enqueue({ text: `e${i}`, outputPath: `/tmp/e${i}.mp3` }));
    }

    await Promise.all(ids.map(id => q.waitFor(id)));

    assert.strictEqual(events.progress, 3, 'should get 3 progress events');
    assert.strictEqual(events.complete, 3, 'should get 3 complete events');
  });

  // ----- 7. Five jobs with mixed priorities (integration) -----
  await test('5 jobs with mixed priorities execute in correct order', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 15 });

    // Enqueue in a specific order, priorities should reorder them
    const ids = [];
    ids.push(await q.enqueue({ text: 'bg-A',  outputPath: '/tmp/bgA.mp3',  priority: 'background' }));
    ids.push(await q.enqueue({ text: 'next-B', outputPath: '/tmp/nextB.mp3', priority: 'next' }));
    ids.push(await q.enqueue({ text: 'imm-C',  outputPath: '/tmp/immC.mp3',  priority: 'immediate' }));
    ids.push(await q.enqueue({ text: 'bg-D',   outputPath: '/tmp/bgD.mp3',   priority: 'background' }));
    ids.push(await q.enqueue({ text: 'imm-E',  outputPath: '/tmp/immE.mp3',  priority: 'immediate' }));

    await Promise.all(ids.map(id => q.waitFor(id)));

    const order = q.generationLog.map(e => e.text);
    // Expected: imm-C, imm-E, next-B, bg-A, bg-D
    // BUT: with concurrency=1, the first enqueued job (bg-A) may start immediately
    // on the next tick before imm-C is even enqueued. Let's check the queue was
    // correctly sorted by checking that immediates come before next, before background
    // among the jobs that were actually queued (not the first one that auto-started).

    // Actually, all 5 are enqueued synchronously in the same microtask tick,
    // and _drain runs on process.nextTick, so ALL 5 are in the queue before
    // the first one starts.
    assert.deepStrictEqual(order, ['imm-C', 'imm-E', 'next-B', 'bg-A', 'bg-D'],
      `Expected priority order but got: ${order.join(', ')}`);
  });

  // ----- 8. getQueueStatus accuracy -----
  await test('getQueueStatus returns accurate counts', async () => {
    const q = new TestableQueue({ maxConcurrent: 2, generateDelay: 50 });

    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await q.enqueue({ text: `s${i}`, outputPath: `/tmp/s${i}.mp3` }));
    }

    // Let drain kick in
    await sleep(5);

    const mid = q.getQueueStatus();
    assert.strictEqual(mid.active, 2, 'should have 2 active');
    assert.strictEqual(mid.queued, 2, 'should have 2 queued');
    assert.strictEqual(mid.completed, 0, 'none completed yet');

    await Promise.all(ids.map(id => q.waitFor(id)));

    const final = q.getQueueStatus();
    assert.strictEqual(final.active, 0);
    assert.strictEqual(final.queued, 0);
    assert.strictEqual(final.completed, 4);
  });

  // ----- 9. Prioritize a queued job -----
  await test('prioritize moves a queued job ahead of lower-priority work', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 30 });

    const blockerId = await q.enqueue({ text: 'active', outputPath: '/tmp/active.mp3', priority: 'immediate' });
    const chunk1Id = await q.enqueue({ text: 'chunk-1', outputPath: '/tmp/chunk1.mp3', priority: 'next' });
    const chunk2Id = await q.enqueue({ text: 'chunk-2', outputPath: '/tmp/chunk2.mp3', priority: 'next' });
    const targetId = await q.enqueue({ text: 'chunk-6', outputPath: '/tmp/chunk6.mp3', priority: 'next' });

    await sleep(5);

    const prioritized = q.prioritize(targetId, 'immediate');
    assert.strictEqual(prioritized, true, 'queued target should be prioritized');

    await Promise.all([
      q.waitFor(blockerId),
      q.waitFor(chunk1Id),
      q.waitFor(chunk2Id),
      q.waitFor(targetId)
    ]);

    const order = q.generationLog.map(e => e.text);
    assert.deepStrictEqual(order, ['active', 'chunk-6', 'chunk-1', 'chunk-2']);
  });

  await test('foreground work bypasses an active background job', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 80 });

    const backgroundId = await q.enqueue({ text: 'background-render', outputPath: '/tmp/bg-render.mp3', priority: 'background' });
    await sleep(5);
    assert.strictEqual(q.getStatus(backgroundId).status, 'generating', 'background job should be active');

    const immediateId = await q.enqueue({ text: 'selected-voice', outputPath: '/tmp/selected-voice.mp3', priority: 'immediate' });
    await sleep(5);

    assert.strictEqual(q.getStatus(immediateId).status, 'generating', 'foreground job should bypass background work');
    assert.strictEqual(q.getQueueStatus().active, 2, 'one foreground job may run alongside background');

    await Promise.all([q.waitFor(backgroundId), q.waitFor(immediateId)]);
  });

  await test('prioritize moves a job to the front of its priority band', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 30 });

    const blockerId = await q.enqueue({ text: 'active', outputPath: '/tmp/active-band.mp3', priority: 'immediate' });
    const firstImmediateId = await q.enqueue({ text: 'old-immediate', outputPath: '/tmp/old-immediate.mp3', priority: 'immediate' });
    const targetId = await q.enqueue({ text: 'target-immediate', outputPath: '/tmp/target-immediate.mp3', priority: 'immediate' });
    await sleep(5);

    const prioritized = q.prioritize(targetId, 'immediate');
    assert.strictEqual(prioritized, true, 'queued target should be reprioritized');

    await Promise.all([
      q.waitFor(blockerId),
      q.waitFor(firstImmediateId),
      q.waitFor(targetId)
    ]);

    const order = q.generationLog.map(e => e.text);
    assert.deepStrictEqual(order, ['active', 'target-immediate', 'old-immediate']);
  });

  // ----- 10. Voice snapshot -----
  await test('enqueue stores voice snapshot until generation starts', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 10 });
    const id = await q.enqueue({
      text: 'voice-job',
      outputPath: '/tmp/voice.mp3',
      priority: 'immediate',
      voice: 'kokoro:am_lewis'
    });

    await q.waitFor(id);

    assert.strictEqual(q.generationLog[0].voice, 'kokoro:am_lewis');
  });

  // ----- 11. Duplicate output path -----
  await test('enqueue deduplicates queued jobs by output path and upgrades priority', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 30 });

    const blockerId = await q.enqueue({ text: 'active', outputPath: '/tmp/dedup-active.mp3', priority: 'immediate' });
    await sleep(5);

    const firstId = await q.enqueue({ text: 'first', outputPath: '/tmp/dedup-same.mp3', priority: 'background' });
    const secondId = await q.enqueue({ text: 'second', outputPath: '/tmp/dedup-same.mp3', priority: 'immediate' });

    assert.strictEqual(secondId, firstId, 'duplicate output path should reuse queued job id');
    assert.strictEqual(q.getQueueStatus().queued, 1, 'duplicate should not add a second queued job');

    await Promise.all([q.waitFor(blockerId), q.waitFor(firstId)]);
    const order = q.generationLog.map(e => e.text);
    assert.deepStrictEqual(order, ['active', 'first']);
  });

  await test('enqueue deduplicates active jobs by output path', async () => {
    const q = new TestableQueue({ maxConcurrent: 1, generateDelay: 30 });
    const firstId = await q.enqueue({ text: 'active-same', outputPath: '/tmp/dedup-active-same.mp3', priority: 'immediate' });
    await sleep(5);

    const secondId = await q.enqueue({ text: 'active-duplicate', outputPath: '/tmp/dedup-active-same.mp3', priority: 'immediate' });
    assert.strictEqual(secondId, firstId, 'duplicate active output path should reuse active job id');

    await q.waitFor(firstId);
    assert.strictEqual(q.generationLog.length, 1, 'active duplicate should not generate twice');
  });

  // ----- 12. Kokoro response formats -----
  await test('Kokoro direct MP3 response uses the shared mastering pipeline', async () => {
    const q = new TTSQueue({ timeout: 1000 });
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-kokoro-mp3-'));
    const out = path.join(tmpDir, 'sample.mp3');
    const previousFetch = global.fetch;
    const mp3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake-mp3');

    try {
      global.fetch = async () => ({
        ok: true,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength)
      });

      let masteredFormat = null;
      q._convertAudioBufferToOutput = async (buffer, inputFormat, outputPath) => {
        masteredFormat = inputFormat;
        assert.deepStrictEqual(buffer, mp3);
        await fsp.writeFile(outputPath, Buffer.from('mastered'));
      };
      await q._generateKokoroTTS('hello', out, 'en', 'am_michael');

      assert.strictEqual(masteredFormat, 'mp3');
      assert.strictEqual((await fsp.readFile(out)).toString(), 'mastered');
    } finally {
      global.fetch = previousFetch;
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('Kokoro WAV response uses the shared mastering pipeline', async () => {
    const q = new TTSQueue({ timeout: 1000 });
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-kokoro-wav-'));
    const out = path.join(tmpDir, 'sample.mp3');
    const previousFetch = global.fetch;
    const wav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfake-wav');

    try {
      global.fetch = async () => ({
        ok: true,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)
      });

      let converted = null;
      q._convertWavBufferToOutput = async (buffer, outputPath) => {
        converted = { sameBuffer: buffer.equals(wav), outputPath };
        await fsp.writeFile(outputPath, Buffer.from('converted'));
      };
      await q._generateKokoroTTS('hello', out, 'en', 'am_michael');

      assert.deepStrictEqual(converted, { sameBuffer: true, outputPath: out }, 'WAV response should use shared mastering');
      assert.strictEqual((await fsp.readFile(out)).toString(), 'converted');
    } finally {
      global.fetch = previousFetch;
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('Kokoro retries transient connection failures before marking a chunk failed', async () => {
    const q = new TTSQueue({ timeout: 2000 });
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-kokoro-retry-'));
    const out = path.join(tmpDir, 'sample.mp3');
    const previousFetch = global.fetch;
    const mp3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00retry-mp3');
    let calls = 0;

    try {
      global.fetch = async () => {
        calls++;
        if (calls === 1) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:8766');
        }
        return {
          ok: true,
          headers: { get: () => 'audio/mpeg' },
          arrayBuffer: async () => mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength)
        };
      };

      q._convertAudioBufferToOutput = async (buffer, inputFormat, outputPath) => {
        assert.strictEqual(inputFormat, 'mp3');
        await fsp.writeFile(outputPath, buffer);
      };
      await q._generateKokoroTTS('hello', out, 'en', 'am_michael');

      assert.strictEqual(calls, 2, 'transient connection failure should be retried once before success');
      assert.deepStrictEqual(await fsp.readFile(out), mp3);
    } finally {
      global.fetch = previousFetch;
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('active HTTP cancellation aborts promptly and removes every output artifact', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-http-cancel-'));
    const out = path.join(tmpDir, 'cancelled.mp3');
    const previousFetch = global.fetch;
    let fetchAborted = false;
    try {
      global.fetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          fetchAborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      const q = new TTSQueue({ timeout: 5000 });
      const engine = {
        label: 'Test HTTP', baseUrl: () => 'http://127.0.0.1:1', format: () => 'wav',
        timeout: () => 5000, backoffBaseMs: 1000, backoffMaxMs: 1000
      };
      q._generateTTS = async (text, outputPath, _language, _voice, _pad, signal) => {
        await Promise.all([
          fsp.writeFile(outputPath, 'stale'),
          fsp.writeFile(`${outputPath}.part`, 'partial'),
          fsp.writeFile(`${outputPath}.part.mp3`, 'partial'),
          fsp.writeFile(`${outputPath}.part.wav`, 'partial')
        ]);
        return q._generateHttpTTS(engine, text, outputPath, {}, 0, 0, signal);
      };
      const id = await q.enqueue({ text: 'HTTP cancellation text.', outputPath: out });
      for (let i = 0; i < 50 && q.getStatus(id)?.status !== 'generating'; i++) await sleep(2);
      const startedAt = Date.now();
      assert.strictEqual(q.cancel(id), true);
      await assert.rejects(q.waitFor(id), /cancelled/);
      assert(Date.now() - startedAt < 250, 'active cancellation should settle promptly');
      assert.strictEqual(fetchAborted, true, 'in-flight fetch receives abort');
      assert.strictEqual(q.getQueueStatus().active, 0, 'active map is cleaned');
      assert.strictEqual(q.getQueueStatus().queued, 0, 'pending queue is clean');
      assert.strictEqual(fs.existsSync(out), false, 'final output removed');
      assert.strictEqual(fs.existsSync(`${out}.part`), false, 'raw partial removed');
      assert.strictEqual(fs.existsSync(`${out}.part.mp3`), false, 'encoded partial removed');
      assert.strictEqual(fs.existsSync(`${out}.part.wav`), false, 'wav partial removed');
    } finally {
      global.fetch = previousFetch;
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('active Edge cancellation closes promptly and leaves no late artifacts', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-edge-cancel-'));
    const out = path.join(tmpDir, 'edge.mp3');
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const q = new TTSQueue({
      maxConcurrent: 1,
      edgeTtsRunner: async (_tts, _text, partPath, signal) => {
        await fsp.writeFile(partPath, Buffer.from('partial-edge-audio'));
        started();
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          setTimeout(resolve, 5000);
        });
      }
    });
    try {
      const id = await q.enqueue({
        text: 'This Edge narration is long enough to be speakable.',
        outputPath: out,
        priority: 'immediate',
        voice: 'en-US-AndrewMultilingualNeural'
      });
      await startedPromise;
      const cancelStartedAt = Date.now();
      assert.strictEqual(q.cancel(id), true);
      await assert.rejects(q.waitFor(id), /cancel/i);
      assert(Date.now() - cancelStartedAt < 500, 'Edge cancellation should settle promptly');
      await sleep(30);
      for (const candidate of [out, `${out}.part`, `${out}.part.mp3`]) {
        assert.strictEqual(fs.existsSync(candidate), false, `${path.basename(candidate)} should be removed`);
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('abort during HTTP retry backoff prevents another fetch', async () => {
    const q = new TTSQueue({ timeout: 5000 });
    const previousFetch = global.fetch;
    const controller = new AbortController();
    let calls = 0;
    try {
      global.fetch = async () => {
        calls++;
        return { ok: false, status: 503 };
      };
      const engine = {
        label: 'Backoff HTTP', baseUrl: () => 'http://127.0.0.1:1',
        timeout: () => 5000, backoffBaseMs: 1000, backoffMaxMs: 1000
      };
      const pending = q._fetchHttpTTSWithRetry(engine, { text: 'retry' }, controller.signal);
      while (calls === 0) await sleep(1);
      const startedAt = Date.now();
      controller.abort();
      await assert.rejects(pending, error => error.name === 'AbortError');
      assert(Date.now() - startedAt < 250, 'retry backoff aborts promptly');
      await sleep(20);
      assert.strictEqual(calls, 1, 'no retry starts after cancellation');
    } finally {
      global.fetch = previousFetch;
    }
  });

  await test('structured narration materially adapts every engine without corrupting dialogue', async () => {
    const narration = {
      pauseIntent: 'paragraph',
      segments: [
        { text: 'CHAPTER ONE', kind: 'heading', pauseIntent: 'heading' },
        { text: '“Wait—don’t go,” she said.', kind: 'dialogue', pauseIntent: 'paragraph' }
      ]
    };
    const expected = {
      kokoro: { heading: 'Chapter ONE.', pause: 375 },
      chatterbox: { heading: 'Chapter ONE…', pause: 425 },
      edge: { heading: 'Chapter ONE:', pause: 325 }
    };
    for (const engineId of Object.keys(expected)) {
      let context = null;
      const q = new TTSQueue({
        engineAdapters: {
          resolve: () => ({
            id: engineId,
            usesGpu: false,
            generate: async value => { context = value; }
          })
        }
      });
      const id = await q.enqueue({
        text: 'CHAPTER ONE\n\n“Wait—don’t go,” she said.', outputPath: null, narration
      });
      await q.waitFor(id);
      assert(context.text.startsWith(expected[engineId].heading), `${engineId} receives its heading cue`);
      assert(context.text.endsWith('“Wait—don’t go,” she said.'), `${engineId} preserves expressive dialogue`);
      assert.strictEqual(context.padEndMs, expected[engineId].pause, `${engineId} applies its paragraph pause floor`);
      assert.strictEqual(context.narration, narration, `${engineId} receives original structured metadata`);
    }
  });

  // ----- 13. Chatterbox response formats -----
  await test('Chatterbox direct MP3 response uses the shared mastering pipeline', async () => {
    const q = new TTSQueue({ timeout: 1000 });
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-chatterbox-mp3-'));
    const out = path.join(tmpDir, 'sample.mp3');
    const previousFetch = global.fetch;
    const previousUrl = process.env.CHATTERBOX_TTS_URL;
    const previousFormat = process.env.CHATTERBOX_TTS_AUDIO_FORMAT;
    const mp3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00chatterbox-mp3');

    try {
      process.env.CHATTERBOX_TTS_URL = 'http://127.0.0.1:18767';
      // Default is now WAV; this test covers the explicit MP3 override path.
      process.env.CHATTERBOX_TTS_AUDIO_FORMAT = 'mp3';
      global.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.strictEqual(payload.voice, 'brick-scott');
        assert.strictEqual(payload.format, 'mp3');
        return {
          ok: true,
          headers: { get: () => 'audio/mpeg' },
          arrayBuffer: async () => mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength)
        };
      };

      let masteredFormat = null;
      q._convertAudioBufferToOutput = async (buffer, inputFormat, outputPath) => {
        masteredFormat = inputFormat;
        assert.deepStrictEqual(buffer, mp3);
        await fsp.writeFile(outputPath, Buffer.from('mastered'));
      };
      await q._generateChatterboxTTS('hello', out, 'brick-scott');

      assert.strictEqual(masteredFormat, 'mp3');
      assert.strictEqual((await fsp.readFile(out)).toString(), 'mastered');
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.CHATTERBOX_TTS_URL;
      else process.env.CHATTERBOX_TTS_URL = previousUrl;
      if (previousFormat === undefined) delete process.env.CHATTERBOX_TTS_AUDIO_FORMAT;
      else process.env.CHATTERBOX_TTS_AUDIO_FORMAT = previousFormat;
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('chatterbox voice id routes through Chatterbox generation', async () => {
    const q = new TTSQueue({ timeout: 1000 });
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-chatterbox-route-'));
    const out = path.join(tmpDir, 'sample.mp3');

    try {
      let called = false;
      q._generateHttpTTS = async (engine, text, outputPath, payload) => {
        called = true;
        assert.strictEqual(engine.label, 'Chatterbox TTS');
        assert.strictEqual(text, 'hello from chatterbox');
        assert.strictEqual(outputPath, out);
        assert.strictEqual(payload.voice, 'brick-scott');
        await fsp.writeFile(outputPath, Buffer.from('ID3route'));
      };

      await q._generateTTS('hello from chatterbox', out, 'en', 'chatterbox:brick-scott');
      assert.strictEqual(called, true, 'Chatterbox branch should be used');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- 14. Chunk processing encode args -----

  await test('buildChunkEncodeArgs: trim -> stable gain/limiter -> resample chain, single 160k mp3 encode', async () => {
    const args = TTSQueue.buildChunkEncodeArgs({ partPath: '/tmp/x.part.mp3' });
    const af = args[args.indexOf('-af') + 1];
    const filters = af.split(',');
    assert(filters[0].startsWith('silenceremove=start_periods=1'), 'leading silence trim first');
    assert.strictEqual(filters[1], 'areverse', 'reverse before tail trim');
    assert(filters[2].startsWith('silenceremove=start_periods=1'), 'tail trim via start-side filter');
    assert.strictEqual(filters[3], 'areverse', 'reverse back');
    assert(filters[4].startsWith('volume=0.00dB'), 'stable calibration gain after trims');
    assert(filters[5].startsWith('alimiter=limit=0.750'), 'true-peak limiter follows calibration');
    assert.strictEqual(filters[filters.length - 1], 'aresample=24000', 'resample back to native rate last');
    assert(!af.includes('apad'), 'no padding without padEndMs');
    assert.strictEqual(args[args.indexOf('-b:a') + 1], '160k', 'single lossy encode at 160k');
    assert.strictEqual(args[args.indexOf('-c:a') + 1], 'libmp3lame', 'mp3 output');
    assert.strictEqual(args[args.length - 1], '/tmp/x.part.mp3', 'writes to part path');
  });

  await test('buildChunkEncodeArgs: wav output uses PCM and no MP3 bitrate', async () => {
    const args = TTSQueue.buildChunkEncodeArgs({ partPath: '/tmp/x.part.wav', outputFormat: 'wav' });
    assert.strictEqual(args[args.indexOf('-c:a') + 1], 'pcm_s16le', 'wav output is PCM');
    assert.strictEqual(args.includes('-b:a'), false, 'wav output should not include MP3 bitrate');
    assert.strictEqual(args[args.length - 1], '/tmp/x.part.wav', 'writes to wav part path');
  });

  await test('buildChunkEncodeArgs: padEndMs adds apad after limiter, before resample', async () => {
    const args = TTSQueue.buildChunkEncodeArgs({ partPath: '/tmp/x.part.mp3', padEndMs: 350 });
    const filters = args[args.indexOf('-af') + 1].split(',');
    const apadIdx = filters.findIndex(f => f.startsWith('apad='));
    assert.strictEqual(filters[apadIdx], 'apad=pad_dur=0.350', 'pause length in seconds');
    assert(filters[apadIdx - 1].startsWith('alimiter='), 'apad follows limiter');
    assert.strictEqual(filters[apadIdx + 1], 'aresample=24000', 'apad precedes resample');
  });

  await test('padEndMs threads from enqueue through to the engine call', async () => {
    const q = new TTSQueue({ timeout: 1000 });
    let seenPad = null;
    q._generateTTS = async (text, outputPath, language, voice, padEndMs) => {
      seenPad = padEndMs;
    };
    const jobId = await q.enqueue({ text: 'padded chunk text here', outputPath: null, padEndMs: 350 });
    await q.waitFor(jobId);
    assert.strictEqual(seenPad, 350, 'padEndMs reaches _generateTTS');
  });

  // ----- 15. Truncation guard -----

  await test('minExpectedChunkSeconds: conservative floor by char count', async () => {
    assert.strictEqual(TTSQueue.minExpectedChunkSeconds('x'.repeat(270)), 6, '270 chars -> 6s floor');
    assert.strictEqual(TTSQueue.minExpectedChunkSeconds('Chapter 1'), 0.4, 'tiny heading clamps to 0.4s');
    assert.strictEqual(TTSQueue.minExpectedChunkSeconds(''), 0.4, 'empty clamps to 0.4s');
  });

  await test('truncated generation retries once, then fails the chunk', async () => {
    const q = new TTSQueue({ timeout: 1000 });
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-trunc-'));
    const out = path.join(tmpDir, 'sample.mp3');
    const text = 'x'.repeat(270); // floor: 6s

    let generateCalls = 0;
    q._generateHttpTTSOnce = async (engine, t, outputPath) => {
      generateCalls++;
      await fsp.writeFile(outputPath, Buffer.from('fake'));
    };

    try {
      // Collapses both attempts -> throws, file removed
      q._probeChunkDurationSeconds = async () => 2.5;
      await assert.rejects(
        () => q._generateHttpTTS({ label: 'Test engine' }, text, out),
        /truncated audio/,
        'persistent truncation rejects'
      );
      assert.strictEqual(generateCalls, 2, 'exactly one retry');
      assert.strictEqual(fs.existsSync(out), false, 'truncated file is removed');

      // Recovers on retry -> succeeds
      generateCalls = 0;
      const durations = [2.5, 18];
      q._probeChunkDurationSeconds = async () => durations.shift();
      await q._generateHttpTTS({ label: 'Test engine' }, text, out);
      assert.strictEqual(generateCalls, 2, 'short first attempt triggers regeneration');
      assert.strictEqual(fs.existsSync(out), true, 'recovered file kept');

      // Unprobeable duration is accepted (no ffprobe evidence != truncation)
      generateCalls = 0;
      q._probeChunkDurationSeconds = async () => null;
      await q._generateHttpTTS({ label: 'Test engine' }, text, out);
      assert.strictEqual(generateCalls, 1, 'null probe accepted without retry');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- 16. Error-chunk resume (auto-resume after engine outage) -----

  const ChunkedTTS = require('../lib/chunked-tts');

  function makeWritingQueue() {
    const q = new TestableQueue({ maxConcurrent: 2, generateDelay: 5 });
    q._generateTTS = async (text, outputPath) => {
      q.generationLog.push({ text, outputPath });
      await fsp.writeFile(outputPath, Buffer.from('fake-audio'));
    };
    return q;
  }

  await test('listChaptersWithErrors reports only chapters with error chunks', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-resume-'));
    try {
      const q = makeWritingQueue();
      const tts = new ChunkedTTS(tmpDir, q);
      const m1 = await tts.generateChapter('bookA', 0, 'First chapter text for testing resume.', 'en');
      const m2 = await tts.generateChapter('bookA', 1, 'Second chapter text for testing resume.', 'en');
      await tts.generateChapter('bookB', 0, 'Other book chapter text for testing resume.', 'en');
      await Promise.all([...q._jobs.keys()].map(id => q.waitFor(id).catch(() => {})));

      assert.deepStrictEqual(tts.listChaptersWithErrors(), [], 'no errors after clean generation');

      m1.chunks[0].status = 'error';
      m2.chunks[0].status = 'error';
      const errored = tts.listChaptersWithErrors();
      assert.deepStrictEqual(
        errored.map(e => `${e.bookId}:${e.chapterIndex}`).sort(),
        ['bookA:0', 'bookA:1'],
        'exactly the errored chapters are listed'
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('generateChapter re-enqueues error chunks from a cached manifest', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-resume-'));
    try {
      const q = makeWritingQueue();
      const tts = new ChunkedTTS(tmpDir, q);
      const manifest = await tts.generateChapter('bookA', 0, 'Chapter text for the resume regeneration test.', 'en');
      await Promise.all([...q._jobs.keys()].map(id => q.waitFor(id).catch(() => {})));
      assert.ok(manifest.chunks.every(c => c.status === 'ready'), 'all chunks ready after first pass');

      // Simulate an engine outage: chunk 0 errored and its file never landed.
      manifest.chunks[0].status = 'error';
      await fsp.unlink(tts.chunkPath('bookA', 0, 0));

      const before = q.generationLog.length;
      const resumed = await tts.generateChapter('bookA', 0, 'Chapter text for the resume regeneration test.', 'en');
      assert.ok(
        resumed.chunks[0].status === 'queued' || resumed.chunks[0].status === 'generating',
        `error chunk re-enqueued (got ${resumed.chunks[0].status})`
      );
      await Promise.all([...q._jobs.keys()].map(id => q.waitFor(id).catch(() => {})));
      assert.strictEqual(q.generationLog.length, before + 1, 'only the missing chunk regenerated');
      const final = tts.getChapterManifest('bookA', 0);
      assert.ok(final.chunks.every(c => c.status === 'ready'), 'chapter fully recovered');
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await test('concurrent resume calls dedupe to one job per chunk', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xandrio-resume-'));
    try {
      const q = makeWritingQueue();
      q.generateDelay = 50;
      const tts = new ChunkedTTS(tmpDir, q);
      const text = 'Chapter text for the dedup test of resume calls.';
      const [a, b] = await Promise.all([
        tts.generateChapter('bookA', 0, text, 'en'),
        tts.generateChapter('bookA', 0, text, 'en')
      ]);
      await Promise.all([...q._jobs.keys()].map(id => q.waitFor(id).catch(() => {})));
      assert.strictEqual(a.totalChunks, b.totalChunks);
      const uniquePaths = new Set(q.generationLog.map(g => g.outputPath));
      assert.strictEqual(
        q.generationLog.length, uniquePaths.size,
        'each output path generated exactly once despite concurrent calls'
      );
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ----- Summary -----
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
