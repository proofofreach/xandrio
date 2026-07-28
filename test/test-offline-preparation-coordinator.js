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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
