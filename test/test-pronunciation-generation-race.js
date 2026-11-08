/**
 * A pronunciation repair that lands while a first-time generation is between
 * its narration-text transform and its manifest install must not let that
 * generation publish a plan built from the old pronunciation.
 *
 * Run:  node test/test-pronunciation-generation-race.js
 */

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const ChunkedTTS = require('../lib/chunked-tts');
const { createPronunciationService, createCacheInvalidator } = require('../lib/pronunciation-repair');

class RecordingQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.counter = 0;
  }
  async enqueue(job) {
    const id = `job-${this.counter++}`;
    this.jobs.set(id, { ...job, id, status: 'queued' });
    return id;
  }
  getStatus(id) {
    const job = this.jobs.get(id);
    return job ? { status: job.status } : null;
  }
  claim() { return true; }
  prioritize() { return true; }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    job.status = 'cancelled';
    return true;
  }
  waitFor() { return Promise.resolve(); }
}

function memoryJsonStore() {
  const files = new Map();
  return {
    async load(file, fallback) { return JSON.parse(JSON.stringify(files.get(file) ?? fallback)); },
    async update(file, mutate, fallback) {
      const value = JSON.parse(JSON.stringify(files.get(file) ?? fallback));
      await mutate(value);
      files.set(file, value);
      return value;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function setup(cacheDir) {
  const queue = new RecordingQueue();
  const jsonStore = memoryJsonStore();
  let service = null;
  let gate = null;
  let transformRead = null;
  const tts = new ChunkedTTS(cacheDir, queue, {
    variantKeyProvider: () => 'race-v1',
    textTransform: async ({ text, bookId }) => {
      // Read the rules first, then stall, like a slow store read or a busy
      // event loop between the read and the plan.
      const transformed = await service.apply(text, bookId);
      transformRead?.resolve();
      if (gate) await gate.promise;
      return transformed;
    }
  });
  tts._fileExists = async () => false;
  const chapterText = 'The Xandrio narrator reads this sentence aloud.';
  service = createPronunciationService({
    storeFile: path.join(cacheDir, 'pronunciations.json'),
    jsonStore,
    loadBooks: async () => ({ 'race-book': { path: 'race.epub' } }),
    getChapters: async () => [{ text: chapterText }],
    splitIntoChunks: text => tts.planChunks(text, tts.getActiveChunkSize(), null, { retain: false }),
    beforeInvalidate: affected => Promise.all(affected.map(item =>
      tts.quiesceChapterAllVariants(item.bookId, item.chapterIndex, item.fromChunkIndexByVariant, 0))),
    invalidateCache: createCacheInvalidator(cacheDir)
  });
  return {
    queue, tts, service, chapterText,
    hold() { gate = deferred(); transformRead = deferred(); return { gate, transformRead }; }
  };
}

async function testRepairDuringFirstGeneration() {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-pron-race-'));
  try {
    const { queue, tts, service, chapterText, hold } = await setup(cacheDir);
    const { gate, transformRead } = hold();
    const generation = tts.generateChapter('race-book', 0, chapterText, 'en', 'immediate', { requestId: 'listener-1' });
    await transformRead.promise;
    // No manifest exists yet, so the repair's quiesce has nothing to stop.
    assert.strictEqual(tts.getChapterManifest('race-book', 0), null);
    await service.create({ scope: 'global', input: { source: 'Xandrio', replacement: 'Zandreeo' } });
    gate.resolve();
    const outcome = await generation.then(manifest => ({ manifest }), error => ({ error }));

    const staleJobs = [...queue.jobs.values()].filter(job => /Xandrio/.test(job.text));
    assert.deepStrictEqual(staleJobs.map(job => job.text), [],
      'No narration job is enqueued with the pre-repair pronunciation');
    const installed = tts.getChapterManifest('race-book', 0);
    const plannedText = (installed?._generation?.chunkTexts || []).join(' ');
    assert.ok(!/Xandrio/.test(plannedText), 'No manifest is installed from the pre-repair pronunciation');
    if (outcome.error) {
      assert.strictEqual(outcome.error.name, 'AbortError', 'The stale generation is retired, not failed');
    }
    const hashPath = tts._chapterHashPath('race-book', 0);
    const storedHash = await fs.readFile(hashPath, 'utf8').catch(() => null);
    const stalePlan = await tts.planChunks(chapterText, tts.getActiveChunkSize(), null, { retain: false });
    const crypto = require('crypto');
    const staleHash = crypto.createHash('sha1').update(stalePlan.join('\u0000')).digest('hex').slice(0, 12);
    assert.notStrictEqual(storedHash, staleHash, 'The chapter text hash is not rewritten to the pre-repair text');

    // A later request narrates the repaired text.
    const fresh = await tts.generateChapter('race-book', 0, chapterText, 'en', 'immediate', { requestId: 'listener-2' });
    assert.ok(fresh._generation.chunkTexts.join(' ').includes('Zandreeo'), 'A new request uses the repaired pronunciation');
    console.log('  ok repair during a first-time generation retires the stale plan');
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

async function testRepairDuringManifestReconstruction() {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-pron-reconstruct-'));
  try {
    const { tts, service, chapterText, hold } = await setup(cacheDir);
    const { gate, transformRead } = hold();
    const reconstruction = tts.reconstructChapterManifest('race-book', 0, chapterText, 'en');
    await transformRead.promise;
    await service.create({ scope: 'global', input: { source: 'Xandrio', replacement: 'Zandreeo' } });
    gate.resolve();
    const manifest = await reconstruction;
    const hash = (await fs.readFile(tts._chapterHashPath('race-book', 0), 'utf8')).trim();
    const repaired = await tts.planChunks(await service.apply(chapterText, 'race-book'), tts.getActiveChunkSize(), null, { retain: false });
    const crypto = require('crypto');
    const repairedHash = crypto.createHash('sha1').update(repaired.join('\u0000')).digest('hex').slice(0, 12);
    assert.strictEqual(hash, repairedHash, 'Reconstruction records the repaired chapter text hash');
    assert.strictEqual(manifest.totalChunks, repaired.length);
    assert.strictEqual(tts.getChapterManifest('race-book', 0), manifest);
    console.log('  ok repair during manifest reconstruction replans with the repaired text');
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

(async () => {
  await testRepairDuringFirstGeneration();
  await testRepairDuringManifestReconstruction();
  console.log('Pronunciation generation race tests: 2 passed, 0 failed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
