const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GenerationScheduler = require('../lib/generation-scheduler');
const GenerationJournal = require('../lib/generation-journal');
const TTSQueue = require('../lib/tts-queue');
const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');
const {
  registerPlaybackRoutes,
  replayOfflinePreparations
} = require('../lib/routes/playback-routes');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function testSchedulerPriority() {
  const scheduler = new GenerationScheduler({ capacities: { gpu: 1 } });
  const blocker = deferred();
  const order = [];
  const active = scheduler.run({ resource: 'gpu', priority: 'background' }, () => blocker.promise);
  await new Promise(resolve => setImmediate(resolve));
  const firstBackground = scheduler.run(
    { resource: 'gpu', priority: 'background' },
    async () => order.push('background-1')
  );
  const secondBackground = scheduler.run(
    { resource: 'gpu', priority: 'background' },
    async () => order.push('background-2')
  );
  const download = scheduler.run(
    { resource: 'gpu', priority: 'download' },
    async () => order.push('download')
  );
  blocker.resolve();
  await Promise.all([active, firstBackground, secondBackground, download]);
  assert.deepStrictEqual(order, ['download', 'background-1', 'background-2']);
}

async function testOrchestratorPriority() {
  const calls = [];
  const orchestrator = createPlaybackOrchestrator({
    isPremiumVoiceActive: () => false,
    ttsForTier: () => ({}),
    voiceForTier: () => 'voice',
    ensureChapterAudio: async (...args) => calls.push(args),
    inspectChapterAudio: async () => ({ ready: false, variantKey: 'variant' })
  });
  await orchestrator.startChapterAudio({
    bookId: 'book',
    chapterIndex: 2,
    priority: 'download'
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(calls[0][2].priority, 'download');
}

async function testTtsQueuePriority() {
  const queue = new TTSQueue({ maxConcurrent: 1 });
  queue._drain = () => {};
  const backgroundOne = await queue.enqueue({
    text: 'background one',
    outputPath: '/tmp/download-priority-bg-1.mp3',
    priority: 'background'
  });
  const backgroundTwo = await queue.enqueue({
    text: 'background two',
    outputPath: '/tmp/download-priority-bg-2.mp3',
    priority: 'background'
  });
  const download = await queue.enqueue({
    text: 'download',
    outputPath: '/tmp/download-priority-title.mp3',
    priority: 'download'
  });
  assert.deepStrictEqual(queue._queue.map(job => job.priority), [
    'download',
    'background',
    'background'
  ]);
  queue.cancel(download);
  queue.cancel(backgroundOne);
  queue.cancel(backgroundTwo);
}

async function testRoutePurpose() {
  const handlers = new Map();
  const app = {
    get(path, ...routeHandlers) {
      handlers.set(`GET ${path}`, routeHandlers.at(-1));
    },
    post(path, ...routeHandlers) {
      handlers.set(`POST ${path}`, routeHandlers.at(-1));
    },
    delete(path, ...routeHandlers) {
      handlers.set(`DELETE ${path}`, routeHandlers.at(-1));
    }
  };
  let request = null;
  registerPlaybackRoutes(app, {
    playbackOrchestrator: {
      startChapterAudio: async value => {
        request = value;
        return { ready: false };
      }
    },
    ttsForTier: () => ({}),
    generationJournal: {},
    chapterAudioStreamer: {},
    hlsAudioStreamer: {},
    serveAudioFile: async () => {},
    sendServerError: (_res, error) => { throw error; },
    fs: {}
  });
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {}
  };
  await handlers.get('POST /api/chunks/:bookId/:chapterIndex/prepare-chapter-audio')({
    params: { bookId: 'book', chapterIndex: '2' },
    query: {},
    body: { purpose: 'offline-download' }
  }, response);
  assert.strictEqual(response.statusCode, 202);
  assert.strictEqual(request.priority, 'download');
}

async function testBookPreparationRoutes() {
  const handlers = new Map();
  const app = {
    get(path, ...routeHandlers) {
      handlers.set(`GET ${path}`, routeHandlers.at(-1));
    },
    post(path, ...routeHandlers) {
      handlers.set(`POST ${path}`, routeHandlers.at(-1));
    },
    delete(path, ...routeHandlers) {
      handlers.set(`DELETE ${path}`, routeHandlers.at(-1));
    }
  };
  const requested = [];
  registerPlaybackRoutes(app, {
    playbackOrchestrator: {
      startChapterAudio: async () => ({ ready: false })
    },
    getBookChapters: async bookId => ({
      book: { id: bookId, title: 'Prepared Book' },
      chapters: [{}, {}]
    }),
    offlinePreparationCoordinator: {
      status: async bookId => ({
        bookId,
        state: 'not-requested',
        readyChapters: 0,
        totalChapters: 2,
        readyChunks: 0,
        totalChunks: 0,
        errorChapters: 0,
        nextChapter: 0,
        percent: 0
      }),
      request: async bookId => {
        requested.push(bookId);
        return {
          bookId,
          state: 'preparing',
          readyChapters: 1,
          totalChapters: 2,
          readyChunks: 3,
          totalChunks: 6,
          errorChapters: 0,
          nextChapter: 1,
          percent: 50
        };
      }
    },
    ttsForTier: () => ({}),
    generationJournal: {},
    chapterAudioStreamer: {},
    hlsAudioStreamer: {},
    serveAudioFile: async () => {},
    sendServerError: (_res, error) => { throw error; },
    fs: {}
  });
  let body = null;
  const response = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      body = value;
    }
  };

  await handlers.get('GET /api/offline/preparation/:bookId')({
    params: { bookId: 'book' },
    query: {}
  }, response);
  assert.strictEqual(body.state, 'not-requested');

  await handlers.get('POST /api/offline/preparation/:bookId')({
    params: { bookId: 'book' },
    query: {},
    body: {}
  }, response);

  assert.strictEqual(response.statusCode, 202);
  assert.deepStrictEqual(requested, ['book']);
  assert.deepStrictEqual(body, {
    bookId: 'book',
    state: 'preparing',
    readyChapters: 1,
    totalChapters: 2,
    readyChunks: 3,
    totalChunks: 6,
    errorChapters: 0,
    nextChapter: 1,
    percent: 50
  });
}

async function testDurableBookPreparationIntent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-offline-prep-'));
  const journal = new GenerationJournal(path.join(dir, 'generation-state.json'));
  await journal.putOfflinePreparation({
    bookId: 'book',
    totalChapters: 24,
    requestedAt: 123
  });
  assert.deepStrictEqual(await journal.getOfflinePreparation('book'), {
    bookId: 'book',
    totalChapters: 24,
    requestedAt: 123
  });
  assert.deepStrictEqual(await journal.listOfflinePreparations(), [{
    bookId: 'book',
    totalChapters: 24,
    requestedAt: 123
  }]);
  await journal.removeChaptersForBook('book');
  assert.strictEqual(await journal.getOfflinePreparation('book'), null);
}

async function testOfflinePreparationRecovery() {
  let restored = 0;
  const report = await replayOfflinePreparations({
    offlinePreparationCoordinator: {
      restore: async () => {
        restored += 1;
        return { resumedBooks: 1, failedBooks: [] };
      }
    }
  });
  assert.strictEqual(restored, 1);
  assert.deepStrictEqual(report, { resumedBooks: 1, resumedChapters: 0, failedBooks: [] });
}

(async () => {
  await testSchedulerPriority();
  console.log('  ✓ offline downloads preempt queued background generation');
  await testTtsQueuePriority();
  console.log('  ✓ TTS queue orders downloads before speculative work');
  await testOrchestratorPriority();
  console.log('  ✓ download priority reaches chapter generation');
  await testRoutePurpose();
  console.log('  ✓ offline-download requests select download priority');
  await testBookPreparationRoutes();
  console.log('  ✓ full-title preparation delegates to the bounded durable coordinator');
  await testDurableBookPreparationIntent();
  console.log('  ✓ full-title preparation intent survives outside the browser');
  await testOfflinePreparationRecovery();
  console.log('  ✓ full-title preparation recovery delegates to the bounded durable coordinator');
  console.log('\n7 passed, 0 failed');
})().catch(error => {
  console.error(`  ✗ ${error.stack || error.message}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
});
