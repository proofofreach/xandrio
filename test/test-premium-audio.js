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

  await test('stopping a title durably removes every premium variant', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'premium-stop-title-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.put({ bookId: 'delete-me', variantKey: 'chatterbox:a', fromChapter: 0 });
    await journal.put({ bookId: 'delete-me', variantKey: 'chatterbox:b', fromChapter: 1 });
    await journal.put({ bookId: 'keep-me', variantKey: 'chatterbox:a', fromChapter: 0 });
    const prep = new PremiumAudioPrep({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => 'chatterbox:a',
      getBookInfo: async () => ({ chapterCount: 0 }),
      prepareChapter: async () => {},
      chapterReady: async () => true,
      isEngineUp: async () => true,
      stateStore: journal
    });

    await prep.stopBook('delete-me');

    assert.deepStrictEqual(
      (await journal.list()).map(record => [record.bookId, record.variantKey]),
      [['keep-me', 'chatterbox:a']]
    );
  });

  await test('a stopped premium worker cannot recreate deleted intent after an await', async () => {
    let resolvePreparation;
    let preparationStarted;
    let stopped = false;
    const events = [];
    const preparationGate = new Promise(resolve => {
      resolvePreparation = resolve;
    });
    const started = new Promise(resolve => {
      preparationStarted = resolve;
    });
    const store = {
      put: async record => {
        events.push(`put:${record.bookId}:${stopped ? 'after-stop' : 'before-stop'}`);
      },
      remove: async () => {},
      removePremiumForBook: async bookId => {
        stopped = true;
        events.push(`remove:${bookId}`);
      }
    };
    const prep = new PremiumAudioPrep({
      isEnabled: () => true,
      isPremiumActive: () => true,
      variantKey: () => 'chatterbox:test',
      getBookInfo: async () => ({ chapterCount: 1 }),
      prepareChapter: async () => {
        preparationStarted();
        await preparationGate;
      },
      chapterReady: async () => false,
      isEngineUp: async () => true,
      stateStore: store
    });
    prep.ensureBookPrep('delete-me', 0);
    await started;

    await prep.stopBook('delete-me');
    resolvePreparation();
    await new Promise(resolve => setImmediate(resolve));

    assert(!events.includes('put:delete-me:after-stop'));
    assert.deepStrictEqual(events.slice(-1), ['remove:delete-me']);
  });

  await test('startup migration drops only unowned speculative chapter work', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-migration-'));
    const file = path.join(dir, 'generation-state.json');
    const completedAudio = path.join(dir, 'completed.mp3');
    await fs.writeFile(completedAudio, 'already rendered');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      jobs: {
        premium: {
          bookId: 'premium-book',
          variantKey: 'chatterbox:test',
          fromChapter: 1,
          status: 'generating'
        }
      },
      chapterJobs: {
        legacy: {
          bookId: 'legacy-book',
          chapterIndex: 4,
          variantKey: 'kokoro:test',
          text: 'legacy speculative work'
        },
        explicit: {
          bookId: 'download-book',
          chapterIndex: 2,
          variantKey: 'kokoro:test',
          text: 'explicit download work',
          origin: 'offline-download'
        },
        speculative: {
          bookId: 'playing-book',
          chapterIndex: 5,
          variantKey: 'kokoro:test',
          text: 'obsolete session look-ahead',
          origin: 'playback-lookahead'
        }
      },
      quarantinedChapterJobs: {
        quarantined: {
          bookId: 'broken-book',
          chapterIndex: 0,
          variantKey: 'kokoro:test',
          text: 'keep for diagnosis'
        }
      },
      offlinePreparations: {
        'download-book': {
          bookId: 'download-book',
          totalChapters: 8,
          requestedAt: 123
        }
      }
    }));

    const journal = new GenerationJournal(file);
    const report = await journal.discardLegacySpeculativeChapters();

    assert.deepStrictEqual(report, {
      applied: true,
      discarded: 2,
      preserved: 1,
      discardedBookIds: ['legacy-book', 'playing-book']
    });
    assert.deepStrictEqual((await journal.listChapters()).map(job => job.bookId), ['download-book']);
    assert.deepStrictEqual((await journal.list()).map(job => job.bookId), ['premium-book']);
    assert.deepStrictEqual(
      (await journal.listOfflinePreparations()).map(record => record.bookId),
      ['download-book']
    );
    assert.deepStrictEqual(
      (await journal.listQuarantinedChapters()).map(record => record.bookId),
      ['broken-book']
    );
    assert.strictEqual(await fs.readFile(completedAudio, 'utf8'), 'already rendered');
    assert.deepStrictEqual(await journal.discardLegacySpeculativeChapters(), {
      applied: false,
      discarded: 0,
      preserved: 1,
      discardedBookIds: ['legacy-book', 'playing-book']
    });
    await journal.acknowledgeBookMetadataResets(['legacy-book', 'playing-book']);
    assert.deepStrictEqual(await journal.discardLegacySpeculativeChapters(), {
      applied: false,
      discarded: 0,
      preserved: 1,
      discardedBookIds: []
    });

    await journal.putChapter({
      bookId: 'later-playback',
      chapterIndex: 1,
      variantKey: 'kokoro:test',
      text: 'session ended before restart',
      priority: 'lookahead',
      origin: 'playback-lookahead',
      sessionId: 'expired-session'
    });
    await journal.putChapter({
      bookId: 'later-download',
      chapterIndex: 1,
      variantKey: 'kokoro:test',
      text: 'explicit work survives restart',
      priority: 'download',
      origin: 'offline-download',
      requestId: 'durable-download'
    });
    await journal.putChapter({
      bookId: 'later-shared',
      chapterIndex: 1,
      variantKey: 'kokoro:test',
      text: 'shared generation survives for its durable owner',
      priority: 'immediate',
      origin: 'playback-current'
    });
    await journal.addChapterClaim({
      bookId: 'later-shared',
      chapterIndex: 1,
      variantKey: 'kokoro:test',
      priority: 'download',
      origin: 'offline-download',
      requestId: 'shared-download'
    });
    await journal.putChapter({
      bookId: 'later-import',
      chapterIndex: 0,
      variantKey: 'kokoro:test',
      text: 'interrupted import warm-up',
      priority: 'background',
      origin: 'import-warmup'
    });
    assert.deepStrictEqual(await journal.discardLegacySpeculativeChapters(), {
      applied: false,
      discarded: 3,
      preserved: 3,
      discardedBookIds: ['later-import']
    });
    assert.deepStrictEqual(
      (await journal.listChapters()).map(job => job.bookId).sort(),
      ['download-book', 'later-download', 'later-shared']
    );
    assert.strictEqual(
      (await journal.listChapters()).find(job => job.bookId === 'later-shared').origin,
      'offline-download'
    );
    assert.deepStrictEqual(
      (await journal.discardLegacySpeculativeChapters()).discardedBookIds,
      ['later-import'],
      'a crash before book metadata reset retains the reset work for the next start'
    );
    await journal.acknowledgeBookMetadataResets(['later-import']);
  });

  await test('discarding a download request preserves unrelated generation intents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-cancel-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const chapter = (bookId, chapterIndex, requestId) => ({
      bookId,
      chapterIndex,
      variantKey: 'kokoro:test',
      text: 'chapter text',
      priority: 'download',
      origin: 'offline-download',
      requestId
    });
    await journal.putChapter(chapter('cancelled-book', 0, 'cancelled-request'));
    await journal.putChapter(chapter('other-book', 1, 'other-request'));
    await journal.putOfflinePreparation({
      bookId: 'cancelled-book',
      totalChapters: 2,
      requestedAt: 123,
      requestId: 'cancelled-request',
      state: 'paused'
    });

    const removed = await journal.removeChaptersForRequest('cancelled-request');

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual((await journal.listChapters()).map(job => job.bookId), ['other-book']);
    assert.strictEqual(
      (await journal.getOfflinePreparation('cancelled-book')).requestId,
      'cancelled-request',
      'pausing generation must preserve the explicit title-download intent'
    );
  });

  await test('discarding one owner preserves a shared chapter generation intent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-shared-claim-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.putChapter({
      bookId: 'shared-book',
      chapterIndex: 2,
      variantKey: 'voice-a',
      text: 'chapter text',
      priority: 'lookahead',
      origin: 'playback-lookahead',
      sessionId: 'reader-a'
    });
    await journal.addChapterClaim({
      bookId: 'shared-book',
      chapterIndex: 2,
      variantKey: 'voice-a',
      priority: 'download',
      origin: 'offline-download',
      requestId: 'download-a'
    });

    assert.strictEqual(await journal.removeChaptersByIntent({
      bookId: 'shared-book',
      variantKey: 'voice-a',
      origin: 'playback-lookahead',
      chapterIndexes: [2]
    }), 0);
    const [retained] = await journal.listChapters();
    assert.strictEqual(retained.origin, 'offline-download');
    assert.strictEqual(retained.requestId, 'download-a');
    assert.strictEqual(retained.claims.length, 1);

    assert.strictEqual(await journal.removeChaptersForRequest('download-a'), 1);
    assert.deepStrictEqual(await journal.listChapters(), []);
  });

  await test('retiring a look-ahead window removes only matching speculative chapters', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-lookahead-retire-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const chapter = (chapterIndex, origin) => ({
      bookId: 'window-book',
      chapterIndex,
      variantKey: 'voice-a',
      text: 'chapter text',
      priority: origin === 'playback-lookahead' ? 'lookahead' : 'download',
      origin,
      requestId: origin === 'offline-download' ? 'download-request' : null
    });
    await journal.putChapter(chapter(1, 'playback-lookahead'));
    await journal.putChapter(chapter(2, 'playback-lookahead'));
    await journal.putChapter(chapter(3, 'offline-download'));

    const removed = await journal.removeChaptersByIntent({
      bookId: 'window-book',
      variantKey: 'voice-a',
      origin: 'playback-lookahead',
      chapterIndexes: [1]
    });

    assert.strictEqual(removed, 1);
    assert.deepStrictEqual(
      (await journal.listChapters()).map(job => [job.chapterIndex, job.origin]),
      [[2, 'playback-lookahead'], [3, 'offline-download']]
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
