const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const GenerationJournal = require('../lib/generation-journal');
const { createOfflinePreparationCoordinator } = require('../lib/offline-preparation-coordinator');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function eventually(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition was not met before timeout');
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

(async () => {
  await test('a durable title download materializes only one chapter at a time', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-coordinator-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gates = [deferred(), deferred(), deferred()];
    const ready = new Set();
    const started = [];
    let active = 0;
    let maximum = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}, {}, {}]
      }),
      chapterStatus: async ({ chapterIndex }) => ({
        ready: ready.has(chapterIndex),
        totalChunks: 1,
        readyChunks: ready.has(chapterIndex) ? 1 : 0,
        errorChunks: 0
      }),
      prepareChapter: async request => {
        started.push(request);
        active += 1;
        maximum = Math.max(maximum, active);
        await gates[request.chapterIndex].promise;
        ready.add(request.chapterIndex);
        active -= 1;
      }
    });

    const initial = await coordinator.request('book-1');
    assert.strictEqual(initial.state, 'preparing');
    await eventually(() => started.length === 1);
    assert.deepStrictEqual(started.map(request => request.chapterIndex), [0]);

    gates[0].resolve();
    await eventually(() => started.length === 2);
    assert.deepStrictEqual(started.map(request => request.chapterIndex), [0, 1]);
    gates[1].resolve();
    await eventually(() => started.length === 3);
    assert.deepStrictEqual(started.map(request => request.chapterIndex), [0, 1, 2]);
    gates[2].resolve();
    await coordinator.waitForIdle('book-1');

    assert.strictEqual(maximum, 1);
    assert(started.every(request => request.priority === 'download'));
    assert(started.every(request => request.origin === 'offline-download'));
    assert.strictEqual((await coordinator.status('book-1')).state, 'ready');
    assert.strictEqual((await journal.getOfflinePreparation('book-1')).nextChapter, 3);
  });

  await test('empty structural chapters do not abort full-title preparation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-empty-chapter-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const ready = new Set();
    const started = [];
    const chapters = [
      { title: 'Introduction' },
      { title: 'Part One', type: 'divider', empty: true },
      { title: 'Chapter One' }
    ];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters
      }),
      shouldPrepareChapter: ({ chapter }) => !chapter.empty,
      chapterStatus: async ({ chapterIndex }) => ({
        ready: ready.has(chapterIndex),
        totalChunks: 1,
        readyChunks: ready.has(chapterIndex) ? 1 : 0,
        errorChunks: 0
      }),
      prepareChapter: async ({ chapterIndex }) => {
        if (chapterIndex === 1) throw new Error('Chapter has no speakable text for TTS');
        started.push(chapterIndex);
        ready.add(chapterIndex);
      }
    });

    await coordinator.request('book-with-divider');
    await coordinator.waitForIdle('book-with-divider');

    assert.deepStrictEqual(started, [0, 2]);
    const record = await journal.getOfflinePreparation('book-with-divider');
    assert.strictEqual(record.state, 'ready');
    assert.strictEqual(record.readyChapters, chapters.length);
    assert.strictEqual(record.nextChapter, chapters.length);
  });

  await test('ready means every compact package exists and reports its exact byte total', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-package-ready-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const packaged = new Map();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      preparationIdentity: () => ({
        packageVariantKey: 'voice-a:offline-mp3-v1:br48k',
        bitrateKbps: 48
      }),
      getBookChapters: async bookId => ({
        book: { id: bookId, title: 'Compact Book' },
        chapters: [{}, {}]
      }),
      chapterStatus: async ({ chapterIndex }) => ({
        ready: packaged.has(chapterIndex),
        size: packaged.get(chapterIndex) || 0,
        variantKey: 'voice-a:offline-mp3-v1:br48k'
      }),
      prepareChapter: async ({ chapterIndex }) => {
        packaged.set(chapterIndex, chapterIndex === 0 ? 1200 : 1800);
      }
    });

    await coordinator.request('book-package');
    await coordinator.waitForIdle('book-package');
    const status = await coordinator.status('book-package');

    assert.strictEqual(status.state, 'ready');
    assert.strictEqual(status.bytesPrepared, 3000);
    assert.strictEqual(status.bytesTotal, 3000);
    assert.strictEqual(status.bitrateKbps, 48);
    assert.strictEqual(status.packageVariantKey, 'voice-a:offline-mp3-v1:br48k');
  });

  await test('a second device reuses ready server audio without downgrading or notifying again', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-ready-reuse-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    let prepared = false;
    let prepareCalls = 0;
    let readyNotifications = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      preparationIdentity: () => ({
        packageVariantKey: 'voice-a:offline-mp3-v1:br48k',
        sourceVariantKey: 'voice-a',
        sourceVoice: 'voice-a',
        sourceChunkSize: 4000,
        bitrateKbps: 48
      }),
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({
        ready: prepared,
        size: prepared ? 480 : 0,
        totalChunks: 1,
        readyChunks: prepared ? 1 : 0,
        errorChunks: 0
      }),
      prepareChapter: async () => {
        prepareCalls += 1;
        prepared = true;
      },
      onReady: async () => { readyNotifications += 1; }
    });

    await coordinator.request('shared-ready', { ownerId: 'account:device-a' });
    await coordinator.waitForIdle('shared-ready');
    assert.strictEqual((await coordinator.status('shared-ready')).state, 'ready');

    const persistedStates = [];
    const putOfflinePreparation = journal.putOfflinePreparation.bind(journal);
    journal.putOfflinePreparation = async record => {
      persistedStates.push(record.state);
      return putOfflinePreparation(record);
    };

    const secondStatus = await coordinator.request('shared-ready', {
      ownerId: 'account:device-b'
    });
    assert.strictEqual(secondStatus.state, 'ready');
    await coordinator.waitForIdle('shared-ready');

    const record = await journal.getOfflinePreparation('shared-ready');
    assert.strictEqual(record.state, 'ready');
    assert.deepStrictEqual(record.owners, ['account:device-a', 'account:device-b']);
    assert(!persistedStates.includes('preparing'));
    assert.strictEqual(prepareCalls, 1);
    assert.strictEqual(readyNotifications, 1);

    prepared = false;
    await coordinator.request('shared-ready', { ownerId: 'account:device-c' });
    await coordinator.waitForIdle('shared-ready');
    assert.strictEqual(prepareCalls, 2);
    assert.strictEqual(readyNotifications, 2);
  });

  await test('ready multi-chapter repair advances once across chapter-boundary contention', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-ready-repair-yield-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.putOfflinePreparation({
      bookId: 'ready-book',
      requestId: 'ready-request',
      state: 'ready',
      totalChapters: 3,
      nextChapter: 3,
      readyChapters: 3,
      preparedBytes: 60
    });
    const repairGate = deferred();
    const waitingGate = deferred();
    const repairChecks = [];
    const started = [];
    let blockedRepair = false;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      maxTrackedTitles: 3,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: bookId === 'ready-book' ? [{}, {}, {}] : [{}]
      }),
      chapterStatus: async ({ bookId, chapterIndex }) => {
        if (bookId === 'ready-book') {
          repairChecks.push(chapterIndex);
          if (chapterIndex === 0 && !blockedRepair) {
            blockedRepair = true;
            await repairGate.promise;
          }
          return { ready: true, size: 20, totalChunks: 1, readyChunks: 1 };
        }
        return {
          ready: started.includes(bookId),
          size: started.includes(bookId) ? 20 : 0,
          totalChunks: 1,
          readyChunks: started.includes(bookId) ? 1 : 0
        };
      },
      prepareChapter: async ({ bookId }) => {
        started.push(bookId);
        await waitingGate.promise;
      }
    });

    const readyRequest = coordinator.request('ready-book');
    await eventually(() => blockedRepair);
    await readyRequest;
    await coordinator.request('waiting-book');
    repairGate.resolve();
    await eventually(() => started.includes('waiting-book'));
    waitingGate.resolve();
    await Promise.all([
      coordinator.waitForIdle('ready-book'),
      coordinator.waitForIdle('waiting-book')
    ]);

    assert.strictEqual(repairChecks.filter(chapterIndex => chapterIndex === 0).length, 1);
    assert(repairChecks.includes(1));
    assert.strictEqual((await journal.getOfflinePreparation('ready-book')).state, 'ready');
  });

  await test('a preparation failure retains the failing chapter cursor', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-error-cursor-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const ready = new Set();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}, {}, {}]
      }),
      chapterStatus: async ({ chapterIndex }) => ({
        ready: ready.has(chapterIndex),
        totalChunks: 1,
        readyChunks: ready.has(chapterIndex) ? 1 : 0,
        errorChunks: 0
      }),
      prepareChapter: async ({ chapterIndex }) => {
        if (chapterIndex === 1) throw new Error('generation failed');
        ready.add(chapterIndex);
      }
    });

    await coordinator.request('book-error-cursor');
    await coordinator.waitForIdle('book-error-cursor');

    const record = await journal.getOfflinePreparation('book-error-cursor');
    assert.strictEqual(record.state, 'error');
    assert.strictEqual(record.readyChapters, 1);
    assert.strictEqual(record.nextChapter, 1);
  });

  await test('two titles can prepare concurrently without admitting a third', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-title-capacity-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gates = new Map([
      ['book-a', deferred()],
      ['book-b', deferred()],
      ['book-c', deferred()]
    ]);
    const ready = new Set();
    const started = [];
    let active = 0;
    let maximum = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 2,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async ({ bookId }) => ({
        ready: ready.has(bookId),
        totalChunks: 1,
        readyChunks: ready.has(bookId) ? 1 : 0,
        errorChunks: 0
      }),
      prepareChapter: async ({ bookId }) => {
        started.push(bookId);
        active += 1;
        maximum = Math.max(maximum, active);
        await gates.get(bookId).promise;
        ready.add(bookId);
        active -= 1;
      }
    });

    await coordinator.request('book-a');
    await coordinator.request('book-b');
    await coordinator.request('book-c');
    await eventually(() => started.length === 2);
    assert.deepStrictEqual(new Set(started), new Set(['book-a', 'book-b']));
    assert.strictEqual(maximum, 2);

    gates.get('book-a').resolve();
    await eventually(() => started.includes('book-c'));
    gates.get('book-b').resolve();
    gates.get('book-c').resolve();
    await Promise.all([
      coordinator.waitForIdle('book-a'),
      coordinator.waitForIdle('book-b'),
      coordinator.waitForIdle('book-c')
    ]);
    assert.strictEqual(maximum, 2);
  });

  await test('default admission starts every bounded tracked title without whole-book blocking', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-default-admission-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gates = new Map([
      ['book-a', deferred()],
      ['book-b', deferred()],
      ['book-c', deferred()]
    ]);
    const ready = new Set();
    const started = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}] }),
      chapterStatus: async ({ bookId }) => ({
        ready: ready.has(bookId),
        totalChunks: 1,
        readyChunks: ready.has(bookId) ? 1 : 0
      }),
      prepareChapter: async ({ bookId }) => {
        started.push(bookId);
        await gates.get(bookId).promise;
        ready.add(bookId);
      }
    });

    await Promise.all([
      coordinator.request('book-a'),
      coordinator.request('book-b'),
      coordinator.request('book-c')
    ]);
    await eventually(() => started.length === 3);
    assert.deepStrictEqual(new Set(started), new Set(['book-a', 'book-b', 'book-c']));

    for (const gate of gates.values()) gate.resolve();
    await Promise.all([...gates.keys()].map(bookId => coordinator.waitForIdle(bookId)));
  });

  await test('title deletion cannot recreate a removed preparation intent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-delete-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    let started = false;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => {
        started = true;
        await gate.promise;
      }
    });

    await coordinator.request('book-delete');
    await eventually(() => started);
    await coordinator.cancel('book-delete', { remove: true });
    gate.resolve();
    await coordinator.waitForIdle('book-delete');

    assert.strictEqual(await journal.getOfflinePreparation('book-delete'), null);
  });

  await test('a new request after removal waits for the cancelled worker and then starts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-remove-rerequest-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gates = [deferred(), deferred()];
    let ready = false;
    let prepareCalls = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}] }),
      chapterStatus: async () => ({
        ready,
        size: ready ? 20 : 0,
        totalChunks: 1,
        readyChunks: ready ? 1 : 0
      }),
      prepareChapter: async () => {
        const call = prepareCalls;
        prepareCalls += 1;
        await gates[call].promise;
        if (call === 1) ready = true;
      }
    });

    await coordinator.request('book-rerequest');
    await eventually(() => prepareCalls === 1);
    await coordinator.cancel('book-rerequest', { remove: true });
    await coordinator.request('book-rerequest');
    gates[0].resolve();
    await eventually(() => prepareCalls === 2);
    gates[1].resolve();
    await coordinator.waitForIdle('book-rerequest');

    assert.strictEqual((await coordinator.status('book-rerequest')).state, 'ready');
  });

  await test('pausing a title cancels and discards only that download request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-pause-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    const cancelled = [];
    const discarded = [];
    let started = false;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => {
        started = true;
        await gate.promise;
      },
      cancelRequest: requestId => cancelled.push(requestId),
      discardRequest: async requestId => discarded.push(requestId),
      createRequestId: () => 'download-request'
    });

    await coordinator.request('book-pause');
    await eventually(() => started);
    await coordinator.cancel('book-pause');

    assert.deepStrictEqual(cancelled, ['download-request']);
    assert.deepStrictEqual(discarded, ['download-request']);
    assert.strictEqual((await journal.getOfflinePreparation('book-pause')).state, 'paused');

    gate.resolve();
    await coordinator.waitForIdle('book-pause');
    assert.strictEqual(
      (await journal.getOfflinePreparation('book-pause')).state,
      'paused',
      'an in-flight final chapter cannot overwrite a pause with ready'
    );
  });

  await test('resuming while an old worker settles starts a fresh request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-resume-race-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gates = [deferred(), deferred()];
    const requestIds = [];
    const ready = new Set();
    let requestSequence = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({
        ready: ready.has('book-resume'),
        totalChunks: 1,
        readyChunks: ready.has('book-resume') ? 1 : 0
      }),
      prepareChapter: async request => {
        const call = requestIds.length;
        requestIds.push(request.requestId);
        await gates[call].promise;
        if (call === 1) ready.add(request.bookId);
      },
      createRequestId: () => `request-${++requestSequence}`
    });

    await coordinator.request('book-resume');
    await eventually(() => requestIds.length === 1);
    await coordinator.cancel('book-resume');
    await coordinator.request('book-resume');
    assert.strictEqual((await journal.getOfflinePreparation('book-resume')).requestId, 'request-2');

    gates[0].resolve();
    await eventually(() => requestIds.length === 2);
    gates[1].resolve();
    await coordinator.waitForIdle('book-resume');

    const record = await journal.getOfflinePreparation('book-resume');
    assert.deepStrictEqual(requestIds, ['request-1', 'request-2']);
    assert.strictEqual(record.requestId, 'request-2');
    assert.strictEqual(record.state, 'ready');
  });

  await test('resume preserves durable progress and continues at the saved chapter', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-resume-progress-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.putOfflinePreparation({
      bookId: 'book-progress',
      requestId: 'old-request',
      state: 'paused',
      totalChapters: 3,
      nextChapter: 2,
      readyChapters: 2,
      preparedBytes: 300,
      packageVariantKey: 'voice-a:offline',
      owners: []
    });
    const checked = [];
    let finalReady = false;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      preparationIdentity: () => ({ packageVariantKey: 'voice-a:offline' }),
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}, {}, {}]
      }),
      chapterStatus: async ({ chapterIndex }) => {
        checked.push(chapterIndex);
        return {
          ready: chapterIndex < 2 || finalReady,
          size: chapterIndex === 2 && finalReady ? 100 : 0,
          totalChunks: 1,
          readyChunks: chapterIndex < 2 || finalReady ? 1 : 0
        };
      },
      prepareChapter: async ({ chapterIndex }) => {
        assert.strictEqual(chapterIndex, 2);
        finalReady = true;
      },
      createRequestId: () => 'new-request'
    });

    await coordinator.request('book-progress', { ownerId: 'account:device' });
    await coordinator.waitForIdle('book-progress');
    const record = await journal.getOfflinePreparation('book-progress');

    assert(checked.every(chapterIndex => chapterIndex === 2));
    assert.strictEqual(record.requestId, 'new-request');
    assert.strictEqual(record.readyChapters, 3);
    assert.strictEqual(record.preparedBytes, 400);
    assert.strictEqual(record.state, 'ready');
  });

  await test('a package identity change is the only resume path that resets progress', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-variant-reset-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.putOfflinePreparation({
      bookId: 'book-variant-reset',
      requestId: 'old-request',
      state: 'paused',
      totalChapters: 2,
      nextChapter: 1,
      readyChapters: 1,
      preparedBytes: 100,
      packageVariantKey: 'voice-a:offline'
    });
    const checked = [];
    const ready = new Set();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      preparationIdentity: () => ({ packageVariantKey: 'voice-b:offline' }),
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}, {}] }),
      chapterStatus: async ({ chapterIndex }) => {
        checked.push(chapterIndex);
        return { ready: ready.has(chapterIndex), size: ready.has(chapterIndex) ? 100 : 0 };
      },
      prepareChapter: async ({ chapterIndex }) => ready.add(chapterIndex),
      createRequestId: () => 'new-request'
    });

    await coordinator.request('book-variant-reset');
    await coordinator.waitForIdle('book-variant-reset');
    assert(checked.includes(0));
    const record = await journal.getOfflinePreparation('book-variant-reset');
    assert.strictEqual(record.readyChapters, 2);
    assert.strictEqual(record.preparedBytes, 200);
    assert.strictEqual(record.packageVariantKey, 'voice-b:offline');
  });

  await test('startup recovery migrates an in-progress legacy package before resuming', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-restore-package-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.putOfflinePreparation({
      bookId: 'legacy-package',
      requestId: 'legacy-request',
      state: 'preparing',
      totalChapters: 2,
      nextChapter: 1,
      readyChapters: 1,
      preparedBytes: 999,
      owners: ['account:device']
    });
    const prepared = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      preparationIdentity: () => ({
        packageVariantKey: 'voice-a:offline-mp3-v1:br48k',
        bitrateKbps: 48
      }),
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}, {}]
      }),
      chapterStatus: async ({ chapterIndex }) => ({
        ready: prepared.includes(chapterIndex),
        size: prepared.includes(chapterIndex) ? 480 : 0,
        variantKey: 'voice-a:offline-mp3-v1:br48k'
      }),
      prepareChapter: async ({ chapterIndex }) => {
        prepared.push(chapterIndex);
      },
      createRequestId: () => 'compact-request'
    });

    const restored = await coordinator.restore();
    await coordinator.waitForIdle('legacy-package');

    assert.deepStrictEqual(restored, {
      resumedBooks: 1,
      failedBooks: [],
      deferredBooks: []
    });
    assert.deepStrictEqual(prepared, [0, 1]);
    const record = await journal.getOfflinePreparation('legacy-package');
    assert.strictEqual(record.requestId, 'compact-request');
    assert.strictEqual(record.packageVariantKey, 'voice-a:offline-mp3-v1:br48k');
    assert.strictEqual(record.bitrateKbps, 48);
    assert.strictEqual(record.preparedBytes, 960);
    assert.strictEqual(record.state, 'ready');
    assert.deepStrictEqual(record.owners, ['account:device']);
  });

  await test('startup recovery schedules every existing intent beyond the current admission bound', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-restore-overflow-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const bookIds = ['restore-one', 'restore-two', 'restore-three'];
    for (const bookId of bookIds) {
      await journal.putOfflinePreparation({
        bookId,
        requestId: `${bookId}-request`,
        state: 'preparing',
        totalChapters: 1,
        nextChapter: 0,
        readyChapters: 0,
        preparedBytes: 0
      });
    }
    const gates = new Map(bookIds.map(bookId => [bookId, deferred()]));
    const ready = new Set();
    const started = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      maxTrackedTitles: 2,
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}] }),
      chapterStatus: async ({ bookId }) => ({
        ready: ready.has(bookId),
        size: ready.has(bookId) ? 20 : 0,
        totalChunks: 1,
        readyChunks: ready.has(bookId) ? 1 : 0
      }),
      prepareChapter: async ({ bookId }) => {
        started.push(bookId);
        await gates.get(bookId).promise;
        ready.add(bookId);
      }
    });

    assert.deepStrictEqual(await coordinator.restore(), {
      resumedBooks: 3,
      failedBooks: [],
      deferredBooks: []
    });
    assert.strictEqual((await coordinator.status('restore-three')).state, 'waiting');

    for (let index = 0; index < bookIds.length; index += 1) {
      await eventually(() => started.length === index + 1);
      gates.get(started[index]).resolve();
    }
    await Promise.all(bookIds.map(bookId => coordinator.waitForIdle(bookId)));
    assert.deepStrictEqual(new Set(started), new Set(bookIds));
  });

  await test('a voice change restarts preparation without mixing package variants or notifying early', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-pinned-variant-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    let activeVoice = 'voice-a';
    let requestSequence = 0;
    const packaged = new Set();
    const prepared = [];
    const notifications = [];
    const identity = voice => ({
      sourceVoice: voice,
      sourceVariantKey: `${voice}:master`,
      sourceChunkSize: 4000,
      packageVariantKey: `${voice}:master:offline-mp3-v1:br48k`,
      bitrateKbps: 48
    });
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      preparationIdentity: () => identity(activeVoice),
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}, {}]
      }),
      chapterStatus: async request => ({
        ready: packaged.has(`${request.sourceVoice}:${request.chapterIndex}`),
        size: 480,
        variantKey: request.packageVariantKey
      }),
      prepareChapter: async request => {
        prepared.push({
          voice: request.sourceVoice,
          variant: request.sourceVariantKey,
          chapterIndex: request.chapterIndex
        });
        packaged.add(`${request.sourceVoice}:${request.chapterIndex}`);
        if (request.sourceVoice === 'voice-a') activeVoice = 'voice-b';
      },
      onReady: ({ record }) => notifications.push(record.packageVariantKey),
      createRequestId: () => `request-${++requestSequence}`
    });

    await coordinator.request('changing-voice');
    await coordinator.waitForIdle('changing-voice');

    assert.deepStrictEqual(prepared, [
      { voice: 'voice-a', variant: 'voice-a:master', chapterIndex: 0 },
      { voice: 'voice-b', variant: 'voice-b:master', chapterIndex: 0 },
      { voice: 'voice-b', variant: 'voice-b:master', chapterIndex: 1 }
    ]);
    assert.deepStrictEqual(notifications, ['voice-b:master:offline-mp3-v1:br48k']);
    const record = await journal.getOfflinePreparation('changing-voice');
    assert.strictEqual(record.sourceVoice, 'voice-b');
    assert.strictEqual(record.sourceVariantKey, 'voice-b:master');
    assert.strictEqual(record.packageVariantKey, 'voice-b:master:offline-mp3-v1:br48k');
    assert.strictEqual(record.requestId, 'request-2');
    assert.strictEqual(record.state, 'ready');
  });

  await test('durable title admission is bounded', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-admission-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      maxTrackedTitles: 2,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => gate.promise
    });

    await coordinator.request('book-one');
    await coordinator.request('book-two');
    await assert.rejects(
      coordinator.request('book-three'),
      error => error.statusCode === 429
    );

    await coordinator.cancel('book-one', { remove: true });
    await coordinator.cancel('book-two', { remove: true });
    gate.resolve();
  });

  await test('reactivating a paused title cannot exceed the tracked-title bound', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-reactivation-bound-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    await journal.putOfflinePreparation({
      bookId: 'paused-book',
      requestId: 'paused-request',
      state: 'paused',
      totalChapters: 1,
      nextChapter: 0,
      readyChapters: 0
    });
    const gate = deferred();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      maxTrackedTitles: 1,
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}] }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => gate.promise
    });

    await coordinator.request('active-book');
    await assert.rejects(
      coordinator.request('paused-book'),
      error => error.statusCode === 429
    );
    assert.strictEqual((await journal.getOfflinePreparation('paused-book')).state, 'paused');
    await coordinator.cancel('active-book', { remove: true });
    gate.resolve();
  });

  await test('foreground title moves to the front of pending server preparation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-foreground-title-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gates = new Map([
      ['book-one', deferred()],
      ['book-two', deferred()],
      ['book-three', deferred()]
    ]);
    const ready = new Set();
    const started = [];
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      maxTrackedTitles: 3,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async ({ bookId }) => ({
        ready: ready.has(bookId),
        totalChunks: 1,
        readyChunks: ready.has(bookId) ? 1 : 0,
        errorChunks: 0
      }),
      prepareChapter: async ({ bookId }) => {
        started.push(bookId);
        await gates.get(bookId).promise;
        ready.add(bookId);
      }
    });

    await coordinator.request('book-one');
    await coordinator.request('book-two');
    await coordinator.request('book-three');
    await eventually(() => started.length === 1);

    assert.strictEqual(coordinator.prioritize('book-three'), true);
    gates.get('book-one').resolve();
    await eventually(() => started.length === 2);
    assert.deepStrictEqual(started, ['book-one', 'book-three']);

    gates.get('book-three').resolve();
    await eventually(() => started.length === 3);
    gates.get('book-two').resolve();
    await Promise.all([
      coordinator.waitForIdle('book-one'),
      coordinator.waitForIdle('book-two'),
      coordinator.waitForIdle('book-three')
    ]);
    assert.deepStrictEqual(started, ['book-one', 'book-three', 'book-two']);
  });

  await test('waiting is a runtime projection and is never persisted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-waiting-state-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}] }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => gate.promise
    });

    await coordinator.request('active-book');
    await coordinator.request('waiting-book');
    assert.strictEqual((await coordinator.status('waiting-book')).state, 'waiting');
    assert.strictEqual((await journal.getOfflinePreparation('waiting-book')).state, 'preparing');

    await coordinator.cancel('active-book', { remove: true });
    await coordinator.cancel('waiting-book', { remove: true });
    gate.resolve();
  });

  await test('concurrent requests cannot exceed admission or lose device owners', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-concurrent-admission-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      maxConcurrentTitles: 1,
      maxTrackedTitles: 2,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => gate.promise
    });

    const admitted = await Promise.allSettled([
      coordinator.request('book-one', { ownerId: 'account:device-a' }),
      coordinator.request('book-two', { ownerId: 'account:device-b' }),
      coordinator.request('book-three', { ownerId: 'account:device-c' })
    ]);
    assert.strictEqual(admitted.filter(result => result.status === 'fulfilled').length, 2);
    assert.strictEqual(
      admitted.filter(result => result.status === 'rejected' && result.reason?.statusCode === 429).length,
      1
    );

    await Promise.all([
      coordinator.request('book-one', { ownerId: 'account:device-d' }),
      coordinator.request('book-one', { ownerId: 'account:device-e' })
    ]);
    assert.deepStrictEqual(
      new Set((await journal.getOfflinePreparation('book-one')).owners),
      new Set(['account:device-a', 'account:device-d', 'account:device-e'])
    );

    await coordinator.cancel('book-one', { remove: true });
    await coordinator.cancel('book-two', { remove: true });
    gate.resolve();
  });

  await test('status inspection is bounded for a large title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-status-bound-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    let statusChecks = 0;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: Array.from({ length: 100 }, () => ({}))
      }),
      chapterStatus: async () => {
        statusChecks += 1;
        return { ready: false, totalChunks: 4, readyChunks: 0, errorChunks: 0 };
      },
      prepareChapter: async () => gate.promise
    });

    assert.strictEqual((await coordinator.status('large-book')).state, 'not-requested');
    assert.strictEqual(statusChecks, 0);
    await coordinator.request('large-book');
    await coordinator.status('large-book');
    assert(statusChecks <= 3, `status inspected ${statusChecks} chapters`);

    await coordinator.cancel('large-book', { remove: true });
    gate.resolve();
  });

  await test('one device cannot pause preparation still needed by another device', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-shared-demand-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    const cancelled = [];
    let started = false;
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({
        book: { id: bookId },
        chapters: [{}]
      }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => {
        started = true;
        await gate.promise;
      },
      cancelRequest: requestId => cancelled.push(requestId),
      createRequestId: () => 'shared-request'
    });

    await coordinator.request('shared-title', { ownerId: 'account-a:device-a' });
    await eventually(() => started);
    await coordinator.request('shared-title', { ownerId: 'account-b:device-b' });
    assert.deepStrictEqual(
      (await journal.getOfflinePreparation('shared-title')).owners,
      ['account-a:device-a', 'account-b:device-b']
    );

    const firstCancel = await coordinator.cancel('shared-title', {
      ownerId: 'account-a:device-a'
    });
    assert.strictEqual(firstCancel.state, 'preparing');
    assert.deepStrictEqual(cancelled, []);

    const secondCancel = await coordinator.cancel('shared-title', {
      ownerId: 'account-b:device-b'
    });
    assert.strictEqual(secondCancel.state, 'paused');
    assert.deepStrictEqual(cancelled, ['shared-request']);

    gate.resolve();
    await coordinator.waitForIdle('shared-title');
  });

  await test('owner-scoped removal deletes unfinished intent only after the last owner leaves', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-owner-removal-'));
    const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
    const gate = deferred();
    const coordinator = createOfflinePreparationCoordinator({
      stateStore: journal,
      getBookChapters: async bookId => ({ book: { id: bookId }, chapters: [{}] }),
      chapterStatus: async () => ({ ready: false, totalChunks: 1, readyChunks: 0 }),
      prepareChapter: async () => gate.promise
    });

    await coordinator.request('shared-remove', { ownerId: 'account:device-a' });
    await coordinator.request('shared-remove', { ownerId: 'account:device-b' });
    const first = await coordinator.cancel('shared-remove', {
      ownerId: 'account:device-a',
      remove: true
    });
    assert.strictEqual(first.state, 'preparing');
    assert.deepStrictEqual(
      (await journal.getOfflinePreparation('shared-remove')).owners,
      ['account:device-b']
    );

    const last = await coordinator.cancel('shared-remove', {
      ownerId: 'account:device-b',
      remove: true
    });
    assert.strictEqual(last.state, 'removed');
    assert.strictEqual(await journal.getOfflinePreparation('shared-remove'), null);
    gate.resolve();
    await coordinator.waitForIdle('shared-remove');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
