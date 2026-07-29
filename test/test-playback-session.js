const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
    console.error(`    ${error.message}`);
  }
}

function engine(name, options = {}) {
  const calls = [];
  return {
    name,
    backend: options.backend || name,
    isPlaying: Boolean(options.isPlaying),
    calls,
    position: options.position || { currentTime: 0, totalEstimatedTime: 0, chunkIndex: 0, chunkTime: 0 },
    async loadChapter(bookId, chapterIndex) {
      calls.push(['load', bookId, chapterIndex]);
      if (options.load) await options.load();
    },
    async seek(seconds) {
      calls.push(['seek', seconds]);
      if (options.seek) await options.seek();
    },
    async play() {
      calls.push(['play']);
      if (options.play) await options.play();
      this.isPlaying = true;
    },
    cancelPendingLoad() {
      calls.push(['cancelPendingLoad']);
      options.cancelPendingLoad?.();
    },
    pause() { calls.push(['pause']); this.isPlaying = false; },
    getPosition() { return this.position; },
    dispose() { calls.push(['dispose']); }
  };
}

function fakeAudio() {
  const listeners = new Map();
  return {
    src: '',
    preload: '',
    volume: 1,
    playbackRate: 1,
    currentTime: 0,
    duration: 10,
    paused: true,
    ended: false,
    error: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn();
    },
    countFor(type) {
      return listeners.get(type)?.size || 0;
    },
    load() {},
    pause() { this.paused = true; },
    removeAttribute() { this.src = ''; }
  };
}

(async () => {
  const lifecycleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'), 'utf8');
  Function(lifecycleSource)();
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'playback-session.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { createPlaybackSession, restorePlaybackPosition } = await import(moduleUrl);
  const singleFileSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'single-file-chapter-player.js'), 'utf8');
  const singleFileUrl = `data:text/javascript;base64,${Buffer.from(singleFileSource).toString('base64')}`;
  const { SingleFileChapterPlayer } = await import(singleFileUrl);

  await test('single-file engine exposes the shared playback adapter contract', async () => {
    const audio = {
      paused: true,
      currentTime: 0,
      duration: 120,
      addEventListener() {},
      removeEventListener() {},
      pause() {},
      load() {},
      removeAttribute() {}
    };
    const single = new SingleFileChapterPlayer(audio);

    ['loadChapter', 'play', 'pause', 'getPosition', 'seek', 'dispose'].forEach(method => {
      assert.strictEqual(typeof single[method], 'function');
    });
    assert.strictEqual(single.backend, 'single-file');
    assert.strictEqual(single.supportsNativeMediaSession, true);
  });

  await test('commits an active chapter and its selected engine', async () => {
    const session = createPlaybackSession();
    const selected = engine('chunked');
    const book = { id: 'book-a' };

    const result = await session.transitionTo({ book, chapterIndex: 2, engine: selected, backend: 'chunked' });

    assert.strictEqual(result.stale, false);
    assert.strictEqual(session.snapshot.book, book);
    assert.strictEqual(session.snapshot.chapterIndex, 2);
    assert.strictEqual(session.snapshot.engine, selected);
    assert.deepStrictEqual(selected.calls, [['load', 'book-a', 2]]);
  });

  await test('keeps only the latest overlapping chapter transition', async () => {
    let releaseFirst;
    const first = engine('first', { load: () => new Promise(resolve => { releaseFirst = resolve; }) });
    const second = engine('second');
    const session = createPlaybackSession();
    const book = { id: 'book-a' };

    const firstTransition = session.transitionTo({ book, chapterIndex: 1, engine: first, backend: 'chunked' });
    await Promise.resolve();
    const secondTransition = session.transitionTo({ book, chapterIndex: 2, engine: second, backend: 'chunked' });
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([firstTransition, secondTransition]);
    assert.strictEqual(firstResult.stale, true);
    assert.strictEqual(secondResult.stale, false);
    assert.strictEqual(session.snapshot.chapterIndex, 2);
    assert.strictEqual(session.snapshot.engine, second);
    assert(first.calls.some(call => call[0] === 'dispose'));
  });

  await test('cancels stale single-file callbacks before the latest transition loads', async () => {
    const audio = fakeAudio();
    const ready = [];
    const first = new SingleFileChapterPlayer(audio, {
      onReady: () => ready.push(1),
      loadTimeoutMs: 1000
    });
    const second = new SingleFileChapterPlayer(audio, {
      onReady: () => ready.push(2),
      loadTimeoutMs: 1000
    });
    const session = createPlaybackSession();
    const book = { id: 'book-a' };

    const firstTransition = session.transitionTo({ book, chapterIndex: 1, engine: first });
    await Promise.resolve();
    assert.strictEqual(audio.countFor('loadedmetadata'), 1);

    const secondTransition = session.transitionTo({ book, chapterIndex: 2, engine: second });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(audio.countFor('loadedmetadata'), 1);
    audio.emit('loadedmetadata');

    const [firstResult, secondResult] = await Promise.all([firstTransition, secondTransition]);
    assert.strictEqual(firstResult.stale, true);
    assert.strictEqual(secondResult.stale, false);
    assert.deepStrictEqual(ready, [2]);
  });

  await test('releases a request engine when its queued transition is stale before starting', async () => {
    let releaseBlocker;
    const blocker = engine('blocker', { load: () => new Promise(resolve => { releaseBlocker = resolve; }) });
    const queued = engine('queued');
    const latest = engine('latest');
    const session = createPlaybackSession();
    const book = { id: 'book-a' };

    const blockingTransition = session.transitionTo({ book, chapterIndex: 1, engine: blocker });
    await Promise.resolve();
    const staleTransition = session.transitionTo({ book, chapterIndex: 2, engine: queued });
    const latestTransition = session.transitionTo({ book, chapterIndex: 3, engine: latest });
    releaseBlocker();

    const [blockingResult, staleResult, latestResult] = await Promise.all([
      blockingTransition,
      staleTransition,
      latestTransition
    ]);
    assert.strictEqual(blockingResult.stale, true);
    assert.strictEqual(staleResult.stale, true);
    assert.strictEqual(latestResult.stale, false);
    assert(!queued.calls.some(call => call[0] === 'load'));
    assert(queued.calls.some(call => call[0] === 'pause'));
    assert(queued.calls.some(call => call[0] === 'dispose'));
    assert.strictEqual(session.snapshot.engine, latest);
  });

  await test('retains an engine shared by stale and latest queued transitions', async () => {
    let releaseBlocker;
    const blocker = engine('blocker', { load: () => new Promise(resolve => { releaseBlocker = resolve; }) });
    const shared = engine('shared');
    const session = createPlaybackSession();
    const book = { id: 'book-a' };

    const blockingTransition = session.transitionTo({ book, chapterIndex: 1, engine: blocker });
    await Promise.resolve();
    const staleTransition = session.transitionTo({ book, chapterIndex: 2, engine: shared });
    const latestTransition = session.transitionTo({ book, chapterIndex: 3, engine: shared });
    releaseBlocker();

    const [, staleResult, latestResult] = await Promise.all([
      blockingTransition,
      staleTransition,
      latestTransition
    ]);
    assert.strictEqual(staleResult.stale, true);
    assert.strictEqual(latestResult.stale, false);
    assert.strictEqual(session.snapshot.engine, shared);
    assert.strictEqual(shared.calls.filter(call => call[0] === 'load').length, 1);
    assert.strictEqual(shared.calls.filter(call => call[0] === 'dispose').length, 0);

    await session.dispose();
    assert.strictEqual(shared.calls.filter(call => call[0] === 'dispose').length, 1);
  });

  await test('hands position and playing state to a replacement engine', async () => {
    const old = engine('chunked', {
      isPlaying: true,
      position: { currentTime: 12, totalEstimatedTime: 73, chunkIndex: 3, chunkTime: 4 }
    });
    const replacement = engine('single-file');
    const session = createPlaybackSession();
    const book = { id: 'book-a' };
    session.setBook(book, { chapterIndex: 4 });
    session.adoptEngine(old, 'chunked');

    const result = await session.handoffTo({ engine: replacement, backend: 'single-file', disposePrevious: false });

    assert.strictEqual(result.stale, false);
    assert.strictEqual(session.snapshot.engine, replacement);
    assert.deepStrictEqual(replacement.calls, [['load', 'book-a', 4], ['seek', 73], ['play']]);
    assert(old.calls.some(call => call[0] === 'pause'));
    assert(!old.calls.some(call => call[0] === 'dispose'));
  });

  await test('disposes a replaced engine when it is not retained for fallback', async () => {
    const old = engine('old');
    const replacement = engine('replacement');
    const session = createPlaybackSession();
    const book = { id: 'book-a' };
    session.setBook(book, { chapterIndex: 0 });
    session.adoptEngine(old, 'chunked');

    await session.handoffTo({ engine: replacement, backend: 'single-file' });

    assert(old.calls.some(call => call[0] === 'dispose'));
  });

  await test('releases a distinct incoming engine when loading, seeking, or playing fails', async () => {
    const book = { id: 'book-a' };
    const failures = [
      ['load', { load: async () => { throw new Error('load failed'); } }, {}],
      ['seek', { seek: async () => { throw new Error('seek failed'); } }, { position: { totalEstimatedTime: 12 } }],
      ['play', { play: async () => { throw new Error('play failed'); } }, { play: true }]
    ];

    for (const [name, options, request] of failures) {
      const old = engine(`old-${name}`);
      const incoming = engine(`incoming-${name}`, options);
      const session = createPlaybackSession();
      session.setBook(book, { chapterIndex: 0 });
      session.adoptEngine(old, 'chunked');

      await assert.rejects(
        session.transitionTo({ book, chapterIndex: 1, engine: incoming, backend: 'single-file', ...request }),
        new RegExp(`${name} failed`)
      );

      assert.strictEqual(session.snapshot.engine, old);
      assert(incoming.calls.some(call => call[0] === 'pause'));
      assert(incoming.calls.some(call => call[0] === 'dispose'));
      assert(!old.calls.some(call => call[0] === 'pause'));
      assert(!old.calls.some(call => call[0] === 'dispose'));
    }
  });

  await test('restores chapter-wide time when a legacy chunk checkpoint reaches a continuous engine', async () => {
    const calls = [];
    const continuous = {
      supportsChunkPositionRestore: false,
      async seek(seconds) { calls.push(['seek', seconds]); },
      async seekToChunk(chunkIndex, chunkTime) {
        calls.push(['seekToChunk', chunkIndex, chunkTime]);
      }
    };
    const chunked = {
      supportsChunkPositionRestore: true,
      async seek(seconds) { calls.push(['seek', seconds]); },
      async seekToChunk(chunkIndex, chunkTime) {
        calls.push(['seekToChunk', chunkIndex, chunkTime]);
      }
    };
    const saved = {
      timestamp: 235.4,
      chunkIndex: 7,
      chunkTime: 6.4
    };

    await restorePlaybackPosition(continuous, saved);
    await restorePlaybackPosition(chunked, saved);

    assert.deepStrictEqual(calls, [
      ['seek', 235.4],
      ['seekToChunk', 7, 6.4]
    ]);
  });

  await test('guards app-level chapter resume failures without an unhandled rejection', async () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const appImports = {
      createPlaybackSession: () => ({
        setBook() {},
        setFinished() {},
        adoptEngine() {},
        markProvisionalForward() {},
        clearProvisionalForward() {},
        buildCheckpoint() { return null; },
        dispose() {},
        transitionTo(request) {
          appImports.transitionRequests.push(request);
          return Promise.resolve({ stale: false });
        }
      }),
      createSmartRewindController: () => ({
        recordPause() {},
        planResume() { return null; },
        clear() {}
      }),
      expireSleepTimer: reason => appImports.sleepExpiries.push(reason),
      isSleepTimerChapterTarget: () => appImports.sleepTarget,
      displayChapterTitle: () => 'Chapter',
      isIOSLike: () => false,
      needsReliablePlayback: () => false,
      isSmartRewindEnabled: () => true,
      isBookDownloadedForOffline: () => false,
      ensureRollingOfflineWindow: async () => { appImports.rollingCalls += 1; },
      isRollingOfflineEnabled: () => true,
      refreshVoicePrepPanel() {},
      syncPlaybackProgressScope() {},
      updateChapterTrigger() {},
      updateMediaSessionMetadata() {},
      updateMediaSessionPosition() {},
      updateBookProgress() {},
      renderChapterList() {},
      syncMiniPlayerInfo() {},
      showAudioLoading() {},
      hideAudioLoading() {},
      setPlaybackReliabilityState(...args) { appImports.reliabilityStates.push(args); },
      setResumePromptVisible(visible) { appImports.resumePromptStates.push(visible); },
      showToast() {},
      syncMiniPlayerIcon() {},
      getCurrentPlaybackSpeed: () => 1
    };
    appImports.transitionRequests = [];
    appImports.rollingCalls = 0;
    appImports.sleepTarget = false;
    appImports.sleepExpiries = [];
    appImports.reliabilityStates = [];
    appImports.resumePromptStates = [];
    appImports.timeoutDelays = [];
    const appTestSource = appSource
      .replace(/^import \{([^}]+)\} from ['"][^'"]+['"];$/gm, 'const {$1} = globalThis.__playbackAppImports;')
      + `\nglobalThis.__playbackAppHarness = {
        configure({ book, chapters: nextChapters, player, chapter }) {
          currentBook = book;
          currentChapter = 0;
          chapters = nextChapters;
          chunkPlayer = player;
          chunkedPlayer = player;
          chapterSelect = chapter;
          playPauseBtn = chapter;
        },
        loadChapter,
        recordPlaybackEvent,
        playbackEvents() { return playbackEventLedger.slice(); },
        handleChapterEnd,
        handleContinuousChapterTransition,
        estimateChapterPlaybackDuration,
        togglePlayPause,
        handleChunkError
      };`;
    const previousGlobals = new Map(['window', 'document', 'navigator', 'setInterval', '__playbackAppImports', '__playbackAppHarness']
      .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const restoreGlobals = () => {
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    };
    const uiElement = { value: 0, innerHTML: '' };
    const player = engine('resume-rejecting', {
      backend: 'audio-stream',
      isPlaying: true,
      play: async () => { throw new Error('autoplay denied'); }
    });
    const unhandled = [];
    const localValues = new Map();
    const fakeLocalStorage = {
      getItem(key) { return localValues.get(key) || null; },
      setItem(key, value) { localValues.set(key, String(value)); }
    };
    const onUnhandled = error => unhandled.push(error);
    const originalWarn = console.warn;
    const originalError = console.error;

    try {
      console.warn = () => {};
      console.error = () => {};
      Object.defineProperties(globalThis, {
        window: {
          configurable: true,
          writable: true,
          value: {
            addEventListener() {},
            localStorage: fakeLocalStorage,
            setTimeout(_callback, delay) {
              appImports.timeoutDelays.push(delay);
              return appImports.timeoutDelays.length;
            },
            clearTimeout() {}
          }
        },
        document: { configurable: true, writable: true, value: { addEventListener() {} } },
        navigator: { configurable: true, writable: true, value: { onLine: true } },
        setInterval: { configurable: true, writable: true, value: () => 0 },
        __playbackAppImports: { configurable: true, writable: true, value: appImports }
      });
      const appUrl = `data:text/javascript;base64,${Buffer.from(appTestSource).toString('base64')}`;
      await import(appUrl);
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player,
        chapter: uiElement
      });

      process.once('unhandledRejection', onUnhandled);
      globalThis.__playbackAppHarness.loadChapter(1);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      process.removeListener('unhandledRejection', onUnhandled);

      assert.strictEqual(unhandled.length, 0);
      assert.strictEqual(appImports.transitionRequests.length, 1);
      assert.strictEqual(appImports.transitionRequests[0].play, false);
      assert.strictEqual(appImports.transitionRequests[0].engine, player);
      assert.strictEqual(appImports.transitionRequests[0].backend, 'audio-stream');
      assert(player.calls.some(call => call[0] === 'play'));
      assert.strictEqual(appImports.rollingCalls, 0, 'live streaming must not compete with rolling offline downloads');
      assert(uiElement.innerHTML.includes('M4.5 5.653'));

      const timedOutPlayer = engine('play-timeout', {
        backend: 'audio-stream',
        play: async () => {
          const error = new Error('Audio did not start');
          error.code = 'MEDIA_PLAY_TIMEOUT';
          throw error;
        }
      });
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: timedOutPlayer,
        chapter: uiElement
      });
      appImports.timeoutDelays.length = 0;

      await globalThis.__playbackAppHarness.togglePlayPause(true);

      assert(
        appImports.timeoutDelays.includes(250),
        'a play timeout should enter automatic recovery instead of stopping at a passive label'
      );

      const continuousPlayer = engine('continuous');
      continuousPlayer.isContinuous = true;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: continuousPlayer,
        chapter: uiElement
      });
      appImports.timeoutDelays.length = 0;
      appImports.resumePromptStates.length = 0;
      const autoplayError = new Error('Playback requires a user gesture');
      autoplayError.name = 'NotAllowedError';
      globalThis.__playbackAppHarness.handleChunkError(autoplayError);
      assert.deepStrictEqual(appImports.timeoutDelays, []);
      assert.deepStrictEqual(appImports.resumePromptStates, [true]);

      for (let index = 0; index < 100; index++) {
        globalThis.__playbackAppHarness.recordPlaybackEvent({
          type: `event-${index}`,
          reason: 'test',
          token: 'must-not-be-persisted'
        });
      }
      const diagnosticEvents = globalThis.__playbackAppHarness.playbackEvents();
      assert.strictEqual(diagnosticEvents.length, 80);
      assert.strictEqual(diagnosticEvents.at(-1).type, 'event-99');
      assert(diagnosticEvents.every(event => !Object.hasOwn(event, 'token')));
      assert.strictEqual(
        JSON.parse(localValues.get('xandrio_playback_event_ledger')).length,
        80,
        'bounded diagnostics should survive a reload'
      );

      const persistedBeforeSamples = localValues.get('xandrio_playback_event_ledger');
      globalThis.__playbackAppHarness.recordPlaybackEvent({ type: 'timeupdate', streamTime: 10 });
      assert.strictEqual(
        localValues.get('xandrio_playback_event_ledger'),
        persistedBeforeSamples,
        'periodic time samples must remain memory-only'
      );

      assert.strictEqual(
        globalThis.__playbackAppHarness.estimateChapterPlaybackDuration({ text: 'a'.repeat(150) }),
        10
      );
      assert.strictEqual(globalThis.__playbackAppHarness.estimateChapterPlaybackDuration({ text: '' }), 0);
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a', chapterDurations: [12.5] },
        chapters: [{ title: 'One', estimatedDuration: 9 }],
        player,
        chapter: uiElement
      });
      assert.strictEqual(
        globalThis.__playbackAppHarness.estimateChapterPlaybackDuration(
          { estimatedDuration: 9 },
          0
        ),
        12.5,
        'measured chapter durations should keep continuous chapter mapping aligned'
      );
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player,
        chapter: uiElement
      });

      appImports.sleepTarget = true;
      globalThis.__playbackAppHarness.handleContinuousChapterTransition({
        previousChapterIndex: 0,
        chapterIndex: 1,
        chapterTime: 0,
        streamTime: 10
      });
      assert(player.calls.some(call => call[0] === 'pause'));
      assert.deepStrictEqual(appImports.sleepExpiries, ['chapter']);
      assert(
        globalThis.__playbackAppHarness.playbackEvents()
          .some(event => event.type === 'sleep-timer-stop' && event.reason === 'chapter-transition')
      );

      appImports.sleepExpiries.length = 0;
      globalThis.__playbackAppHarness.handleChapterEnd({
        reason: 'continuous-limit',
        endChapterIndex: 0
      });
      assert.deepStrictEqual(
        appImports.sleepExpiries,
        ['chapter'],
        'a server-enforced chapter limit expires normally instead of entering recovery'
      );
      assert(
        globalThis.__playbackAppHarness.playbackEvents()
          .some(event => event.type === 'sleep-timer-stop' && event.reason === 'server-end-chapter-limit')
      );
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      console.warn = originalWarn;
      console.error = originalError;
      restoreGlobals();
    }
  });

  await test('gates provisional forward checkpoints until listening commits them', async () => {
    let clock = 0;
    const selected = engine('chunked', {
      isPlaying: true,
      position: { currentTime: 12, totalEstimatedTime: 12, chunkIndex: 0, chunkTime: 12 }
    });
    const session = createPlaybackSession({
      now: () => clock,
      provisionalMinListenMs: 100,
      provisionalMinPositionSeconds: 30
    });
    const book = { id: 'book-a' };
    session.setBook(book, { chapterIndex: 1 });
    session.adoptEngine(selected, 'chunked');
    session.markProvisionalForward(0, 1);

    assert.strictEqual(session.buildCheckpoint({ playbackRate: 1 }), null);
    clock = 100;
    const checkpoint = session.buildCheckpoint({ playbackRate: 1 });
    assert.strictEqual(checkpoint.chapterIndex, 1);
    assert.strictEqual(checkpoint.timestamp, 12);
    assert.strictEqual(checkpoint.wasPlaying, true);
  });

  await test('disposes the active and late-loading engines during lifecycle cleanup', async () => {
    let releaseLoad;
    const late = engine('late', { load: () => new Promise(resolve => { releaseLoad = resolve; }) });
    const session = createPlaybackSession();
    const transition = session.transitionTo({ book: { id: 'book-a' }, chapterIndex: 1, engine: late, backend: 'chunked' });
    await Promise.resolve();
    const disposing = session.dispose();
    releaseLoad();
    await disposing;
    const result = await transition;

    assert.strictEqual(result.stale, true);
    assert.strictEqual(session.snapshot.engine, null);
    assert(late.calls.some(call => call[0] === 'dispose'));
  });

  await test('dispose cancels an incoming engine stalled during chapter load', async () => {
    let rejectLoad;
    const incoming = engine('incoming', {
      load: () => new Promise((_, reject) => { rejectLoad = reject; }),
      cancelPendingLoad: () => {
        const error = new Error('load cancelled');
        error.cancelled = true;
        rejectLoad(error);
      }
    });
    const session = createPlaybackSession();
    const transition = session.transitionTo({
      book: { id: 'book-a' },
      chapterIndex: 1,
      createEngine: async () => incoming
    });
    await new Promise(resolve => setImmediate(resolve));
    assert(incoming.calls.some(call => call[0] === 'load'));

    const disposing = session.dispose();
    await Promise.race([
      disposing,
      new Promise((_, reject) => setTimeout(() => reject(new Error('session disposal remained blocked')), 100))
    ]);
    const result = await transition;

    assert.strictEqual(result.stale, true);
    assert.strictEqual(incoming.calls.filter(call => call[0] === 'cancelPendingLoad').length, 1);
    assert.strictEqual(incoming.calls.filter(call => call[0] === 'dispose').length, 1);
  });

  await test('disposes an active engine shared by queued work only once during cleanup', async () => {
    let releaseBlocker;
    const active = engine('active');
    const blocker = engine('blocker', { load: () => new Promise(resolve => { releaseBlocker = resolve; }) });
    const session = createPlaybackSession();
    const book = { id: 'book-a' };
    session.setBook(book, { chapterIndex: 0 });
    session.adoptEngine(active, 'chunked');

    const blockingTransition = session.transitionTo({ book, chapterIndex: 1, engine: blocker });
    await Promise.resolve();
    const queuedTransition = session.transitionTo({ book, chapterIndex: 2, engine: active });
    const disposing = session.dispose();
    releaseBlocker();
    await Promise.all([blockingTransition, queuedTransition, disposing]);

    assert.strictEqual(active.calls.filter(call => call[0] === 'dispose').length, 1);
    assert.strictEqual(blocker.calls.filter(call => call[0] === 'dispose').length, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
