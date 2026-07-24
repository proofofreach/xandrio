const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const PremiumAudioPrep = require('../lib/premium-audio');
const GenerationJournal = require('../lib/generation-journal');
const GenerationScheduler = require('../lib/generation-scheduler');

async function eventually(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before timeout');
}

async function run() {
  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}: ${err.stack || err.message}`);
    }
  };

  console.log('\nPremium Audio Prep Tests\n');

  await test('an interrupted book preparation is reconstructed after restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'premium-journal-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const never = new Promise(() => {});
    const common = {
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => 'chatterbox:test',
      getBookInfo: async () => ({ chapterCount: 2 }),
      chapterReady: async () => false,
      hasForegroundWork: () => false,
      isEngineUp: async () => true,
      stateStore: journal
    };

    const beforeRestart = new PremiumAudioPrep({
      ...common,
      prepareChapter: async () => never
    });
    beforeRestart.ensureBookPrep('book-1', 1);
    await eventually(async () => (await journal.list()).length === 1);

    const prepared = [];
    const afterRestart = new PremiumAudioPrep({
      ...common,
      prepareChapter: async (_bookId, chapterIndex) => { prepared.push(chapterIndex); }
    });
    const ready = new Promise(resolve => afterRestart.once('book:premium-ready', resolve));
    const restored = await afterRestart.restore();
    assert.strictEqual(restored.length, 1);
    await ready;
    assert.deepStrictEqual(prepared, [1, 0], 'restored work keeps listening-position order');
    assert.deepStrictEqual(await journal.list(), [], 'completed work leaves no stale recovery record');
  });

  await test('recovery trusts audio readiness instead of stale journal progress', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'premium-readiness-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.put({ bookId: 'book-2', variantKey: 'chatterbox:test', fromChapter: 1, status: 'generating' });
    const prepared = [];
    const prep = new PremiumAudioPrep({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => 'chatterbox:test',
      getBookInfo: async () => ({ chapterCount: 2 }),
      prepareChapter: async (_bookId, chapterIndex) => { prepared.push(chapterIndex); },
      chapterReady: async (_bookId, chapterIndex) => chapterIndex === 1,
      hasForegroundWork: () => false,
      isEngineUp: async () => true,
      stateStore: journal
    });
    const ready = new Promise(resolve => prep.once('book:premium-ready', resolve));
    await prep.restore();
    await ready;
    assert.deepStrictEqual(prepared, [0]);
  });

  await test('premium journal migrates legacy keys and preserves multiple voice variants', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'premium-variants-'));
    const file = path.join(dir, 'generation-state.json');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      jobs: {
        'legacy-book': {
          bookId: 'legacy-book', variantKey: 'chatterbox:legacy', fromChapter: 1, status: 'generating'
        }
      }
    }));
    const journal = new GenerationJournal(file);
    await journal.put({ bookId: 'same-book', variantKey: 'chatterbox:a', fromChapter: 0 });
    await journal.put({ bookId: 'same-book', variantKey: 'chatterbox:b', fromChapter: 2 });
    const records = await journal.list();
    assert.deepStrictEqual(
      records.map(record => `${record.bookId}:${record.variantKey}`).sort(),
      ['legacy-book:chatterbox:legacy', 'same-book:chatterbox:a', 'same-book:chatterbox:b']
    );
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.strictEqual(stored.jobs['legacy-book'], undefined, 'legacy book-only key is migrated');
    assert.strictEqual(Object.keys(stored.jobs).length, 3);
    await journal.remove('same-book', 'chatterbox:a');
    assert.deepStrictEqual(
      (await journal.list()).map(record => record.variantKey).sort(),
      ['chatterbox:b', 'chatterbox:legacy'],
      'clearing one premium variant preserves the others'
    );

    const prepared = [];
    const prep = new PremiumAudioPrep({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => 'chatterbox:b',
      getBookInfo: async () => ({ chapterCount: 1 }),
      prepareChapter: async (bookId, chapterIndex) => { prepared.push([bookId, chapterIndex]); },
      chapterReady: async () => false,
      isEngineUp: async () => true,
      stateStore: journal
    });
    const ready = new Promise(resolve => prep.once('book:premium-ready', resolve));
    const restored = await prep.restore();
    assert.strictEqual(restored.length, 1, 'active premium variant is recovered');
    await ready;
    assert.deepStrictEqual(prepared, [['same-book', 0]]);
    assert.deepStrictEqual(
      (await journal.list()).map(record => record.variantKey),
      [],
      'completed active variant clears while unsupported legacy variant leaves active recovery'
    );
    assert.deepStrictEqual(
      (await journal.listQuarantinedPremium()).map(record => record.variantKey),
      ['chatterbox:legacy'],
      'unsupported legacy variant is quarantined for diagnosis'
    );
  });

  await test('one restore pass starts and clears every persisted premium variant', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'premium-all-variants-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.put({ bookId: 'book-a', variantKey: 'chatterbox:a', fromChapter: 0 });
    await journal.put({ bookId: 'book-b', variantKey: 'chatterbox:b', fromChapter: 0 });
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    const prepared = [];
    let activeUiVariant = 'chatterbox:a';
    const workerDeps = variantKey => ({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => variantKey,
      getBookInfo: async () => ({ chapterCount: 1 }),
      prepareChapter: async (bookId, chapterIndex) => { prepared.push([variantKey, bookId, chapterIndex]); },
      chapterReady: async () => false,
      generationScheduler: scheduler,
      isEngineUp: async () => true,
      stateStore: journal
    });
    const prep = new PremiumAudioPrep({
      ...workerDeps('chatterbox:a'),
      variantKey: () => activeUiVariant,
      createVariantWorker: variantKey => workerDeps(variantKey)
    });
    const restored = await prep.restore();
    assert.strictEqual(restored.length, 2, 'both fixed variants start in one restore call');
    await eventually(async () => (await journal.list()).length === 0);
    assert.deepStrictEqual(prepared.sort(), [
      ['chatterbox:a', 'book-a', 0],
      ['chatterbox:b', 'book-b', 0]
    ]);
    assert.strictEqual(activeUiVariant, 'chatterbox:a', 'recovery does not switch active UI voice');
    assert.strictEqual(prep.variantWorkers.size, 1, 'inactive variant uses a fixed worker');
  });

  await test('recovery quarantines incompatible records and continues after malformed first record', async () => {
    const validVariant = 'chatterbox:valid:modelturbo:refcurrent';
    const records = [
      { bookId: 'bad-shape', variantKey: 'malformed', fromChapter: 0 },
      { bookId: 'old-mlx', variantKey: 'chatterbox:valid:modeloriginal8bit:refold', fromChapter: 0 },
      { bookId: 'valid-book', variantKey: validVariant, fromChapter: 0 }
    ];
    const quarantined = [];
    const errors = [];
    const store = {
      list: async () => records,
      put: async () => {},
      remove: async () => {},
      quarantinePremium: async (record, error) => quarantined.push([record.bookId, error.message])
    };
    const prep = new PremiumAudioPrep({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => validVariant,
      getBookInfo: async () => ({ chapterCount: 0 }),
      prepareChapter: async () => {},
      chapterReady: async () => true,
      isEngineUp: async () => true,
      stateStore: store,
      validateRecoveryRecord: async record => {
        if (!record.variantKey.startsWith('chatterbox:')) throw new Error('Malformed premium variant');
        return record.variantKey === validVariant
          ? { compatible: true }
          : { compatible: false, error: 'Recorded MLX/reference identity is incompatible with PyTorch/current reference' };
      }
    });
    prep.on('recovery:error', event => errors.push(event));
    const restored = await prep.restore();
    assert.strictEqual(restored.length, 1, 'valid record after malformed and incompatible records still restores');
    assert.deepStrictEqual(quarantined.map(item => item[0]), ['bad-shape', 'old-mlx']);
    assert.strictEqual(errors.length, 2, 'each rejected record emits its own recovery error');
  });

  await test('premium preparation yields to foreground GPU generation', async () => {
    const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
    let releaseForeground;
    const foregroundGate = new Promise(resolve => { releaseForeground = resolve; });
    const foreground = scheduler.run({ resource: 'gpu', priority: 'immediate' }, () => foregroundGate);
    await new Promise(resolve => setImmediate(resolve));

    let prepared = false;
    const prep = new PremiumAudioPrep({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => 'chatterbox:test',
      getBookInfo: async () => ({ chapterCount: 1 }),
      prepareChapter: async () => { prepared = true; },
      chapterReady: async () => false,
      generationScheduler: scheduler,
      isEngineUp: async () => true
    });
    const ready = new Promise(resolve => prep.once('book:premium-ready', resolve));
    prep.ensureBookPrep('book-3', 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(prepared, false);
    releaseForeground();
    await foreground;
    await ready;
    assert.strictEqual(prepared, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
