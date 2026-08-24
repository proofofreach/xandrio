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
  const loadTuples = [];
  return {
    name,
    backend: options.backend || name,
    isPlaying: Boolean(options.isPlaying),
    calls,
    loadTuples,
    position: options.position || { currentTime: 0, totalEstimatedTime: 0, chunkIndex: 0, chunkTime: 0 },
    async loadChapter(bookId, chapterIndex, sourceTuple = {}) {
      calls.push(['load', bookId, chapterIndex]);
      // Kept out of `calls` so existing deep-equal assertions on call shape
      // stay meaningful.
      loadTuples.push(sourceTuple);
      if (options.load) await options.load();
    },
    async seek(seconds) {
      calls.push(['seek', seconds]);
      if (options.seek) await options.seek();
    },
    async play() {
      // Recorded before any await so a test can assert what was true at the
      // moment play() was invoked — an async function body runs synchronously
      // up to its first await, exactly as the real engine's audio.play() does.
      calls.push(['play']);
      options.onPlayInvoked?.();
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
      preparePlaybackRunway: false,
      loadTimeoutMs: 1000
    });
    const second = new SingleFileChapterPlayer(audio, {
      onReady: () => ready.push(2),
      preparePlaybackRunway: false,
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

  await test('does not seek an iOS continuous stream that already opened at the saved offset', async () => {
    const calls = [];
    const continuous = {
      chapterIndex: 6,
      supportsChunkPositionRestore: false,
      openedAtOffset(chapterIndex, seconds) {
        return chapterIndex === 6 && Math.abs(seconds - 181.6667954586644) < 0.01;
      },
      async seek(seconds) { calls.push(['seek', seconds]); }
    };

    await restorePlaybackPosition(continuous, {
      timestamp: 181.6667954586644,
      chapterIndex: 6
    });

    assert.deepStrictEqual(
      calls,
      [],
      'native HLS is left at stream time zero instead of being redundantly repositioned'
    );
  });

  await test('guards app-level chapter resume failures without an unhandled rejection', async () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const openBookSource = appSource.slice(
      appSource.indexOf('async function openBook('),
      appSource.indexOf('let loadChapterToken')
    );
    assert(
      openBookSource.indexOf('void prioritizeForegroundBook(bookId);') !== -1 &&
        openBookSource.indexOf('void prioritizeForegroundBook(bookId);') <
          openBookSource.indexOf('await apiGet(`/api/book/${encodeURIComponent(bookId)}`)'),
      'opening a book signals foreground priority before waiting for book data'
    );
    const appImports = {
      apiGet: (...args) => appImports.apiGetImpl(...args),
      syncPlayerHash: (...args) => appImports.syncedPlayerHashes.push(args),
      getOfflineBookData: () => null,
      shouldUseOfflineBookFallback: () => false,
      createPlaybackSession: () => ({
        setBook() {},
        setFinished() {},
        adoptEngine() {},
        markProvisionalForward() {},
        clearProvisionalForward() {},
        buildCheckpoint() { return null; },
        dispose() {},
        async transitionTo(request) {
          appImports.transitionRequests.push(request);
          if (appImports.transitionGate) await appImports.transitionGate;
          return { stale: false };
        }
      }),
      restorePlaybackPosition: async (player, position) => {
        appImports.restoredPositions.push([player, position]);
      },
      createSmartRewindController: () => ({
        recordPause() {},
        planResume() { return null; },
        clear() {}
      }),
      applyRewindForResume: () => ({
        status: 'skipped',
        rewindSeconds: 0,
        targetSeconds: null
      }),
      expireSleepTimer: reason => appImports.sleepExpiries.push(reason),
      isSleepTimerChapterTarget: () => appImports.sleepTarget,
      displayChapterTitle: () => 'Chapter',
      isIOSLike: () => false,
      needsReliablePlayback: () => false,
      isSmartRewindEnabled: () => true,
      isBookDownloadedForOffline: () => false,
      localChapterSource: async (...args) => {
        appImports.localSourceQueries.push(args);
        return appImports.localSource;
      },
      markLocalChapterSuspect: (...args) => appImports.suspectMarks.push(args),
      classifyLocalChapter: async () => 'transient',
      renderOfflineState() {},
      ensureRollingOfflineWindow: async () => { appImports.rollingCalls += 1; },
      isRollingOfflineEnabled: () => true,
      refreshVoicePrepPanel() {},
      syncPlaybackProgressScope() {},
      updateChapterTrigger() {},
      paintChapterTimes(data) { appImports.chapterTimePaints.push(data); },
      updateMediaSessionMetadata() {},
      updateMediaSessionPosition() {},
      updateBookProgress() {},
      renderChapterList() {},
      syncMiniPlayerInfo() {},
      showAudioLoading() {},
      hideAudioLoading() {},
      setChunkOverlayState(...args) { appImports.overlays.push(args); },
      setPlaybackReliabilityState(...args) { appImports.reliabilityStates.push(args); },
      setResumePromptVisible(visible) { appImports.resumePromptStates.push(visible); },
      showToast(...args) { appImports.toasts.push(args); },
      syncMiniPlayerIcon() {},
      getCurrentPlaybackSpeed: () => 1,
      offlineWorkerControllerState: () => ({ controlled: true, compatible: false }),
      certifyOfflineWorkerController: async () => ({ controlled: true, compatible: false })
    };
    appImports.apiSend = async (...args) => { appImports.apiSendCalls.push(args); };
    appImports.apiGetImpl = async () => { throw Object.assign(new Error('not configured'), { status: 404 }); };
    appImports.apiSendCalls = [];
    appImports.syncedPlayerHashes = [];
    appImports.transitionRequests = [];
    appImports.restoredPositions = [];
    appImports.transitionGate = null;
    appImports.rollingCalls = 0;
    appImports.sleepTarget = false;
    appImports.sleepExpiries = [];
    appImports.reliabilityStates = [];
    appImports.overlays = [];
    appImports.resumePromptStates = [];
    appImports.timeoutDelays = [];
    appImports.pendingTimeouts = [];
    appImports.nextTimeoutId = 1;
    appImports.toasts = [];
    appImports.localSourceQueries = [];
    appImports.suspectMarks = [];
    appImports.chapterTimePaints = [];
    appImports.localSource = { available: false, url: null, mode: null };
    const appTestSource = appSource
      .replace(/^import \{([^}]+)\} from ['"][^'"]+['"];$/gm, 'const {$1} = globalThis.__playbackAppImports;')
      + `\nglobalThis.__playbackAppHarness = {
        configure({ book, chapters: nextChapters, player, chapter, openingBook = null, chapterIndex = 0 }) {
          currentBook = book;
          openingBookId = openingBook;
          currentChapter = Number.isInteger(chapterIndex) ? chapterIndex : 0;
          chapters = nextChapters;
          chunkPlayer = player;
          chunkedPlayer = player;
          chapterSelect = chapter;
          playPauseBtn = chapter;
        },
        loadChapter,
        loadRestoredChapter,
        openBook,
        currentBook() { return currentBook; },
        prioritizeForegroundBook,
        recordPlaybackEvent,
        playbackEvents() { return playbackEventLedger.slice(); },
        handleChapterEnd,
        handleContinuousChapterTransition,
        estimateChapterPlaybackDuration,
        togglePlayPause,
        handleChunkError,
        cancelPlaybackRecovery,
        invalidatePlaybackRecoveryForUserSeek,
        offerManualPlaybackRecovery
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
            setTimeout(callback, delay) {
              const id = appImports.nextTimeoutId++;
              appImports.timeoutDelays.push(delay);
              appImports.pendingTimeouts.push({ id, callback, delay, cancelled: false });
              return id;
            },
            clearTimeout(id) {
              const pending = appImports.pendingTimeouts.find(entry => entry.id === id);
              if (pending) pending.cancelled = true;
            }
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

      // The player view can commit the newly selected title before its media
      // transition has replaced the persistent audio element's old source.
      // Play must never resume that source under the new title.
      const staleBookPlayer = engine('stale-book-source', { backend: 'audio-stream' });
      staleBookPlayer.bookId = 'red-book';
      globalThis.__playbackAppHarness.configure({
        book: { id: 'red-book' },
        openingBook: 'outwitting-the-devil',
        chapters: [{ title: 'Chapter One' }],
        player: staleBookPlayer,
        chapter: uiElement
      });

      await globalThis.__playbackAppHarness.togglePlayPause(true);

      assert(
        !staleBookPlayer.calls.some(call => call[0] === 'play'),
        'Play cannot restart the outgoing book while a new title is opening'
      );

      globalThis.__playbackAppHarness.configure({
        book: { id: 'outwitting-the-devil' },
        chapters: [{ title: 'Chapter One' }],
        player: staleBookPlayer,
        chapter: uiElement
      });

      await globalThis.__playbackAppHarness.togglePlayPause(true);

      assert(
        !staleBookPlayer.calls.some(call => call[0] === 'play'),
        'Play cannot resume media owned by the previously selected book'
      );
      assert(
        appImports.reliabilityStates.some(([, label]) => label === 'Loading selected book'),
        'a blocked stale Play reports that the selected title is still loading'
      );

      staleBookPlayer.bookId = 'outwitting-the-devil';
      await globalThis.__playbackAppHarness.togglePlayPause(true);
      assert.strictEqual(
        staleBookPlayer.calls.filter(call => call[0] === 'play').length,
        1,
        'Play reaches the engine after it owns the selected book'
      );

      const chapterLoadingPlayer = engine('chapter-loading', { backend: 'audio-stream' });
      chapterLoadingPlayer.bookId = 'book-a';
      chapterLoadingPlayer.ownsReadySource = (bookId, chapterIndex) =>
        String(bookId) === 'book-a' && chapterIndex === 0;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: chapterLoadingPlayer,
        chapter: uiElement,
        chapterIndex: 1
      });
      await globalThis.__playbackAppHarness.togglePlayPause(true);
      assert(
        !chapterLoadingPlayer.calls.some(call => call[0] === 'play'),
        'Play cannot restart the previous chapter while the next source is still loading'
      );
      chapterLoadingPlayer.ownsReadySource = (bookId, chapterIndex) =>
        String(bookId) === 'book-a' && chapterIndex === 1;
      await globalThis.__playbackAppHarness.togglePlayPause(true);
      assert.strictEqual(
        chapterLoadingPlayer.calls.filter(call => call[0] === 'play').length,
        1,
        'Play reaches the engine once the requested chapter source is ready'
      );

      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player,
        chapter: uiElement
      });

      await globalThis.__playbackAppHarness.prioritizeForegroundBook();
      await globalThis.__playbackAppHarness.prioritizeForegroundBook();
      assert.deepStrictEqual(
        appImports.apiSendCalls,
        [['POST', '/api/playback/foreground/book-a']],
        'the foreground book is signaled once without waiting for playback generation'
      );
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-b' },
        chapters: [{ title: 'Other' }],
        player,
        chapter: uiElement
      });
      await globalThis.__playbackAppHarness.prioritizeForegroundBook();
      assert.deepStrictEqual(appImports.apiSendCalls.at(-1), [
        'POST',
        '/api/playback/foreground/book-b'
      ]);
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player,
        chapter: uiElement
      });
      await globalThis.__playbackAppHarness.prioritizeForegroundBook();
      assert.strictEqual(
        appImports.apiSendCalls.length,
        2,
        'switching titles does not reset the per-title foreground debounce'
      );

      // A slow response for an earlier title must not take ownership after a
      // newer navigation. Otherwise the global title/chapters/player state can
      // be assembled from two different books.
      let resolveEarlierBook;
      appImports.apiGetImpl = async url => {
        if (url === '/api/book/book-a') {
          return new Promise(resolve => { resolveEarlierBook = resolve; });
        }
        throw Object.assign(new Error('newer book unavailable'), { status: 404 });
      };
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-initial' },
        chapters: [{ title: 'Initial' }],
        player,
        chapter: uiElement
      });
      const earlierOpen = globalThis.__playbackAppHarness.openBook('book-a');
      await Promise.resolve();
      const newerOpen = globalThis.__playbackAppHarness.openBook('book-b');
      await newerOpen;
      resolveEarlierBook({
        book: { id: 'book-a', title: 'Earlier title' },
        chapters: [{ title: 'Earlier content' }]
      });
      await earlierOpen;
      assert.strictEqual(
        globalThis.__playbackAppHarness.currentBook().id,
        'book-initial',
        'a stale book response cannot replace the state owned by newer navigation'
      );
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [
          { title: 'Chapter I', estimatedDuration: 228 },
          { title: 'Chapter II', estimatedDuration: 720 }
        ],
        player,
        chapter: uiElement
      });

      // Opening a saved iOS HLS chapter must start the transport at the saved
      // chapter time. Loading at zero and seeking to 142 seconds made Safari
      // wait 142 seconds for the EVENT playlist to grow to that timestamp.
      appImports.transitionRequests.length = 0;
      appImports.restoredPositions.length = 0;
      const restored = { chapterIndex: 0, timestamp: 141.739 };
      await globalThis.__playbackAppHarness.loadRestoredChapter(0, restored);
      assert.strictEqual(
        appImports.transitionRequests.at(-1).sourceTuple.startOffsetSeconds,
        141.739,
        'the initial transport opens at the saved chapter time'
      );
      assert.deepStrictEqual(
        appImports.restoredPositions,
        [[player, restored]],
        'the loaded engine still applies the canonical saved position'
      );
      appImports.localSourceQueries.length = 0;
      appImports.transitionRequests.length = 0;

      process.once('unhandledRejection', onUnhandled);
      appImports.chapterTimePaints.length = 0;
      player.bookId = 'book-a';
      player.isPlaying = true;
      globalThis.__playbackAppHarness.loadChapter(1);
      assert.deepStrictEqual(
        appImports.chapterTimePaints.at(-1),
        { currentTime: 0, totalTime: 720, progressPercent: 0 },
        'selecting a chapter resets stale scrubber state before narration is ready'
      );
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      process.removeListener('unhandledRejection', onUnhandled);

      assert.strictEqual(unhandled.length, 0);
      assert.strictEqual(
        appImports.localSourceQueries.length,
        1,
        'local availability is consulted even though navigator.onLine is true'
      );
      assert.strictEqual(appImports.transitionRequests.length, 1);
      assert.strictEqual(appImports.transitionRequests[0].play, false);
      assert.strictEqual(appImports.transitionRequests[0].engine, player);
      assert.strictEqual(appImports.transitionRequests[0].backend, 'audio-stream');
      assert(player.calls.some(call => call[0] === 'play'));
      assert.strictEqual(appImports.rollingCalls, 0, 'live streaming must not compete with rolling offline downloads');
      assert(uiElement.innerHTML.includes('M4.5 5.653'));

      // Local-first. A chapter already on this device is played from this
      // device while online — connectivity used to gate the check entirely, so
      // a verified download was ignored whenever the phone had signal.
      appImports.localSource = {
        available: true,
        url: '/api/audio/book-a/0?xandrio-offline-scope=account_a',
        mode: 'full'
      };
      appImports.transitionRequests.length = 0;
      const localPlayer = engine('local-first', { backend: 'single-file' });
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: localPlayer,
        chapter: uiElement
      });

      await globalThis.__playbackAppHarness.loadChapter(0);

      assert.strictEqual(globalThis.navigator.onLine, true, 'the device is online');
      assert.strictEqual(
        appImports.transitionRequests.at(-1).backend,
        'single-file',
        'a downloaded chapter plays from this device rather than streaming'
      );
      assert.strictEqual(
        localPlayer.preferStandardAudio,
        true,
        'the engine is pointed at the scoped offline URL'
      );
      assert(
        appImports.reliabilityStates.some(([, label]) => label === 'Playing from this device'),
        'the user is told playback is local'
      );

      appImports.localSource = { available: false, url: null, mode: null };

      const timedOutPlayer = engine('play-timeout', {
        backend: 'audio-stream',
        play: async () => {
          const error = new Error('Audio did not start');
          error.code = 'MEDIA_PLAY_TIMEOUT';
          throw error;
        }
      });
      timedOutPlayer.bookId = 'book-a';
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

      // Single-flight recovery. Each recovery attempt loads a chapter, and each
      // load asks the server for an HLS session, so a burst of errors from one
      // stalled stream must still own exactly one attempt at a time. This is
      // the shape that produced six sessions in eighty seconds in production.
      appImports.timeoutDelays.length = 0;
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      const streamError = new Error('stream stalled');
      streamError.code = 'CONTINUOUS_STREAM_EOF';
      for (let index = 0; index < 5; index++) {
        globalThis.__playbackAppHarness.handleChunkError(streamError);
      }
      assert.deepStrictEqual(
        appImports.timeoutDelays,
        [250],
        'a burst of stream errors schedules exactly one recovery attempt'
      );

      // Duplicate errors from one stalled stream are already handled by the
      // attempt in flight. Treating them as unhandled put a manual "Resume"
      // prompt on screen while a retry was already running.
      appImports.resumePromptStates.length = 0;
      appImports.toasts.length = 0;
      for (let index = 0; index < 3; index++) {
        globalThis.__playbackAppHarness.handleChunkError(streamError);
      }
      assert.deepStrictEqual(
        appImports.resumePromptStates,
        [],
        'a duplicate error while an attempt is in flight raises no manual prompt'
      );

      // A recovery lineage owns one immutable source tuple and one bounded
      // retry budget until playback has remained stable. Production opened
      // four sessions at 0, .063, .241 and .417 seconds because each new media
      // error captured a creeping offset and manual preparation reset the
      // automatic budget.
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      appImports.pendingTimeouts.length = 0;
      appImports.timeoutDelays.length = 0;
      appImports.transitionRequests.length = 0;
      appImports.toasts.length = 0;
      const lineagePlayer = engine('recovery-lineage', { backend: 'audio-stream' });
      lineagePlayer.isContinuous = true;
      lineagePlayer.servedTier = 'premium';
      lineagePlayer.endChapterIndex = 1;
      let observedOffset = 0.063;
      lineagePlayer.getCurrentTime = () => observedOffset;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: lineagePlayer,
        chapter: uiElement
      });
      const runRecoveryTimer = async delay => {
        const pending = appImports.pendingTimeouts.find(entry =>
          !entry.cancelled && entry.delay === delay
        );
        assert(pending, `expected a pending ${delay}ms recovery timer`);
        pending.cancelled = true;
        await pending.callback();
        await new Promise(resolve => setImmediate(resolve));
      };

      globalThis.__playbackAppHarness.handleChunkError(streamError);
      await runRecoveryTimer(250);
      observedOffset = 0.241;
      globalThis.__playbackAppHarness.handleChunkError(streamError);
      await runRecoveryTimer(500);
      observedOffset = 0.417;
      globalThis.__playbackAppHarness.handleChunkError(streamError);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      const recoveryTuples = appImports.transitionRequests
        .map(request => request.sourceTuple)
        .filter(Boolean);
      assert(recoveryTuples.length >= 3, 'two retries and manual preparation all load a source');
      assert(
        recoveryTuples.every(tuple => tuple.startOffsetSeconds === 0.063),
        `the lineage drifted across offsets: ${recoveryTuples.map(tuple => tuple.startOffsetSeconds).join(', ')}`
      );

      observedOffset = 0.8;
      globalThis.__playbackAppHarness.handleChunkError(streamError);
      assert.strictEqual(
        appImports.timeoutDelays.filter(delay => delay === 250).length,
        1,
        'manual preparation must not re-arm the exhausted automatic retry budget'
      );

      // An explicit seek starts a new lineage. A later transport failure must
      // recover at the selected position, never at the pre-seek failure point.
      globalThis.__playbackAppHarness.invalidatePlaybackRecoveryForUserSeek();
      appImports.timeoutDelays.length = 0;
      observedOffset = 1200;
      globalThis.__playbackAppHarness.handleChunkError(streamError);
      await runRecoveryTimer(250);
      assert.strictEqual(
        appImports.transitionRequests.at(-1).sourceTuple.startOffsetSeconds,
        1200,
        'a user seek invalidates the earlier recovery snapshot'
      );

      // A rate-limited session must not be retried into the same limit, and the
      // 429 must be reachable even when the failed engine was never continuous.
      appImports.timeoutDelays.length = 0;
      appImports.resumePromptStates.length = 0;
      appImports.toasts.length = 0;
      const finitePlayer = engine('finite-429');
      finitePlayer.isContinuous = false;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: finitePlayer,
        chapter: uiElement
      });
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      const rateLimited = new Error('Too many HLS playback sessions started');
      rateLimited.status = 429;
      rateLimited.retryAfterSeconds = 12;
      globalThis.__playbackAppHarness.handleChunkError(rateLimited);

      assert.deepStrictEqual(
        appImports.timeoutDelays,
        [],
        'a 429 is surfaced to the user instead of scheduling another attempt'
      );
      assert.deepStrictEqual(
        appImports.resumePromptStates,
        [],
        'a handled 429 does not also fall through to the manual prompt'
      );
      assert(
        appImports.toasts.some(([message]) => /12s/.test(message)),
        'the user is told how long to wait, from Retry-After'
      );

      // --- Manual Resume must play inside the activation window -------------
      // iOS grants play() only during the synchronous turn of the tap that
      // triggered it. The old toast action awaited loadChapter first, so by the
      // time it called play() the grant was gone and "Resume" did nothing.
      appImports.toasts.length = 0;
      appImports.resumePromptStates.length = 0;
      let activationOpen = false;
      const playInvocations = [];
      const manualPlayer = engine('manual-resume', {
        backend: 'audio-stream',
        onPlayInvoked: () => playInvocations.push({ activationOpen })
      });
      manualPlayer.bookId = 'book-a';
      manualPlayer.isContinuous = true;
      manualPlayer.servedTier = 'premium';
      manualPlayer.endChapterIndex = 4;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: manualPlayer,
        chapter: uiElement
      });
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      appImports.transitionRequests.length = 0;
      const manualTransitions = appImports.transitionRequests;

      const interrupted = new Error('stream ended early');
      interrupted.code = 'CONTINUOUS_STREAM_EOF';
      interrupted.chapterTime = 412.5;
      globalThis.__playbackAppHarness.offerManualPlaybackRecovery(interrupted, {
        bookId: 'book-a',
        chapterIndex: 0,
        startOffsetSeconds: 412.5,
        servedTier: 'premium',
        endChapterIndex: 4
      });

      // Preparation happens before Resume is ever offered.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      const resumeToast = appImports.toasts.find(([, , options]) => options?.actionLabel === 'Resume');
      assert(resumeToast, 'a Resume action is offered once the source is prepared');
      assert(
        manualTransitions.length > 0,
        'the source was prepared before Resume was offered, not after the tap'
      );

      // The exact captured tuple reaches the engine verbatim.
      assert.deepStrictEqual(
        manualTransitions.at(-1).sourceTuple,
        { startOffsetSeconds: 412.5, servedTier: 'premium', endChapterIndex: 4 },
        'the immutable recovery snapshot is replayed verbatim'
      );

      // Now the tap. play() must be reached without any intervening await.
      playInvocations.length = 0;
      activationOpen = true;
      const resumeResult = resumeToast[2].onAction();
      activationOpen = false;
      await resumeResult;

      assert.strictEqual(playInvocations.length, 1, 'the Resume tap starts playback');
      assert.strictEqual(
        playInvocations[0].activationOpen,
        true,
        'play() is called synchronously inside the tap, not after an await'
      );

      // Superseding a manual preparation must suppress its late Resume UI. A
      // stale loadChapter returns without throwing, so ownership has to be
      // checked explicitly after the await.
      let releaseManualPreparation;
      appImports.transitionGate = new Promise(resolve => { releaseManualPreparation = resolve; });
      appImports.toasts.length = 0;
      appImports.resumePromptStates.length = 0;
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: manualPlayer,
        chapter: uiElement
      });
      globalThis.__playbackAppHarness.offerManualPlaybackRecovery(interrupted, {
        bookId: 'book-a',
        chapterIndex: 0,
        startOffsetSeconds: 412.5,
        servedTier: 'premium',
        endChapterIndex: 4
      });
      await new Promise(resolve => setImmediate(resolve));
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-b' },
        chapters: [{ title: 'Other' }],
        player: manualPlayer,
        chapter: uiElement
      });
      releaseManualPreparation();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      appImports.transitionGate = null;

      assert(
        !appImports.toasts.some(([, , options]) => options?.actionLabel === 'Resume'),
        'superseded manual preparation must not publish a Resume action'
      );
      assert(
        !appImports.resumePromptStates.includes(true),
        'superseded manual preparation must not reveal the resume prompt'
      );

      // A worker handoff block is a handled, unloaded result. Recovery must not
      // mistake its normal return for a prepared source and offer Resume.
      appImports.localSource = {
        available: false,
        url: null,
        mode: 'full',
        cached: true,
        reason: 'worker-update-required'
      };
      appImports.toasts.length = 0;
      appImports.overlays.length = 0;
      appImports.resumePromptStates.length = 0;
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: manualPlayer,
        chapter: uiElement
      });
      globalThis.__playbackAppHarness.offerManualPlaybackRecovery(interrupted, {
        bookId: 'book-a',
        chapterIndex: 0,
        startOffsetSeconds: 412.5,
        servedTier: 'premium',
        endChapterIndex: 4
      });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert(appImports.overlays.some(([state]) => state === 'error'));
      assert(
        !appImports.toasts.some(([, , options]) => options?.actionLabel === 'Resume'),
        'a blocked local source must not be reported as prepared'
      );
      assert(!appImports.resumePromptStates.includes(true));
      appImports.localSource = { available: false, url: null, mode: null };

      // --- No redundant seek after opening at the requested offset ----------
      // The engine already opened at the resume position. Seeking to it again
      // can relocate the stream (seek clamps to the estimated chapter duration),
      // spending a second session to reach where it already was.
      const openedPlayer = engine('opened-at-offset', { backend: 'audio-stream' });
      openedPlayer.isContinuous = true;
      openedPlayer.openedAtOffset = (chapterIndex, seconds) =>
        chapterIndex === 0 && Math.abs(seconds - 412.5) < 0.01;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: openedPlayer,
        chapter: uiElement
      });
      globalThis.__playbackAppHarness.cancelPlaybackRecovery();

      await globalThis.__playbackAppHarness.loadChapter(0, {
        reason: 'automatic-recovery',
        sourceTuple: { startOffsetSeconds: 412.5, chapterIndex: 0 },
        seekToSeconds: 412.5
      });

      assert(
        !openedPlayer.calls.some(call => call[0] === 'seek'),
        'no seek is issued when the source already opened at that offset'
      );

      // A finite/local source still needs its seek.
      const finiteSeekPlayer = engine('finite-seek', { backend: 'single-file' });
      finiteSeekPlayer.isContinuous = false;
      finiteSeekPlayer.openedAtOffset = () => false;
      globalThis.__playbackAppHarness.configure({
        book: { id: 'book-a' },
        chapters: [{ title: 'One' }, { title: 'Two' }],
        player: finiteSeekPlayer,
        chapter: uiElement
      });

      await globalThis.__playbackAppHarness.loadChapter(0, { seekToSeconds: 412.5 });

      assert.deepStrictEqual(
        finiteSeekPlayer.calls.filter(call => call[0] === 'seek'),
        [['seek', 412.5]],
        'a freely seekable source still receives its seek'
      );

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
