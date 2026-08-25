'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bookData(id) {
  return { book: { id, title: `Title ${id}` }, chapters: [{ title: 'One' }, { title: 'Two' }] };
}

function createHarness({
  initialBook = 'prior',
  apiGet,
  getBookPlaybackSettings,
  loadRestoredChapterImpl,
  restorePreviousSessionImpl
} = {}) {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const openBookSource = appSource.slice(
    appSource.indexOf('let openBookToken = 0;'),
    appSource.indexOf('let loadChapterToken')
  );
  const events = {
    hashes: [], pauses: 0, toasts: [], errors: [],
    chapterLoads: [], restored: null, restoreStarted: 0, errorObjs: []
  };
  const player = {
    isPlaying: true,
    getCurrentTime() { return 2221; },
    pause() {
      events.pauses++;
      this.isPlaying = false;
    }
  };
  const element = { textContent: '', innerHTML: '', value: '', hidden: false };
  const context = {
    console: { error(...args) { events.errors.push(args); events.errStacks = events.errStacks || []; try { events.errStacks.push(args[1] && args[1].stack || String(args[1] || args[0])); } catch(e){} }, warn() {}, log() {} },
    navigator: { onLine: true },
    window: { addEventListener() {} },
    API_BASE: '',
    encodeURIComponent,
    apiGet,
    getBookPlaybackSettings,
    shouldUseOfflineBookFallback: () => false,
    getOfflineBookData: () => null,
    syncPlayerHash(bookId) { events.hashes.push(bookId); },
    prioritizeForegroundBook: async () => true,
    offlineUnavailableOnlineRetry: { clear() {} },
    updatePlaybackUI() {},
    checkpointPlayback() {},
    refreshGuideState: async () => {},
    showAudioLoading() {},
    cacheBookMeta() {},
    cleanDisplayText: value => value || '',
    formatDuration: () => '',
    displayChapterTitle: chapter => chapter.title,
    escapeHTML: value => value,
    coverPlaceholderSrc: () => 'placeholder',
    updatePlayerAmbient() {},
    getLocalPlaybackCheckpoint: () => null,
    positionMatchesChapterStructure: () => false,
    normalizeServerPosition: () => null,
    chooseFreshestPosition: () => null,
    shouldAllowBackwardReconciliation: () => false,
    findPreferredStartChapterIndex: () => 0,
    playbackSession: { setBook() {} },
    updateChapterTrigger() {},
    renderChapterList() {},
    syncMiniPlayerInfo() {},
    renderOfflineState() {},
    updateMediaSessionMetadata() {},
    showView() {},
    loadVoices() {},
    loadPlaybackSpeed() {},
    restoreSleepTimer() {},
    savePosition: async () => {},
    showToast(...args) { events.toasts.push(args); },
    loadRestoredChapter: async (...args) => {
      events.chapterLoads.push(args);
      if (loadRestoredChapterImpl) return loadRestoredChapterImpl(...args);
      return { loaded: true };
    },
    currentBook: { id: initialBook, title: 'Prior title' },
    chapters: [{ title: 'Prior chapter' }],
    currentBookOfflineFallback: false,
    currentBookFinished: false,
    currentBookPlaybackSettings: {},
    currentChapter: 0,
    chunkPlayer: player,
    bookTitle: element,
    bookAuthorHeader: element,
    bookDescription: element,
    rebuildChaptersBtn: element,
    bookDetailsText: element,
    bookCover: { src: '', alt: '', onerror: null },
    chapterSelect: element,
    loadChapter: async (...a) => { events2.chapterLoads.push(a); return { loaded: true }; },
    restorePreviousSession: restorePreviousSessionImpl || (async previous => {
      events.restoreStarted += 1;
      events.restored = previous;
    }),
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(`let loadChapterToken = 0;\n${openBookSource}\nthis.harness = { openBook, currentBook: () => currentBook };`, context);
  return { ...context.harness, events, player };
}

async function run() {
  const repSettled = p => { let s=false; p.then(()=>{s=true;},()=>{s=true;}); setTimeout(()=>{},0); return s; };
  await test('404 leaves the active session playing and route unchanged', async () => {
    const harness = createHarness({
      apiGet: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
      getBookPlaybackSettings: async () => ({})
    });

    assert.strictEqual(await harness.openBook('missing'), false);
    assert.strictEqual(harness.currentBook().id, 'prior');
    assert.strictEqual(harness.player.isPlaying, true);
    assert.strictEqual(harness.events.pauses, 0);
    assert.deepStrictEqual(harness.events.hashes, []);
    assert.strictEqual(harness.events.restored, null,
      'a failure BEFORE commit never triggers restoration');
  });

  await test('playback-settings failure leaves the active session playing and route unchanged', async () => {
    const harness = createHarness({
      apiGet: async () => bookData('settings-fail'),
      getBookPlaybackSettings: async () => { throw new Error('settings unavailable'); }
    });

    assert.strictEqual(await harness.openBook('settings-fail'), false);
    assert.strictEqual(harness.currentBook().id, 'prior');
    assert.strictEqual(harness.player.isPlaying, true);
    assert.strictEqual(harness.events.pauses, 0);
    assert.deepStrictEqual(harness.events.hashes, []);
  });

  await test('only the latest overlapping open commits', async () => {
    const first = deferred();
    const harness = createHarness({
      apiGet: async url => url === '/api/book/first' ? first.promise : bookData('second'),
      getBookPlaybackSettings: async () => ({ playbackSpeed: 1 })
    });

    const earlierOpen = harness.openBook('first');
    await Promise.resolve();
    assert.strictEqual(await harness.openBook('second'), true, String(harness.events.errors));
    first.resolve(bookData('first'));
    assert.strictEqual(await earlierOpen, false);

    assert.strictEqual(harness.currentBook().id, 'second');
    assert.deepStrictEqual(harness.events.hashes, ['second']);
    assert.strictEqual(harness.events.pauses, 1);
  });

  await test('successful open loads the chapter engine before reporting success', async () => {
    const harness = createHarness({
      apiGet: async () => bookData('good'),
      getBookPlaybackSettings: async () => ({})
    });
    assert.strictEqual(await harness.openBook('good'), true);
    assert.strictEqual(harness.events.chapterLoads.length, 1,
      'the selected chapter is loaded through loadRestoredChapter exactly once');
    assert.strictEqual(harness.events.chapterLoads[0][0], 0,
      'the first content chapter is the default start');
    assert.strictEqual(harness.events.restored, null,
      'a successful open must not trigger session restoration');
  });

  await test('late-failure after commit restores the previous book', async () => {
    const harness = createHarness({
      apiGet: async () => bookData('next'),
      getBookPlaybackSettings: async () => ({}),
      // The chapter load itself fails AFTER the session was committed and the
      // old player paused — the exact stranding scenario from the review.
      loadRestoredChapterImpl: async () => { throw new Error('engine exploded'); }
    });
    assert.strictEqual(await harness.openBook('next'), false);
    assert.ok(harness.events.restored, 'restoration ran');
    assert.strictEqual(harness.events.restored.bookId, 'prior',
      'the interrupted prior session is what gets restored');
    assert.strictEqual(harness.events.restored.position.currentTime, 2221,
      'the snapshot keeps the live playback offset');
    assert.strictEqual(harness.events.pauses, 1,
      'the old player was paused at commit time');
    assert.strictEqual(harness.events.toasts.length, 1,
      'the user is told the open failed');
  });

  await test('stale failure cannot restore a snapshot from an older open', async () => {
    const first = deferred();
    const harness = createHarness({
      apiGet: async url => url === '/api/book/slow' ? first.promise : bookData('fast'),
      getBookPlaybackSettings: async () => ({})
    });
    const earlierOpen = harness.openBook('slow');
    await Promise.resolve();
    assert.strictEqual(await harness.openBook('fast'), true);
    first.reject(new Error('slow open failed'));
    assert.strictEqual(await earlierOpen, false);
    assert.strictEqual(harness.currentBook().id, 'fast',
      'the newer committed open still owns the player');
    assert.strictEqual(harness.events.restored, null,
      'a stale failure never triggers restoration');
  });

  await test('delayed restoration cannot overwrite a newer open', async () => {
    let releaseGate;
    const restoreGate = new Promise(resolve => { releaseGate = resolve; });
    let loadCount = 0;
    const harness = createHarness({
      apiGet: async url => url === '/api/book/replacement'
        ? bookData('replacement')
        : bookData('target'),
      getBookPlaybackSettings: async () => ({}),
      loadRestoredChapterImpl: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          // The doomed open's post-commit chapter load: hang until the
          // replacement open has committed, then fail late.
          await restoreGate;
          throw new Error('engine exploded late');
        }
        return { loaded: true };
      }
    });

    // The doomed open commits (pausing 'prior') and hangs in its chapter
    // load. While it is pending, the user opens a replacement that commits.
    const doomedOpen = harness.openBook('target');
    // Let the doomed open run through commit and block inside its gated
    // chapter load (several microtask turns: fetch, settings, position).
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(loadCount, 1, 'the doomed open holds the gated load');
    assert.strictEqual(await harness.openBook('replacement'), true);
    assert.strictEqual(harness.events.pauses, 2,
      'doomed commit paused prior; replacement commit paused the doomed target');

    // Release the gate: the doomed open fails late and its catch starts
    // restoring 'prior'. The restoration itself must not clobber the newer
    // open's committed state — the snapshot token guard discards it.
    releaseGate();
    await doomedOpen;
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));

    // The doomed open was superseded by the replacement BEFORE its late
    // failure, so the snapshot's stale-token guard must discard restoration:
    // the committed replacement stays the sole owner of the player.
    assert.strictEqual(harness.currentBook().id, 'replacement',
      'the superseded doomed open neither restores nor clobbers the newer book');
    assert.strictEqual(harness.events.toasts.length, 0,
      'a superseded open fails silently: the newer session owns the screen');
  });

  await test('the real restorePreviousSession discards itself when superseded', async () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const sliceStart = appSource.indexOf('let openBookToken = 0;');
    const sliceEnd = appSource.indexOf('let loadChapterToken');
    const combined = appSource.slice(sliceStart, sliceEnd)
      + '\n' + appSource.slice(
        appSource.indexOf('async function restorePreviousSession('),
        appSource.indexOf('async function prioritizeForegroundBook(')
      );
    const events2 = { fetches: [], loads: [], chapterLoads: [], hashes: [] };
    let releaseRestore;
    let gateReleased = false;
    const gate = new Promise(r => { releaseRestore = () => { gateReleased = true; r(); }; });
    const element2 = { textContent: '', innerHTML: '', value: '' };
    const ctx = {
      console: { error() {}, warn() {}, log() {} },
      navigator: { onLine: true },
      window: { addEventListener() {} },
      API_BASE: '',
      encodeURIComponent,
      apiGet: async url => {
        events2.fetches.push(url);
        // Gate ONLY the fresh-path fetch (second prior fetch); the stale
        // discard path returns immediately since its result is unused.
        if (url === '/api/book/prior' && gateReleased) await gate;
        return { book: { id: url.split('/').pop(), title: 'T' }, chapters: [{ title: 'C' }] };
      },
      getBookPlaybackSettings: async () => ({}),
      shouldUseOfflineBookFallback: () => false,
      getOfflineBookData: () => null,
      syncPlayerHash(bookId, options) { events2.hashes.push({ bookId, replace: Boolean(options?.replace) }); },
      prioritizeForegroundBook: async () => true,
      offlineUnavailableOnlineRetry: { clear() {} },
      updatePlaybackUI() {},
      checkpointPlayback() {},
      refreshGuideState: async () => {},
      showAudioLoading() {}, cacheBookMeta() {}, cleanDisplayText: v => v || '',
      formatDuration: () => '', displayChapterTitle: c => c.title,
      escapeHTML: v => v, coverPlaceholderSrc: () => 'p', updatePlayerAmbient() {},
      getLocalPlaybackCheckpoint: () => null, positionMatchesChapterStructure: () => false,
      normalizeServerPosition: () => null, chooseFreshestPosition: () => null,
      shouldAllowBackwardReconciliation: () => false,
      findPreferredStartChapterIndex: () => 0,
      playbackSession: { setBook() {} }, updateChapterTrigger() {},
      renderChapterList() {}, syncMiniPlayerInfo() {}, renderOfflineState() {},
      updateMediaSessionMetadata() {}, showView() {}, loadVoices() {},
      loadPlaybackSpeed() {}, restoreSleepTimer() {}, savePosition: async () => {},
      showToast() {},
      loadChapter: async (...a) => { events2.chapterLoads.push(['loadChapter', ...a]); return { loaded: true }; },
      loadRestoredChapter: async (...a) => { events2.chapterLoads.push(['loadRestoredChapter', ...a]); return { loaded: true }; },
      currentBook: { id: 'prior', title: 'Prior' },
      chapters: [{ title: 'Prior' }], currentBookOfflineFallback: false,
      currentBookFinished: false, currentBookPlaybackSettings: { playbackSpeed: 2 },
      currentChapter: 0, chunkPlayer: { isPlaying: false },
      bookTitle: element2, bookAuthorHeader: element2, bookDescription: element2,
      rebuildChaptersBtn: element2, bookDetailsText: element2,
      bookCover: { src: '', alt: '', onerror: null }, chapterSelect: element2,
      setTimeout, clearTimeout
    };
    vm.createContext(ctx);
    vm.runInContext(`let loadChapterToken = 0;\n${combined}\nthis.api = { restorePreviousSession };`, ctx);

    // Simulate: a failed open left snapshot token 1; a newer open advanced
    // the token to 2. Restoration must discard itself without touching state.
    // Drive the real function with a stale-token snapshot:
    const staleResult = await vm.runInContext(`
      openBookToken = 2; // newer open owns the player now
      restorePreviousSession({ token: 1, bookId: 'prior', chapterIndex: 0 });
    `, ctx);
    assert.strictEqual(staleResult, false, 'stale restoration discards itself');
    assert.strictEqual(ctx.currentBook.id, 'prior',
      'state untouched by the discarded restoration');
    assert.strictEqual(events2.chapterLoads.length, 0, 'no chapter load for a discarded restore');

    // Now the fresh path: token matches, restoration proceeds.
    releaseRestore();
    const fresh = await vm.runInContext(`
      openBookToken = 3; // the failed open still owns the player
      restorePreviousSession({
        token: 3,
        bookId: 'prior',
        chapterIndex: 0,
        playbackSettings: { playbackSpeed: 2 },
        position: { chapterIndex: 0, currentTime: 2221, chunkTime: 2221, timestamp: 2221 }
      });
    `, ctx);
    assert.strictEqual(fresh, true, 'current-token restoration completes');
    assert.strictEqual(events2.chapterLoads.length, 1, 'restoration reloads the previous chapter');
    assert.strictEqual(events2.chapterLoads[0][0], 'loadRestoredChapter',
      'restoration seeks through the restored-chapter path');
    assert.strictEqual(events2.chapterLoads[0][2].currentTime, 2221,
      'restoration keeps the saved playback offset');
    assert.deepStrictEqual(events2.hashes, [{ bookId: 'prior', replace: true }],
      'restoration replaces the failed book in history instead of pushing');
    assert.strictEqual(ctx.currentBook.id, 'prior', 'restored book is live in state');
    assert.strictEqual(ctx.chapters.length, 1, 'restored chapters are live in state');
    assert.strictEqual(ctx.currentBookPlaybackSettings.playbackSpeed, 2,
      'restoration restores the prior session settings');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
