'use strict';

// Behavioral tests: no server or browser dependencies. Hung fetches deliberately
// ignore abort so the deadline and stale-result fences are exercised directly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('public/app.js');
const body = name => {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `missing function ${name}`);
  return match[0];
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const quiet = { warn() {}, error() {}, log() {} };
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`  PASS ${name}`);
}

function apiHarness(fetchImpl) {
  const values = new Map();
  const context = {
    window: { location: { origin: 'https://books.test' }, fetch: fetchImpl },
    document: { cookie: '', dispatchEvent() {} },
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    navigator: { userAgent: 'test' },
    AbortController, FormData, setTimeout, clearTimeout, console: quiet,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  };
  context.fetch = (...args) => context.window.fetch(...args);
  vm.createContext(context);
  vm.runInContext(read('public/js/api.js').replace(/export /g, '') +
    '\nthis.api = { apiGet, apiSend, fetchAuthStatus, getCurrentUser };', context);
  return { ...context.api, values };
}

function workerHarness({ waiting = false, activate = true, getRegistration = null } = {}) {
  const events = { updates: 0, activations: 0, reloads: 0 };
  const oldWorker = { scriptURL: 'https://books.test/sw.js?v=old', state: 'activated' };
  const candidate = waiting ? {
    scriptURL: 'https://books.test/sw.js?v=new', state: 'installed',
    postMessage(_message, ports) {
      events.activations++;
      if (activate) this.state = 'activated';
      ports[0].postMessage({ activationRequested: activate });
    }
  } : null;
  const registration = {
    waiting: candidate, active: oldWorker,
    update() { events.updates++; return new Promise(() => {}); }
  };
  const session = new Map();
  const context = {
    navigator: { serviceWorker: {
      controller: oldWorker,
      getRegistration: getRegistration || (() => Promise.resolve(registration)),
      register() { throw new Error('a warm boot must reuse its registration'); }
    } },
    window: {
      location: { href: 'https://books.test/', reload() { events.reloads++; } },
      sessionStorage: {
        getItem: key => session.get(key), setItem: (key, value) => session.set(key, value),
        removeItem: key => session.delete(key)
      },
      setTimeout, clearTimeout
    },
    MessageChannel: class {
      constructor() {
        this.port1 = {};
        this.port2 = { postMessage: data => this.port1.onmessage?.({ data }) };
      }
    },
    URL, Date, Promise,
    SERVICE_WORKER_BOOT_DEADLINE_MS: 6000,
    OFFLINE_WORKER_SCRIPT_URL: '/sw.js?v=old',
    OFFLINE_WORKER_RELOAD_KEY: 'reload',
    serviceWorkerBootWindowOpen: true,
    offlineWorkerControllerState: () => ({ compatible: true }),
    certifyOfflineWorkerController: async () => ({ compatible: true })
  };
  vm.createContext(context);
  vm.runInContext([
    'waitForWorkerState', 'isExpectedOfflineWorker', 'requestWaitingWorkerActivation',
    'settleBeforeDeadline', 'prepareServiceWorkerForRouting'
  ].map(body).join('\n') + '\nthis.prepare = prepareServiceWorkerForRouting;', context);
  return { events, context, prepare: context.prepare };
}

(async () => {
  await test('a foreground deadline aborts a hung fetch even when fetch ignores the signal', async () => {
    let signal;
    const api = apiHarness(async (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    await assert.rejects(api.apiGet('/api/book/a', { timeoutMs: 10 }), error => error.name === 'TimeoutError');
    assert.equal(signal.aborted, true);
  });

  await test('the read deadline also bounds a stalled JSON response body', async () => {
    const api = apiHarness(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
    await assert.rejects(api.apiGet('/api/position/a', { timeoutMs: 10 }), error => error.name === 'TimeoutError');
  });

  await test('authoritative 401/403/404 cannot turn into a body timeout fallback', async () => {
    for (const status of [401, 403, 404]) {
      const api = apiHarness(async () => ({ ok: false, status, json: () => new Promise(() => {}) }));
      await assert.rejects(api.apiGet('/api/book/a', { timeoutMs: 10 }), error => error.status === status);
    }
  });

  await test('an already-cancelled read never starts fetch', async () => {
    let fetches = 0;
    const api = apiHarness(async () => { fetches++; });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.apiGet('/api/book/a', { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(fetches, 0);
  });

  await test('unbounded generation/write calls retain their existing lifetime', async () => {
    const response = deferred();
    let signal;
    const api = apiHarness((_url, init) => { signal = init.signal; return response.promise; });
    const write = api.apiSend('POST', '/api/tts', { text: 'long chapter' });
    assert.equal(signal, undefined, 'no default cancellation deadline is installed');
    response.resolve({ ok: true, status: 200, json: async () => ({ ready: true }) });
    assert.equal((await write).ready, true);
  });

  await test('late auth responses after the boot deadline cannot change account scope', async () => {
    const response = deferred();
    const api = apiHarness(() => response.promise);
    await assert.rejects(api.fetchAuthStatus({ timeoutMs: 10 }), error => error.name === 'TimeoutError');
    response.resolve({ ok: true, status: 200, json: async () => ({ user: { id: 'other' }, authenticated: true }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(api.getCurrentUser(), null);
    assert.equal(api.values.has('xandrio_offline_account_scope'), false);
  });

  await test('deployment deadline uses only an earlier verified canonical origin', async () => {
    const response = deferred();
    const values = new Map([['xandrio_deployment_origin', JSON.stringify({ canonicalOrigin: 'https://canonical.test' })]]);
    const context = { URL, AbortController, setTimeout, clearTimeout };
    vm.createContext(context);
    vm.runInContext(read('public/js/deployment-origin.js').replace(/export /g, '') + '\nthis.init = initDeploymentGuard;', context);
    const result = await context.init({
      fetchImpl: () => response.promise, timeoutMs: 10,
      currentUrl: 'https://books.test/', isSecureContext: true,
      storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
    });
    assert.equal(result.serviceWorkerAllowed, false);
    assert.equal(result.href, 'https://canonical.test/');
    response.resolve({ ok: true, json: async () => ({ canonicalOrigin: '' }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(values.get('xandrio_deployment_origin')).canonicalOrigin, 'https://canonical.test');
  });

  await test('a certified warm worker starts update in the background without awaiting the network', async () => {
    const harness = workerHarness();
    assert.equal((await harness.prepare()).ready, true);
    assert.equal(harness.events.updates, 1);
    assert.equal(harness.events.reloads, 0);
  });

  await test('a newer compatible waiting build activates and reloads before routing', async () => {
    const harness = workerHarness({ waiting: true });
    assert.equal((await harness.prepare()).reason, 'reloading');
    assert.equal(harness.events.activations, 1);
    assert.equal(harness.events.reloads, 1);
    assert.equal(harness.events.updates, 0, 'a network update cannot delay an already complete waiting build');
  });

  await test('another-client activation refusal keeps the warm shell and never reloads', async () => {
    const harness = workerHarness({ waiting: true, activate: false });
    assert.equal((await harness.prepare()).ready, true);
    assert.equal(harness.events.activations, 1);
    assert.equal(harness.events.reloads, 0);
  });

  await test('a late online registration cannot activate a waiting build after routing', async () => {
    const harness = workerHarness({ waiting: true });
    harness.context.serviceWorkerBootWindowOpen = false;
    assert.equal((await harness.prepare()).ready, true);
    assert.equal(harness.events.activations, 0);
    assert.equal(harness.events.reloads, 0);
  });

  await test('a restored-position seek is discarded after another chapter takes ownership', async () => {
    const load = deferred();
    let seeks = 0;
    const context = {
      currentBook: { id: 'book' }, openBookToken: 1, loadChapterToken: 0,
      playableChapterAt: index => index, currentChapter: 0,
      chunkPlayer: {}, loadChapter() { context.loadChapterToken++; return load.promise; },
      restorePlaybackPosition: async () => { seeks++; }
    };
    vm.createContext(context);
    vm.runInContext(body('loadRestoredChapter') + '\nthis.restore = loadRestoredChapter;', context);
    const restoring = context.restore(0, { timestamp: 90 });
    context.loadChapterToken++;
    load.resolve({ loaded: true });
    assert.equal((await restoring).reason, 'stale');
    assert.equal(seeks, 0);
  });

  await test('an owned local-to-stream retry retains its restored-position seek', async () => {
    const load = deferred();
    let seeks = 0;
    const context = {
      currentBook: { id: 'book' }, openBookToken: 1, loadChapterToken: 0,
      playableChapterAt: index => index, currentChapter: 0,
      chunkPlayer: {}, loadChapter() { context.loadChapterToken++; return load.promise; },
      restorePlaybackPosition: async () => { seeks++; }
    };
    vm.createContext(context);
    vm.runInContext(body('loadRestoredChapter') + '\nthis.restore = loadRestoredChapter;', context);
    const restoring = context.restore(0, { timestamp: 90 });
    context.loadChapterToken++;
    load.resolve({ loaded: true, loadToken: context.loadChapterToken });
    assert.equal((await restoring).loaded, true);
    assert.equal(seeks, 1, 'a nested retry returns the token which owns its successful source');
  });

  await test('play intent timing covers metadata, source assignment, playing, and first advancing playhead', async () => {
    let now = 0;
    let writes = 0;
    const context = {
      performance: { now: () => now },
      playbackAttemptSequence: 0, activePlaybackAttempt: null,
      openBookToken: 1, currentBook: { id: 'outgoing' }, currentChapter: 0,
      playbackEventLedger: [], persistedPlaybackEventLedger: [],
      PLAYBACK_EVENT_LEDGER_LIMIT: 80, PLAYBACK_EVENT_LEDGER_KEY: 'events',
      window: { localStorage: { setItem() { writes++; } } },
      document: { visibilityState: 'visible' },
      audioPlayer: { currentTime: 10, paused: false, buffered: { length: 0 } },
      chunkPlayer: { bookId: 'new', getCurrentTime: () => 10 }
    };
    vm.createContext(context);
    vm.runInContext([
      'finitePlaybackNumber', 'playbackAttemptNow', 'beginPlaybackAttempt',
      'bindPlaybackAttemptToOpen', 'observePlaybackAttemptProgress', 'recordPlaybackEvent'
    ].map(body).join('\n'), context);
    const attempt = context.beginPlaybackAttempt('new', 'resume');
    context.bindPlaybackAttemptToOpen(attempt, 1);
    now = 20;
    context.recordPlaybackEvent({ type: 'book-metadata-ready', bookId: 'new' });
    now = 30;
    context.currentBook = { id: 'new' };
    context.recordPlaybackEvent({ type: 'source-load', bookId: 'outgoing' });
    assert.equal(context.playbackEventLedger.at(-1).attemptId, undefined);
    context.recordPlaybackEvent({ type: 'source-load', bookId: 'new' });
    now = 80;
    context.recordPlaybackEvent({ type: 'playing', bookId: 'new', streamTime: 10 });
    const writesBeforeProgress = writes;
    now = 120;
    context.audioPlayer.currentTime = 10.2;
    context.observePlaybackAttemptProgress();
    const milestones = context.playbackEventLedger.filter(event => event.attemptId === attempt.id);
    assert.deepEqual(Array.from(milestones, event => event.type), [
      'play-intent', 'book-metadata-ready', 'source-load', 'playing', 'playhead-advanced'
    ]);
    assert.deepEqual(Array.from(milestones, event => event.elapsedMs), [0, 20, 30, 80, 120]);
    assert.equal(writes, writesBeforeProgress, 'advancing-playhead timing stays in memory');
    assert.equal(context.activePlaybackAttempt, null, 'the first advancement completes this timing attempt');
  });

  await test('a superseded attempt and an old ready source cannot complete the new attempt', async () => {
    const context = {
      performance: { now: () => 0 }, playbackAttemptSequence: 0,
      activePlaybackAttempt: null, openBookToken: 1,
      currentBook: { id: 'same-book' }, currentChapter: 0,
      playbackEventLedger: [], persistedPlaybackEventLedger: [],
      PLAYBACK_EVENT_LEDGER_LIMIT: 80, PLAYBACK_EVENT_LEDGER_KEY: 'events',
      window: { localStorage: { setItem() {} } }, document: {},
      audioPlayer: null, chunkPlayer: { bookId: 'same-book' }
    };
    vm.createContext(context);
    vm.runInContext([
      'finitePlaybackNumber', 'playbackAttemptNow', 'beginPlaybackAttempt',
      'bindPlaybackAttemptToOpen', 'recordPlaybackEvent'
    ].map(body).join('\n'), context);
    const first = context.beginPlaybackAttempt('same-book', 'resume');
    context.openBookToken++;
    context.recordPlaybackEvent({ type: 'book-metadata-ready', bookId: 'same-book' });
    assert.equal(context.playbackEventLedger.at(-1).attemptId, undefined, 'old open token cannot attach timing');
    const second = context.beginPlaybackAttempt('same-book', 'resume');
    context.recordPlaybackEvent({ type: 'playing', bookId: 'same-book', streamTime: 100 });
    assert.notEqual(first.id, second.id);
    assert.equal(context.playbackEventLedger.at(-1).attemptId, undefined, 'outgoing source has not been assigned to this intent');
    assert.equal(second.playingAt, null);
  });

  await test('per-book settings use only a fresh queue cache and keep cached speed on bounded refresh failure', async () => {
    let now = 100;
    let userId = 'user-a';
    const calls = [];
    const context = {
      getCurrentUserId: () => userId,
      apiGet: async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/listening-queue') return {
          queue: { bookIds: [], bookSettings: { book: { playbackSpeed: 1.4 } } }, books: []
        };
        throw new Error('unreachable');
      },
      apiSend: async () => ({}),
      Date: { now: () => now }, console: quiet,
      document: { getElementById: () => null, dispatchEvent() {} },
      CustomEvent: class {}
    };
    vm.createContext(context);
    vm.runInContext(read('public/js/features/listening-queue.js')
      .replace(/^import .*;\n/gm, '').replace(/export /g, '') +
      '\nthis.queue = { loadListeningQueue, getBookPlaybackSettings };', context);
    await context.queue.loadListeningQueue();
    assert.equal((await context.queue.getBookPlaybackSettings('book')).playbackSpeed, 1.4);
    assert.equal(calls.length, 1, 'fresh queue data avoids another foreground settings read');
    now += 31_000;
    assert.equal((await context.queue.getBookPlaybackSettings('book')).playbackSpeed, 1.4);
    assert.equal(calls.length, 2, 'an older queue triggers a bounded remote refresh');
    assert.equal(calls.at(-1).options.timeoutMs, 1500);
    userId = 'user-b';
    assert.equal((await context.queue.getBookPlaybackSettings('book')).playbackSpeed, undefined, 'fallback settings never cross accounts');
  });

  await test('an account edit superseding a settings read cannot return the previous account cache', async () => {
    let userId = 'user-a';
    let resolveSettings;
    const context = {
      getCurrentUserId: () => userId,
      apiGet: async url => {
        if (url === '/api/listening-queue') return {
          queue: { bookIds: [], bookSettings: { book: { playbackSpeed: 1.4 } } }, books: []
        };
        return new Promise(resolve => { resolveSettings = resolve; });
      },
      apiSend: async () => ({ settings: { playbackSpeed: 1.8 } }),
      Date, console: quiet,
      document: { getElementById: () => null, dispatchEvent() {} },
      CustomEvent: class {}
    };
    vm.createContext(context);
    vm.runInContext(read('public/js/features/listening-queue.js')
      .replace(/^import .*;\n/gm, '').replace(/export /g, '') +
      '\nthis.queue = { loadListeningQueue, getBookPlaybackSettings, saveBookPlaybackSettings };', context);
    await context.queue.loadListeningQueue();
    userId = 'user-b';
    const pending = context.queue.getBookPlaybackSettings('book');
    await context.queue.saveBookPlaybackSettings('book', { playbackSpeed: 1.8 });
    resolveSettings({ settings: { playbackSpeed: 1.6 } });
    assert.equal((await pending).playbackSpeed, undefined, 'a superseded read cannot consult another account cache');
  });

  console.log(`\n${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
