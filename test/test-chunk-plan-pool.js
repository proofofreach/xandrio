/**
 * Chunk-plan pool tests
 *
 * Planning on a worker thread must return exactly what the in-process planner
 * returns for every real split policy, must not block the event loop, must
 * share one plan between concurrent identical requests, and must fall back
 * to in-process planning when workers are unavailable or die.
 *
 * Run: node test/test-chunk-plan-pool.js
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const ChunkedTTS = require('../lib/chunked-tts');
const { createChunkPlanPool, defaultPoolSize } = require('../lib/chunk-plan-pool');
const { planSplitChunks } = require('../lib/chunk-planner');
const { createNarrationEngineRegistry } = require('../lib/narration-engine-registry');

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

// Realistic chapter text: headings, dialogue, abbreviations, decimals,
// scene breaks that are not speakable, and a long run-on paragraph.
function longChapter(seed, chars = 60000) {
  const sentences = [
    'The lamp on the desk flickered once and steadied.',
    '"We leave at dawn," she said, folding the map along its worn creases.',
    'He did not answer; the rain against the window answered for him.',
    'Beyond the harbor the fog had swallowed the last of the fishing boats.',
    'Dr. Abernathy checked his watch at 3.45 p.m. and frowned at Mr. Hale.',
    'Nobody in the village remembered when the bell had last rung...',
    '"Is it far?" "Farther than you think," he replied, "and colder."',
    'Chapter notes: see pp. 12-14, vol. II, and the 1998 ed. for details!'
  ];
  let out = `Chapter ${seed}\n\nI\n\n`;
  let i = seed;
  while (out.length < chars) {
    const count = 1 + (i % 7);
    const para = [];
    for (let k = 0; k < count; k++) para.push(sentences[(i * 3 + k) % sentences.length]);
    i++;
    if (i % 13 === 0) out += '* * *\n\n';
    if (i % 17 === 0) out += `Part ${i}\n\n`;
    if (i % 29 === 0) out += `${sentences.join(' ')} ${sentences.join(' ')} ${sentences.join(' ')}\n\n`;
    out += `${para.join(' ')}\n\n`;
  }
  return `${out}* * *\n\n`;
}

// A Worker double whose constructor fails: workers unavailable.
class UnavailableWorker {
  constructor() { throw new Error('worker threads disabled in this environment'); }
}

// A Worker double that dies on its first message.
class CrashingWorker extends EventEmitter {
  postMessage() { setImmediate(() => this.emit('error', new Error('worker crashed'))); }
  ref() {}
  unref() {}
  terminate() { return Promise.resolve(); }
}

// A Worker double that never answers.
class SilentWorker extends EventEmitter {
  postMessage() {}
  ref() {}
  unref() {}
  terminate() { this.terminated = (this.terminated || 0) + 1; return Promise.resolve(); }
}

// A Worker double whose reply cannot be decoded.
class GarbledWorker extends EventEmitter {
  postMessage() { setImmediate(() => this.emit('messageerror', new Error('bad clone'))); }
  ref() {}
  unref() {}
  terminate() { return Promise.resolve(); }
}

(async () => {
  const registry = createNarrationEngineRegistry({ defaultChunkSize: 4000, defaultConcurrency: 2 });
  const voices = ['kokoro:am_onyx', 'chatterbox:brick-scott', 'moss-nano:Nathan', 'edge:en-US-AriaNeural'];
  const policies = ['legacy-v1', 'hybrid-v1', 'ramp-v1', 'paragraph-v1'];
  const chapters = [longChapter(1), longChapter(2, 20000), 'Just one short line.', '', '   \n\n  ', null];

  await test('worker plans are byte-identical to in-process plans for every voice and policy', async () => {
    const seen = new Set();
    const cases = voices.map(voice => {
      const engine = registry.forVoice(voice);
      return [engine.splitPolicy, engine.chunkSize];
    }).concat(policies.map(policy => [policy, policy === 'paragraph-v1' ? 160 : 4000]), [['hybrid-v1', 300], ['ramp-v1', 900]]);
    const tts = new ChunkedTTS('/tmp/test-cache');
    for (const [policy, chunkSize] of cases) {
      for (const text of chapters) {
        const key = `${policy}|${chunkSize}|${text?.length ?? 'null'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Fresh text per case so neither the cache nor the in-flight map can
        // satisfy the async call; the suffix keeps the plan cold.
        const source = text ? `${text}\n\nCase ${key}.` : text;
        const expected = JSON.stringify(planSplitChunks(source, chunkSize, policy));
        const actual = JSON.stringify(await tts.planChunksWithMeta(source, chunkSize, policy));
        assert.strictEqual(actual, expected, `plan differs for ${key}`);
        assert.deepStrictEqual(
          await tts.planChunks(source, chunkSize, policy),
          tts.splitIntoChunks(source, chunkSize, policy),
          `planChunks differs from splitIntoChunks for ${key}`
        );
      }
    }
    const stats = ChunkedTTS.chunkPlanPoolStats();
    assert.ok(stats.workerPlans > 0 && stats.inProcessPlans === 0, `plans must run on workers: ${JSON.stringify(stats)}`);
    assert.ok(stats.workers >= 1 && stats.workers <= Math.max(1, defaultPoolSize()), 'pool stays within its size');
  });

  await test('planning long chapters keeps the event loop responsive', async () => {
    const tts = new ChunkedTTS('/tmp/test-cache');
    const texts = Array.from({ length: 8 }, (_, i) => longChapter(100 + i));
    const syncStart = performance.now();
    for (const text of texts) planSplitChunks(text, 4000, 'legacy-v1');
    const syncWallMs = performance.now() - syncStart;

    let worstGapMs = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      worstGapMs = Math.max(worstGapMs, now - last - 2);
      last = now;
    }, 2);
    last = performance.now();
    // Distinct maxChars so the plans are cold rather than cache hits.
    const results = await Promise.all(texts.map(text => tts.planChunksWithMeta(text, 3999)));
    clearInterval(ticker);
    assert.ok(results.every(chunks => chunks.length > 0), 'every plan produced chunks');
    assert.ok(worstGapMs < syncWallMs / 2,
      `event loop gap ${worstGapMs.toFixed(1)}ms should be far below the ${syncWallMs.toFixed(1)}ms the plans cost in-process`);
  });

  await test('concurrent identical requests share one worker plan and cache it', async () => {
    const tts = new ChunkedTTS('/tmp/test-cache');
    const text = longChapter(7, 12000);
    const before = ChunkedTTS.chunkPlanPoolStats().workerPlans;
    const results = await Promise.all([
      tts.planChunksWithMeta(text, 777),
      tts.planChunksWithMeta(text, 777),
      tts.planChunks(text, 777)
    ]);
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans - before, 1, 'three concurrent requests plan once');
    assert.deepStrictEqual(results[0], results[1]);
    assert.deepStrictEqual(results[2], results[0].map(chunk => chunk.text));
    results[0][0].text = 'mutated';
    results[0][0].segments.length = 0;
    const again = await tts.planChunksWithMeta(text, 777);
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans - before, 1, 'a cached plan skips the worker');
    assert.ok(again[0].text !== 'mutated' && again[0].segments.length > 0, 'cached plans are isolated from caller mutation');
    assert.deepStrictEqual(tts.splitIntoChunksWithMeta(text, 777), again, 'the sync path reads the same cache');
  });

  await test('retain:false plans skip the shared cache so sweeps cannot evict listener plans', async () => {
    const tts = new ChunkedTTS('/tmp/test-cache');
    const listenerText = longChapter(8, 8000);
    await tts.planChunksWithMeta(listenerText, 555);
    const before = ChunkedTTS.chunkPlanPoolStats().workerPlans;
    // A sweep far larger than the 64-entry LRU.
    for (let i = 0; i < 80; i++) {
      await tts.planChunksWithMeta(`Sweep paragraph ${i}. It has two sentences.`, 555, null, { retain: false });
    }
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans - before, 80, 'each sweep chapter plans once');
    await tts.planChunksWithMeta(listenerText, 555);
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans - before, 80, 'the listener plan is still cached after the sweep');
    const sweepText = 'Sweep paragraph 3. It has two sentences.';
    await tts.planChunksWithMeta(sweepText, 555);
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans - before, 81, 'a retain:false plan was not cached');
    await tts.planChunksWithMeta(sweepText, 555);
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans - before, 81, 'a retained plan is cached');
  });

  await test('falls back to in-process planning and logs once when workers cannot start', async () => {
    const logs = [];
    const pool = createChunkPlanPool({ size: 2, Worker: UnavailableWorker, log: message => logs.push(message) });
    const text = longChapter(9, 9000);
    const [first, second] = await Promise.all([pool.plan(text, 4000, 'ramp-v1'), pool.plan(text, 900, 'hybrid-v1')]);
    assert.deepStrictEqual(first, planSplitChunks(text, 4000, 'ramp-v1'));
    assert.deepStrictEqual(second, planSplitChunks(text, 900, 'hybrid-v1'));
    assert.strictEqual(logs.length, 1, `logs once: ${JSON.stringify(logs)}`);
    assert.match(logs[0], /\[chunk-plan\] worker threads unavailable/);
    assert.deepStrictEqual(pool.stats(), {
      workerPlans: 0, inProcessPlans: 2, workerFailures: 0, workers: 0, queued: 0, workersDisabled: true
    });
    await pool.close();
  });

  await test('a size of zero (XANDRIO_CHUNK_PLAN_WORKERS=0) plans in-process without logging', async () => {
    assert.strictEqual(defaultPoolSize({ XANDRIO_CHUNK_PLAN_WORKERS: '0' }), 0);
    assert.strictEqual(defaultPoolSize({ XANDRIO_CHUNK_PLAN_WORKERS: '3' }), 3);
    assert.ok(defaultPoolSize({}) >= 1 && defaultPoolSize({}) <= 2, 'default size is 1 or 2 workers');
    const logs = [];
    const pool = createChunkPlanPool({ size: 0, log: message => logs.push(message) });
    assert.deepStrictEqual(await pool.plan('Hello there. Bye now.', 4000, 'legacy-v1'), planSplitChunks('Hello there. Bye now.', 4000, 'legacy-v1'));
    assert.strictEqual(logs.length, 0);
    assert.strictEqual(pool.stats().inProcessPlans, 1);
    await pool.close();
  });

  await test('in-process fallback yields to the event loop between plans', async () => {
    let yields = 0;
    const pool = createChunkPlanPool({ size: 0, yieldFn: async () => { yields++; } });
    await Promise.all([pool.plan('One. Two.', 4000, 'legacy-v1'), pool.plan('Three. Four.', 4000, 'legacy-v1')]);
    assert.strictEqual(yields, 2);
    await pool.close();
  });

  await test('a worker that dies mid-plan finishes that plan in-process and disables workers after repeated failures', async () => {
    const logs = [];
    const pool = createChunkPlanPool({ size: 1, Worker: CrashingWorker, log: message => logs.push(message) });
    const text = 'A plan that survives its worker. It still completes.';
    const expected = planSplitChunks(text, 4000, 'legacy-v1');
    assert.deepStrictEqual(await pool.plan(text, 4000, 'legacy-v1'), expected);
    assert.deepStrictEqual(await pool.plan(text, 4000, 'legacy-v1'), expected);
    assert.strictEqual(logs.length, 0, 'two failures do not disable workers yet');
    assert.deepStrictEqual(await pool.plan(text, 4000, 'legacy-v1'), expected);
    assert.strictEqual(logs.length, 1, 'the third consecutive failure disables workers');
    assert.deepStrictEqual(await pool.plan(text, 4000, 'legacy-v1'), expected);
    const stats = pool.stats();
    assert.strictEqual(stats.workerFailures, 3);
    assert.strictEqual(stats.inProcessPlans, 4);
    assert.strictEqual(stats.workersDisabled, true);
    assert.strictEqual(logs.length, 1, 'later plans do not log again');
    await pool.close();
  });

  await test('a silent worker times out, is terminated, and its plan finishes in-process', async () => {
    const logs = [];
    const created = [];
    class TrackedSilentWorker extends SilentWorker {
      constructor() { super(); created.push(this); }
    }
    const pool = createChunkPlanPool({ size: 1, Worker: TrackedSilentWorker, jobTimeoutMs: 20, log: message => logs.push(message) });
    const text = 'Patience is a plan. It still completes.';
    const expected = planSplitChunks(text, 4000, 'legacy-v1');
    const started = performance.now();
    // Two identical requests through the pool must both settle.
    const [first, second] = await Promise.all([pool.plan(text, 4000, 'legacy-v1'), pool.plan(text, 4000, 'legacy-v1')]);
    assert.deepStrictEqual(first, expected);
    assert.deepStrictEqual(second, expected);
    assert.ok(performance.now() - started < 5000, 'the timeout settles the plan promptly');
    assert.strictEqual(created[0].terminated, 1, 'the stuck worker is terminated');
    const stats = pool.stats();
    assert.ok(stats.workerFailures >= 1, 'a timeout counts as a worker failure');
    assert.strictEqual(stats.inProcessPlans, 2);
    assert.strictEqual(stats.queued, 0);
    await pool.close();
  });

  await test('a messageerror is treated as a worker failure', async () => {
    const logs = [];
    const pool = createChunkPlanPool({ size: 1, Worker: GarbledWorker, log: message => logs.push(message) });
    const text = 'Garbled replies. Still answered.';
    const expected = planSplitChunks(text, 4000, 'legacy-v1');
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(await pool.plan(text, 4000, 'legacy-v1'), expected);
    assert.strictEqual(pool.stats().workerFailures, 3);
    assert.strictEqual(pool.stats().workersDisabled, true);
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0], /could not be decoded/);
    await pool.close();
  });

  await test('a worker error surfaces as a rejection without taking down the pool', async () => {
    const pool = createChunkPlanPool({ size: 1 });
    // The worker receives a non-string text; the planner coerces it, so this
    // only confirms the message path. A real error path is a bad policy
    // object that cannot be cloned.
    await assert.rejects(pool.plan(() => {}, 4000, 'legacy-v1'), /could not be cloned|DataCloneError/);
    assert.deepStrictEqual(await pool.plan('Still working. Yes.', 4000, 'legacy-v1'), planSplitChunks('Still working. Yes.', 4000, 'legacy-v1'));
    await pool.close();
  });

  await test('close() terminates workers and the module pool can be closed and reopened', async () => {
    const pool = createChunkPlanPool({ size: 2 });
    await Promise.all([pool.plan('One. Two.', 4000, 'legacy-v1'), pool.plan('Three. Four.', 4000, 'legacy-v1')]);
    assert.ok(pool.stats().workers >= 1);
    await pool.close();
    assert.strictEqual(pool.stats().workers, 0);
    // Plans after close still complete, in-process.
    assert.deepStrictEqual(await pool.plan('Five. Six.', 4000, 'legacy-v1'), planSplitChunks('Five. Six.', 4000, 'legacy-v1'));

    assert.ok(ChunkedTTS.chunkPlanPoolStats().workers >= 1, 'the module pool has live workers');
    await ChunkedTTS.closeChunkPlanPool();
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats(), null);
    const tts = new ChunkedTTS('/tmp/test-cache');
    assert.deepStrictEqual(await tts.planChunks('Reopened. Fine.', 4000), tts.splitIntoChunks('Reopened. Fine.', 4000));
    assert.strictEqual(ChunkedTTS.chunkPlanPoolStats().workerPlans, 1);
    await ChunkedTTS.closeChunkPlanPool();
  });

  console.log(`\nchunk-plan-pool tests: ${passed} passed, ${failed} failed`);
  // The pool must not hold the process open: no process.exit() here. If the
  // process hangs after this line, a worker is still referenced.
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
