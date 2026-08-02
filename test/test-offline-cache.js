const assert = require('assert');
const crypto = require('crypto');
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
    console.error(`    ${error.stack || error.message}`);
  }
}

function makeCache({ transformBytes = null } = {}) {
  const entries = new Map();
  const keyOf = input => typeof input === 'string' ? input : input.url;
  return {
    entries,
    async match(input) {
      const response = entries.get(keyOf(input));
      return response ? response.clone() : undefined;
    },
    async put(input, response) {
      const headers = new Headers(response.headers);
      const sourceBytes = new Uint8Array(await response.arrayBuffer());
      const bytes = transformBytes
        ? transformBytes(new Uint8Array(sourceBytes))
        : sourceBytes;
      entries.set(keyOf(input), new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers
      }));
    },
    async delete(input) {
      return entries.delete(keyOf(input));
    },
    async keys() {
      return [...entries.keys()].map(key => new Request(key));
    }
  };
}

// The exact service-worker version offline.js pins itself to. Read from sw.js
// so this harness exercises the real contract rather than a stand-in.
const SW_CACHE_VERSION = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')
  .match(/const CACHE_VERSION = '([^']+)'/)[1];

function offlineAudioKey(bookId, chapterIndex, scope = 'default') {
  const url = new URL(`https://reader.test/api/audio/${encodeURIComponent(bookId)}/${chapterIndex}`);
  url.searchParams.set('xandrio-offline-scope', scope);
  return url.toString();
}

function installBrowser({
  book,
  chapters,
  cache,
  titleCache = makeCache(),
  manifest = {},
  variants = ['voice-a', 'voice-a'],
  failStorageWrites = false,
  audioGate = null,
  transientAudioFailures = 0,
  transientStreamFailures = 0,
  storagePersisted = false,
  persistResult = true,
  scope = 'default',
  storage: sharedStorage = null,
  cacheStores = null,
  deletionResponse = { revision: 0, deletions: [] },
  canClaimLegacy = true,
  preparationResponse = null,
  preparationGate = null,
  preparationGateBookId = null,
  serverContentHash = false,
  confirmationResult = true,
  wakeLockSupported = false,
  persistenceGate = null,
  statusForChapter = null,
  // Version-pinned by default: the app registers /sw.js?v=<CACHE_VERSION>, so a
  // controller carrying that exact version is the normal steady state. Tests
  // that need the rollout race pass an unversioned or mismatched scriptURL.
  serviceWorkerController = { scriptURL: `https://reader.test/sw.js?v=${SW_CACHE_VERSION}` },
  verificationProbe = null
}) {
  const storage = sharedStorage || new Map();
  if (!storage.has('xandrio_offline_books')) {
    storage.set('xandrio_offline_books', JSON.stringify(manifest));
  }
  global.__offlineScope = scope;
  global.__canClaimLegacy = canClaimLegacy;
  const confirmationCalls = [];
  global.__offlineConfirmSheet = async options => {
    confirmationCalls.push(options);
    return confirmationResult;
  };
  let hashCalls = 0;
  Object.defineProperty(global, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      subtle: {
        digest(...args) {
          hashCalls += 1;
          return crypto.webcrypto.subtle.digest(...args);
        }
      }
    }
  });
  const elements = new Map([
    ['player-voice-name', { textContent: 'Narrator' }]
  ]);
  const documentEvents = [];
  const documentListeners = new Map();
  global.localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => {
      if (failStorageWrites) throw new Error('quota exceeded');
      storage.set(key, String(value));
    },
    removeItem: key => storage.delete(key)
  };
  global.window = { location: { origin: 'https://reader.test' }, addEventListener() {} };
  global.document = {
    hidden: false,
    documentElement: { dataset: {} },
    getElementById: id => elements.get(id) || null,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      documentEvents.push(event);
      for (const listener of documentListeners.get(event.type) || []) listener(event);
      return true;
    }
  };
  const persistenceCalls = [];
  const wakeLockCalls = [];
  let wakeLockReleaseListener = null;
  let wakeLockGate = null;
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      onLine: true,
      // A download is only "Downloaded" once the exact scoped service-worker
      // path has been proven to serve it, so the page must be controlled.
      serviceWorker: serviceWorkerController === null
        ? {}
        : { controller: serviceWorkerController },
      ...(wakeLockSupported ? {
        wakeLock: {
          async request(type) {
            wakeLockCalls.push(`request:${type}`);
            if (wakeLockGate) await wakeLockGate.promise;
            return {
              addEventListener(event, listener) {
                if (event === 'release') wakeLockReleaseListener = listener;
              },
              async release() {
                wakeLockCalls.push('release');
              }
            };
          }
        }
      } : {}),
      storage: {
        estimate: async () => ({ quota: 1000000, usage: 0 }),
        persisted: async () => {
          persistenceCalls.push('persisted');
          if (persistenceGate) await persistenceGate;
          return storagePersisted;
        },
        persist: async () => {
          persistenceCalls.push('persist');
          return persistResult;
        }
      }
    }
  });
  global.caches = {
    open: async name => {
      if (cacheStores) {
        if (!cacheStores.has(name)) cacheStores.set(name, makeCache());
        return cacheStores.get(name);
      }
      return name.startsWith('xandrio-offline-titles') ? titleCache : cache;
    }
  };
  global.window.caches = global.caches;
  const audioRequests = [];
  const statusRequests = [];
  const verificationProbes = [];
  const prepareCalls = [];
  const prepareBodies = [];
  const preparationCalls = [];
  let remainingAudioFailures = transientAudioFailures;
  let remainingStreamFailures = transientStreamFailures;
  global.__offlineApiSend = async (method, requestPath, body) => {
    if (method === 'GET' && requestPath.startsWith('/api/offline/deletions')) {
      return deletionResponse;
    }
    if (requestPath.startsWith('/api/offline/preparation/')) {
      preparationCalls.push({ method, requestPath });
      if (
        preparationGate &&
        (!preparationGateBookId || requestPath.endsWith(`/${encodeURIComponent(preparationGateBookId)}`))
      ) await preparationGate;
      return {
        bookId: book?.id,
        state: 'ready',
        readyChapters: chapters.length,
        totalChapters: chapters.length,
        percent: 100,
        bytesPrepared: chapters.length * 100,
        bytesTotal: chapters.length * 100,
        bitrateKbps: 48,
        packageVariantKey: variants[0] || 'voice-a',
        ...(preparationResponse || {})
      };
    }
    if (method === 'POST' && requestPath.includes('/prepare-chapter-audio')) {
      prepareCalls.push(Number(requestPath.match(/\/(\d+)\/prepare-chapter-audio$/)?.[1]));
      prepareBodies.push(body);
    }
    return {};
  };
  global.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : (input.url || String(input));
    const chapter = Number(url.match(/(?:\/api\/chunks\/[^/]+\/|\/api\/(?:offline\/)?audio\/[^/]+\/)(\d+)/)?.[1]);
    if (url.includes('chapter-audio-status')) {
      statusRequests.push(url);
      return Response.json(statusForChapter
        ? statusForChapter(chapter)
        : { ready: true, variantKey: variants[chapter], url: `/api/audio/${book.id}/${chapter}` });
    }
    // Post-download verification probe: the scoped playback URL with a Range.
    // This is the request the media element will really make, served by the
    // service worker from cache, so the markers below are what prove the route
    // works rather than merely that bytes were stored.
    const rangeHeader = options.headers?.Range || input?.headers?.get?.('Range');
    if (url.includes('xandrio-offline-scope=') && rangeHeader) {
      verificationProbes.push(url);
      if (verificationProbe) return verificationProbe(url, chapter);
      const size = new TextEncoder().encode(`audio-${variants[chapter]}-${chapter}`).byteLength;
      return new Response(new Uint8Array([0, 0]), {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-1/${size}`,
          'Content-Length': '2',
          'X-Xandrio-Offline-Cache': 'hit',
          'X-Xandrio-SW': SW_CACHE_VERSION
        }
      });
    }
    if (url.includes('/api/audio/') || url.includes('/api/offline/audio/')) {
      audioRequests.push(chapter);
      if (audioGate) await audioGate;
      if (remainingAudioFailures > 0) {
        remainingAudioFailures -= 1;
        return new Response('try again', { status: 503 });
      }
      const bytes = new TextEncoder().encode(`audio-${variants[chapter]}-${chapter}`);
      const responseHeaders = {
        'Content-Length': String(bytes.byteLength),
        ETag: `\"${variants[chapter]}-${chapter}\"`
      };
      if (serverContentHash && options.headers?.['X-Xandrio-Offline-Download'] === '1') {
        responseHeaders['X-Xandrio-Content-SHA256'] =
          `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      }
      if (remainingStreamFailures > 0) {
        remainingStreamFailures -= 1;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 2));
            controller.error(new Error('connection dropped'));
          }
        });
        return new Response(stream, {
          headers: responseHeaders
        });
      }
      return new Response(bytes, { headers: responseHeaders });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  return {
    storage,
    audioRequests,
    statusRequests,
    verificationProbes,
    prepareCalls,
    prepareBodies,
    preparationCalls,
    documentEvents,
    persistenceCalls,
    confirmationCalls,
    wakeLockCalls,
    setDocumentHidden(hidden) {
      document.hidden = hidden;
      if (hidden) {
        wakeLockReleaseListener?.();
        wakeLockReleaseListener = null;
      }
      document.dispatchEvent(new Event('visibilitychange'));
    },
    deferNextWakeLock() {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      wakeLockGate = {
        promise,
        resolve() {
          wakeLockGate = null;
          resolve();
        }
      };
      return wakeLockGate;
    },
    get hashCalls() { return hashCalls; },
    titleCache,
    init: { getCurrentBook: () => book, getChapters: () => chapters }
  };
}

(async () => {
  // API_BASE is captured while the module evaluates.
  global.window = { location: { origin: 'https://reader.test' }, addEventListener() {} };
  global.crypto = require('crypto').webcrypto;
  let source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'offline.js'), 'utf8');
  source = source
    .replace(
      "import { API_BASE, apiSend, canClaimLegacyOfflineStorage, getOfflineStorageScopeId } from '../api.js';",
      "const API_BASE = window.location.origin; const apiSend = (...args) => globalThis.__offlineApiSend(...args); const canClaimLegacyOfflineStorage = () => globalThis.__canClaimLegacy !== false; const getOfflineStorageScopeId = () => globalThis.__offlineScope || 'default';"
    )
    .replace("import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';", "const escapeHTML = value => String(value); const relativeTime = () => ''; const formatDuration = () => '';")
    .replace("import { readJSON, writeJSON } from '../util/storage.js';", "const readJSON = (key, fallback = null) => { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }; const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };")
    .replace("import { showToast, showUndoToast } from '../ui/toast.js';", "const showToast = () => {}; const showUndoToast = () => {};")
    .replace("import { confirmSheet } from '../ui/confirm.js';", "const confirmSheet = (...args) => globalThis.__offlineConfirmSheet(...args);")
    .replace(
      "import { planRollingOfflineWindow } from './rolling-offline.mjs';",
      "const planRollingOfflineWindow = ({ currentChapter, chapterCount, cachedChapters = [] }) => { const first = Math.max(0, currentChapter - 1); const last = Math.min(chapterCount - 1, currentChapter + 2); const retain = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index); const cached = new Set(cachedChapters); const kept = new Set(retain); return { retain, prepare: retain.filter(index => !cached.has(index)), evict: [...cached].filter(index => !kept.has(index)).sort((a, b) => a - b) }; };"
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const offline = await import(moduleUrl);
  const book = { id: 'book-1', title: 'A Book' };
  const chapters = [{}, {}];

  await test('reports whether this browser can store offline audio', async () => {
    const cache = makeCache();
    installBrowser({ book, chapters, cache });
    assert.strictEqual(offline.offlineDownloadsSupported(), true);

    document.documentElement.dataset.pwaStorageAllowed = 'false';
    assert.strictEqual(offline.offlineDownloadsSupported(), false);
    delete document.documentElement.dataset.pwaStorageAllowed;

    delete global.caches;
    delete global.window.caches;
    assert.strictEqual(offline.offlineDownloadsSupported(), false);
  });

  await test('offers server preparation before a device download', async () => {
    const cache = makeCache();
    installBrowser({ book, chapters, cache });

    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'ready-to-prepare');
    assert.strictEqual(
      offline.offlineStatusForBook(book.id).label,
      'Prepare for offline'
    );
  });

  await test('all full-title downloads enter through durable server preparation', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadBookForOffline(book, chapters), true);
    assert.deepStrictEqual(env.preparationCalls.map(call => call.method), ['GET']);
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.deepStrictEqual(env.audioRequests, [0, 1]);
    assert(
      env.statusRequests.length <= 1,
      'device transfer must not poll generation status chapter by chapter'
    );
  });

  await test('reload resumes an interrupted device transfer without another confirmation', async () => {
    const cache = makeCache();
    const interrupted = {
      bookId: book.id,
      title: book.title,
      chapters: chapters.length,
      chapterEntries: chapters.map(() => null),
      titleData: { book, chapters },
      bytes: 0,
      downloadedAt: null,
      downloadStartedAt: '2026-07-26T00:00:00.000Z',
      progressPercent: 20,
      progressPhase: 'Interrupted',
      autoResume: true,
      manifestVersion: 3,
      mode: 'full',
      state: 'repairing'
    };
    const env = installBrowser({
      book,
      chapters,
      cache,
      manifest: { [book.id]: interrupted }
    });

    assert.strictEqual(await offline.resumeInterruptedOfflineDownloads(), true);
    assert.deepStrictEqual(env.confirmationCalls, []);
    assert.deepStrictEqual(env.audioRequests, [0, 1]);
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'ready');
  });

  await test('does not offer device download when browser storage is unavailable', async () => {
    const cache = makeCache();
    const prepared = {
      bookId: book.id,
      title: book.title,
      chapters: chapters.length,
      chapterEntries: chapters.map(() => null),
      titleData: { book, chapters },
      manifestVersion: 3,
      mode: 'full',
      state: 'prepared'
    };
    installBrowser({
      book,
      chapters,
      cache,
      manifest: { [book.id]: prepared }
    });
    delete global.caches;
    delete global.window.caches;

    assert.deepStrictEqual(
      offline.offlineStatusForBook(book.id),
      {
        kind: 'download-unavailable',
        label: 'Downloads unavailable in this browser',
        downloaded: false,
        cachedChapters: 0,
        totalChapters: 2
      }
    );
  });

  await test('refreshes Safari PWA download controls after deployment verification recovers', async () => {
    const cache = makeCache();
    const prepared = {
      bookId: book.id,
      title: book.title,
      chapters: chapters.length,
      chapterEntries: chapters.map(() => null),
      titleData: { book, chapters },
      manifestVersion: 3,
      mode: 'full',
      state: 'prepared'
    };
    installBrowser({
      book,
      chapters,
      cache,
      manifest: { [book.id]: prepared }
    });
    document.documentElement.dataset.pwaStorageAllowed = 'false';
    offline.initOffline({ getCurrentBook: () => null, getChapters: () => [] });

    let renderedKind = offline.offlineStatusForBook(book.id).kind;
    document.addEventListener('xandrio:offlinechange', () => {
      renderedKind = offline.offlineStatusForBook(book.id).kind;
    });
    document.documentElement.dataset.pwaStorageAllowed = 'true';
    document.dispatchEvent(new CustomEvent('xandrio:deploymentchange', {
      detail: { serviceWorkerAllowed: true }
    }));

    assert.strictEqual(renderedKind, 'prepared');
  });

  await test('does not offer device download while the browser is offline', async () => {
    const cache = makeCache();
    const prepared = {
      bookId: book.id,
      title: book.title,
      chapters: chapters.length,
      chapterEntries: chapters.map(() => null),
      titleData: { book, chapters },
      manifestVersion: 3,
      mode: 'full',
      state: 'prepared'
    };
    installBrowser({
      book,
      chapters,
      cache,
      manifest: { [book.id]: prepared }
    });
    navigator.onLine = false;

    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'download-offline');
    assert.strictEqual(offline.offlineStatusForBook(book.id).label, 'Connect to download');
  });

  await test('requests persistent storage for a user-initiated full-book download', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.deepStrictEqual(env.persistenceCalls, ['persisted', 'persist']);
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, true);
  });

  await test('requires an explicit keep-visible acknowledgement before transferring audio', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      confirmationResult: false
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), false);
    assert.strictEqual(env.confirmationCalls.length, 1);
    assert.strictEqual(env.confirmationCalls[0].title, 'Keep Xandrio visible');
    assert.match(env.confirmationCalls[0].message, /about \d+ (?:MB|GB)/i);
    assert.match(env.confirmationCalls[0].message, /wi-fi or mobile data/i);
    assert.match(env.confirmationCalls[0].message, /do not close xandrio/i);
    assert.match(env.confirmationCalls[0].message, /switch apps.*lock/i);
    assert.deepStrictEqual(env.persistenceCalls, []);
    assert.deepStrictEqual(env.audioRequests, []);
  });

  await test('reserves download ownership before asynchronous browser setup', async () => {
    const cache = makeCache();
    let releasePersistence;
    const persistenceGate = new Promise(resolve => { releasePersistence = resolve; });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      persistenceGate
    });
    offline.initOffline(env.init);

    const firstDownload = offline.downloadBookForOffline(
      book,
      [{}],
      { confirmForeground: false }
    );
    for (let attempt = 0; attempt < 20 && env.persistenceCalls.length === 0; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const secondDownload = offline.downloadBookForOffline(
      book,
      [{}],
      { confirmForeground: false }
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepStrictEqual(env.persistenceCalls, ['persisted']);
    assert.strictEqual(await secondDownload, false);
    releasePersistence();
    assert.strictEqual(await firstDownload, false);
    assert.deepStrictEqual(env.audioRequests, []);
  });

  await test('holds a screen wake lock for the active download and releases it afterwards', async () => {
    const cache = makeCache();
    let releaseAudio;
    const audioGate = new Promise(resolve => { releaseAudio = resolve; });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      audioGate,
      wakeLockSupported: true
    });
    offline.initOffline(env.init);

    const download = offline.downloadCurrentBook();
    for (let attempt = 0; attempt < 20 && env.wakeLockCalls.length === 0; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const callsWhileDownloading = [...env.wakeLockCalls];
    releaseAudio();
    assert.strictEqual(await download, true);
    assert.deepStrictEqual(callsWhileDownloading, ['request:screen']);
    assert.deepStrictEqual(env.wakeLockCalls, ['request:screen', 'release']);
  });

  await test('reacquires the screen wake lock if a live download returns to the foreground', async () => {
    const cache = makeCache();
    let releaseAudio;
    const audioGate = new Promise(resolve => { releaseAudio = resolve; });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      audioGate,
      wakeLockSupported: true
    });
    offline.initOffline(env.init);

    const download = offline.downloadCurrentBook();
    for (let attempt = 0; attempt < 20 && env.wakeLockCalls.length < 1; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    env.setDocumentHidden(true);
    env.setDocumentHidden(false);
    for (let attempt = 0; attempt < 20 && env.wakeLockCalls.length < 2; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const callsAfterReturn = [...env.wakeLockCalls];
    releaseAudio();

    assert.strictEqual(await download, true);
    assert.deepStrictEqual(callsAfterReturn, ['request:screen', 'request:screen']);
    assert.deepStrictEqual(env.wakeLockCalls, ['request:screen', 'request:screen', 'release']);
  });

  await test('deduplicates a late wake-lock request and releases it after the download finishes', async () => {
    const cache = makeCache();
    let releaseAudio;
    const audioGate = new Promise(resolve => { releaseAudio = resolve; });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      audioGate,
      wakeLockSupported: true
    });
    offline.initOffline(env.init);

    const download = offline.downloadCurrentBook();
    for (let attempt = 0; attempt < 20 && env.wakeLockCalls.length < 1; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    env.setDocumentHidden(true);
    const lateWakeLock = env.deferNextWakeLock();
    env.setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    for (let attempt = 0; attempt < 20 && env.wakeLockCalls.length < 2; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    releaseAudio();
    await new Promise(resolve => setImmediate(resolve));
    lateWakeLock.resolve();

    assert.strictEqual(await download, true);
    assert.deepStrictEqual(env.wakeLockCalls, [
      'request:screen',
      'request:screen',
      'release'
    ]);
  });

  await test('continues a download when persistent storage is denied', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      persistResult: false
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.deepStrictEqual(env.persistenceCalls, ['persisted', 'persist']);
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, true);
  });

  await test('isolates downloaded titles and cached media by account in a shared browser', async () => {
    const storage = new Map();
    const cacheStores = new Map();
    let env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_a',
      storage,
      cacheStores
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert(offline.offlineEntryForBook(book.id));

    env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_b',
      storage,
      cacheStores
    });
    offline.initOffline(env.init);
    assert.strictEqual(offline.offlineEntryForBook(book.id), null);
    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 0), false);

    env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_a',
      storage,
      cacheStores
    });
    offline.initOffline(env.init);
    assert(offline.offlineEntryForBook(book.id));
    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 0), true);
    assert(storage.has('xandrio_offline_books:account_a'));
    assert(storage.has('xandrio_offline_books:account_b'));
    assert(cacheStores.has('xandrio-offline-audio:account_a'));
    assert(
      [...cacheStores.get('xandrio-offline-audio:account_a').entries.keys()]
        .every(key => key.includes('xandrio-offline-scope=account_a'))
    );
  });

  await test('migrates legacy unscoped media into the owning account cache', async () => {
    const storage = new Map();
    const entry = {
      bookId: book.id,
      title: book.title,
      chapters: 1,
      chapterEntries: [{
        size: 6,
        contentHash: 'sha256-c49fea7425fa7f8699897a97c159c6690267d9003bb78c53fafa8fc15c325d84',
        variantKey: 'voice-a'
      }],
      titleData: { book, chapters: [{}] },
      downloadedAt: '2026-07-24T12:00:00.000Z',
      manifestVersion: 3,
      mode: 'full',
      state: 'ready'
    };
    storage.set('xandrio_offline_books', JSON.stringify({ [book.id]: entry }));
    const cacheStores = new Map();
    const legacyCache = makeCache();
    const legacyRequest = new Request('https://reader.test/api/audio/book-1/0');
    await legacyCache.put(legacyRequest, new Response('legacy'));
    cacheStores.set('xandrio-offline-audio', legacyCache);

    const env = installBrowser({
      book,
      chapters: [{}],
      cache: makeCache(),
      scope: 'account_a',
      storage,
      cacheStores
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 0), true);
    assert.strictEqual(await legacyCache.match(legacyRequest), undefined);
    assert(
      await cacheStores.get('xandrio-offline-audio:account_a')
        .match(offlineAudioKey(book.id, 0, 'account_a'))
    );
    assert(storage.has('xandrio_offline_books:account_a'));
    assert.strictEqual(storage.has('xandrio_offline_books'), false);
  });

  await test('defers legacy ownership when account identity is unavailable offline', async () => {
    const storage = new Map([[
      'xandrio_offline_books',
      JSON.stringify({ [book.id]: { bookId: book.id, title: book.title } })
    ]]);
    const env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      storage,
      canClaimLegacy: false
    });
    offline.initOffline(env.init);

    assert.strictEqual(offline.offlineEntryForBook(book.id), null);
    assert(storage.has('xandrio_offline_books'));
    assert.strictEqual(storage.has('xandrio_offline_books:default'), false);
  });

  await test('reconciles server title deletion into the active device account only', async () => {
    const storage = new Map();
    const cacheStores = new Map();
    let env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_a',
      storage,
      cacheStores
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_b',
      storage,
      cacheStores
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    env = installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_a',
      storage,
      cacheStores,
      deletionResponse: {
        revision: 7,
        deletions: [{
          bookId: book.id,
          revision: 7,
          deletedAt: '2999-01-01T00:00:00.000Z'
        }]
      }
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.reconcileDeletedOfflineBooks(), true);
    assert.strictEqual(offline.offlineEntryForBook(book.id), null);
    assert.strictEqual(
      storage.get('xandrio_offline_deletion_cursor:account_a'),
      '7'
    );

    installBrowser({
      book,
      chapters,
      cache: makeCache(),
      scope: 'account_b',
      storage,
      cacheStores
    });
    assert(offline.offlineEntryForBook(book.id));
    assert.notStrictEqual(
      storage.get('xandrio_offline_deletion_cursor:account_b'),
      '7'
    );
  });

  await test('preserves a full-book re-download started after the deletion', async () => {
    const entry = {
      bookId: book.id,
      title: book.title,
      chapters: 1,
      chapterEntries: [null],
      titleData: { book, chapters: [{}] },
      downloadedAt: null,
      downloadStartedAt: '2026-07-25T13:00:00.000Z',
      manifestVersion: 3,
      mode: 'full',
      state: 'repairing'
    };
    installBrowser({
      book,
      chapters: [{}],
      cache: makeCache(),
      manifest: { [book.id]: entry },
      deletionResponse: {
        revision: 8,
        deletions: [{
          bookId: book.id,
          revision: 8,
          deletedAt: '2026-07-25T12:00:00.000Z'
        }]
      }
    });

    assert.strictEqual(await offline.reconcileDeletedOfflineBooks(), false);
    assert(offline.offlineEntryForBook(book.id));
  });

  await test('writes verified per-chapter identities before marking a book ready', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'ready');
    assert.strictEqual(entry.manifestVersion, 3);
    assert(Number.isFinite(Date.parse(entry.downloadStartedAt)));
    assert.deepStrictEqual(entry.titleData.book, book);
    assert.deepStrictEqual(entry.titleData.chapters.map(chapter => chapter.index), [0, 1]);
    assert.deepStrictEqual(entry.titleData.chapters.map(chapter => chapter.title), ['Chapter 1', 'Chapter 2']);
    assert.strictEqual(entry.chapterEntries.length, 2);
    assert.deepStrictEqual(entry.chapterEntries.map(chapter => chapter.variantKey), ['voice-a', 'voice-a']);
    assert(entry.chapterEntries.every(chapter => chapter.size > 0 && /^sha256-[a-f0-9]{64}$/.test(chapter.contentHash)));
    assert.strictEqual(await offline.verifyOfflineEntry(cache, entry), true);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 1), true);
    assert.deepStrictEqual(offline.getOfflineBookData(book.id), entry.titleData);
    assert.deepStrictEqual(offline.getOfflineLibraryBooks(), [book]);
    assert.deepStrictEqual(offline.offlineStatusForBook(book.id), {
      kind: 'downloaded',
      label: 'Downloaded',
      downloaded: true,
      cachedChapters: 2,
      totalChapters: 2
    });
  });

  await test('verifies downloaded chapters from cache metadata without rereading audio bytes', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    const entry = offline.getOfflineManifest()[book.id];

    for (let index = 0; index < chapters.length; index++) {
      const response = await cache.match(offlineAudioKey(book.id, index));
      assert.strictEqual(
        response.headers.get('X-Xandrio-Content-SHA256'),
        entry.chapterEntries[index].contentHash
      );
    }

    const metadataOnlyCache = {
      async match(input) {
        const chapterIndex = Number(new URL(input.url || input).pathname.split('/').at(-1));
        const expected = entry.chapterEntries[chapterIndex];
        return {
          headers: new Headers({
            'Content-Length': String(expected.size),
            'X-Xandrio-Content-SHA256': expected.contentHash,
            'ETag': expected.etag
          }),
          clone() {
            throw new Error('verified cache entries must not reread chapter bytes');
          }
        };
      }
    };
    assert.strictEqual(await offline.verifyOfflineEntry(metadataOnlyCache, entry), true);
  });

  await test('hashes the stored body before accepting server-verified audio', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      serverContentHash: true
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual(env.hashCalls, 1);
    assert.strictEqual(
      await offline.verifyOfflineEntry(cache, offline.getOfflineManifest()[book.id]),
      true
    );
  });

  await test('rejects cached audio whose body does not match its server integrity header', async () => {
    const cache = makeCache({
      transformBytes(bytes) {
        if (bytes.byteLength > 0) bytes[Math.floor(bytes.byteLength / 2)] ^= 0xff;
        return bytes;
      }
    });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      serverContentHash: true
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), false);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
  });

  await test('one-time integrity audit rejects an existing damaged download', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      serverContentHash: true
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const legacyManifest = structuredClone(offline.getOfflineManifest());
    delete legacyManifest[book.id].chapterEntries[0].bodyVerificationVersion;
    const key = offlineAudioKey(book.id, 0);
    const cached = await cache.match(key);
    const bytes = new Uint8Array(await cached.arrayBuffer());
    bytes[Math.floor(bytes.byteLength / 2)] ^= 0xff;
    await cache.put(key, new Response(bytes, { headers: cached.headers }));

    installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      manifest: legacyManifest
    });

    assert.strictEqual(await offline.auditOfflineManifest(), true);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
  });

  await test('playback rejects a damaged legacy download before serving it', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      serverContentHash: true
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const legacyManifest = structuredClone(offline.getOfflineManifest());
    delete legacyManifest[book.id].chapterEntries[0].bodyVerificationVersion;
    const key = offlineAudioKey(book.id, 0);
    const cached = await cache.match(key);
    const bytes = new Uint8Array(await cached.arrayBuffer());
    bytes[Math.floor(bytes.byteLength / 2)] ^= 0xff;
    await cache.put(key, new Response(bytes, { headers: cached.headers }));

    installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      manifest: legacyManifest
    });

    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 0), false);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
    assert.strictEqual(await cache.match(key), undefined);
  });

  await test('a successful audit backfills legacy cache identity metadata', async () => {
    const cache = makeCache();
    const bytes = new TextEncoder().encode('legacy');
    const entry = {
      bookId: book.id,
      title: book.title,
      chapters: 1,
      chapterEntries: [{
        size: bytes.byteLength,
        contentHash: 'sha256-c49fea7425fa7f8699897a97c159c6690267d9003bb78c53fafa8fc15c325d84',
        variantKey: 'voice-a'
      }],
      titleData: { book, chapters: [{}] },
      downloadedAt: '2026-07-24T12:00:00.000Z',
      manifestVersion: 3,
      mode: 'full',
      state: 'ready'
    };
    await cache.put(offlineAudioKey(book.id, 0), new Response(bytes));
    installBrowser({
      book,
      chapters: [{}],
      cache,
      manifest: { [book.id]: entry }
    });

    assert.strictEqual(await offline.auditOfflineManifest(), true);
    const migrated = await cache.match(offlineAudioKey(book.id, 0));
    assert.strictEqual(migrated.headers.get('Content-Length'), String(bytes.byteLength));
    assert.strictEqual(
      migrated.headers.get('X-Xandrio-Content-SHA256'),
      entry.chapterEntries[0].contentHash
    );
    assert.strictEqual(
      offline.getOfflineManifest()[book.id].chapterEntries[0].bodyVerificationVersion,
      1
    );
  });

  await test('one-time integrity audit upgrades playable incomplete downloads', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      serverContentHash: true
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const legacyManifest = structuredClone(offline.getOfflineManifest());
    legacyManifest[book.id].state = 'incomplete';
    delete legacyManifest[book.id].chapterEntries[0].bodyVerificationVersion;
    installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      manifest: legacyManifest
    });

    assert.strictEqual(await offline.auditOfflineManifest(), true);
    const upgraded = offline.getOfflineManifest()[book.id];
    assert.strictEqual(upgraded.state, 'incomplete');
    assert.strictEqual(upgraded.chapterEntries[0].bodyVerificationVersion, 1);
  });

  await test('downloads an explicit library title without depending on player state or its overlay', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    let overlayCalls = 0;
    offline.initOffline({
      getCurrentBook: () => ({ id: 'different-player-book', title: 'Currently Playing' }),
      getChapters: () => [{ title: 'Player Chapter' }],
      showAudioLoading: () => { overlayCalls += 1; },
      hideAudioLoading: () => { overlayCalls += 1; }
    });

    const completed = await offline.downloadBookForOffline(book, chapters, {
      showOverlay: false,
      voiceLabel: 'Library narrator'
    });

    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(completed, true);
    assert.strictEqual(entry.bookId, book.id);
    assert.strictEqual(entry.voiceLabel, 'Library narrator');
    assert.deepStrictEqual(entry.titleData.book, book);
    assert.strictEqual(entry.titleData.chapters.length, chapters.length);
    assert.strictEqual(overlayCalls, 0);
    assert.deepStrictEqual(env.audioRequests, [0, 1]);
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.deepStrictEqual(env.preparationCalls.map(call => call.method), ['GET']);
    const activityEvents = env.documentEvents.filter(event => event.type === 'xandrio:downloadactivity');
    assert(activityEvents.some(event => event.detail?.downloads?.[0]?.percent >= 0));
    assert(activityEvents.some(event => {
      const activity = event.detail?.downloads?.[0];
      return activity?.bytesReceived > 0 &&
        activity?.bytesTotal > 0 &&
        activity?.bytesPerSecond > 0 &&
        Number.isFinite(activity?.etaSeconds);
    }), 'device transfer reports bytes, measured throughput, and ETA');
    assert.deepStrictEqual(activityEvents.at(-1).detail.downloads, []);
  });

  await test('full-title downloads skip empty structural chapters without requesting audio', async () => {
    const cache = makeCache();
    const structuralChapters = [
      { title: 'Introduction', estimatedDuration: 60 },
      { title: 'Part One', type: 'divider', empty: true, estimatedDuration: 0 },
      { title: 'Chapter One', estimatedDuration: 600 }
    ];
    const env = installBrowser({
      book,
      chapters: structuralChapters,
      cache,
      variants: ['voice-a', null, 'voice-a'],
      statusForChapter(chapterIndex) {
        if (chapterIndex === 1) {
          throw new Error('empty chapters must not reach audio status');
        }
        return {
          ready: true,
          readyChunks: 1,
          totalChunks: 1,
          variantKey: 'voice-a',
          url: `/api/audio/${book.id}/${chapterIndex}`
        };
      }
    });
    offline.initOffline(env.init);

    const completed = await offline.downloadBookForOffline(book, structuralChapters, {
      confirmForeground: false
    });
    const entry = offline.getOfflineManifest()[book.id];

    assert.strictEqual(completed, true);
    assert.deepStrictEqual(env.audioRequests, [0, 2]);
    assert.strictEqual(entry.chapterEntries[1], null);
    assert.strictEqual(await offline.verifyOfflineEntry(cache, entry), true);
  });

  await test('a prepared title transfers without browser-side chapter generation polling', async () => {
    const cache = makeCache();
    const longChapters = Array.from({ length: 46 }, (_, index) => ({
      estimatedDuration: index < 3 ? 1 : 3600
    }));
    const env = installBrowser({
      book,
      chapters: longChapters,
      cache,
      variants: longChapters.map(() => 'voice-a'),
    });
    offline.initOffline(env.init);
    const completed = await offline.downloadBookForOffline(book, longChapters, {
      confirmForeground: false
    });

    assert.strictEqual(completed, true);
    assert(
      env.statusRequests.length <= 1,
      'device transfer must not poll generation status chapter by chapter'
    );
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.strictEqual(env.audioRequests.length, 46);
  });

  await test('device transfer remains unavailable until server preparation is complete', async () => {
    const cache = makeCache();
    let env = installBrowser({
      book,
      chapters,
      cache,
      preparationResponse: {
        bookId: book.id,
        state: 'preparing',
        readyChapters: 1,
        totalChapters: 2,
        percent: 50
      }
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.prepareBookForOffline(book, chapters), false);
    assert.deepStrictEqual(env.audioRequests, []);
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'preparing');
    assert.match(offline.offlineStatusForBook(book.id).label, /Safe to close/);
    assert.strictEqual(await offline.downloadBookForOffline(book, chapters), false);
    assert.deepStrictEqual(env.audioRequests, []);

    env = installBrowser({
      book,
      chapters,
      cache,
      manifest: offline.getOfflineManifest(),
      preparationResponse: {
        bookId: book.id,
        state: 'ready',
        readyChapters: 2,
        totalChapters: 2,
        percent: 100
      }
    });
    assert.strictEqual(await offline.refreshOfflinePreparation(book.id), true);
    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'prepared');
    assert.strictEqual(offline.offlineStatusForBook(book.id).label, 'Audio prepared · Download to this device');

    assert.strictEqual(await offline.downloadBookForOffline(book, chapters), true);
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.deepStrictEqual(env.audioRequests, [0, 1]);
    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'downloaded');
  });

  await test('downloads a prepared title while another title is still queueing generation', async () => {
    const cache = makeCache();
    let releasePreparation;
    const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
    const env = installBrowser({
      book,
      chapters,
      cache,
      preparationGate,
      preparationGateBookId: 'book-2'
    });
    offline.initOffline(env.init);

    const otherBook = { id: 'book-2', title: 'Still Generating' };
    const preparation = offline.prepareBookForOffline(otherBook, [{}]);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(env.preparationCalls.length, 1);

    const download = offline.downloadBookForOffline(book, chapters);
    assert.strictEqual(await download, true);
    assert.deepStrictEqual(env.audioRequests, [0, 1]);

    releasePreparation();
    await preparation;
  });

  await test('reports available, partial, active, and repair states without cache scans', async () => {
    const cache = makeCache();
    let env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'ready-to-prepare');

    const base = {
      bookId: book.id,
      title: book.title,
      chapters: 2,
      chapterEntries: [{ size: 1 }, null],
      titleData: { book, chapters },
      manifestVersion: 3
    };
    for (const [entry, kind, label] of [
      [{ ...base, mode: 'rolling', state: 'partial' }, 'partial', '1 chapter cached'],
      [{ ...base, mode: 'full', state: 'repairing', progressPercent: 42 }, 'downloading', 'Downloading · 1 of 2 chapters'],
      [{ ...base, mode: 'full', state: 'repairing', chapterEntries: [null, null], progressPercent: 0 }, 'downloading', 'Downloading · 0 of 2 chapters'],
      [{ ...base, mode: 'full', state: 'incomplete' }, 'partial-download', '1 of 2 chapters downloaded'],
      [{ ...base, mode: 'full', state: 'stale' }, 'repair-needed', 'Update download']
    ]) {
      env = installBrowser({ book, chapters, cache, manifest: { [book.id]: entry } });
      offline.initOffline(env.init);
      const status = offline.offlineStatusForBook(book.id);
      assert.strictEqual(status.kind, kind);
      assert.strictEqual(status.label, label);
      assert.strictEqual(status.downloaded, false);
    }
  });

  await test('does not download audio when durable title state cannot be saved', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache, failStorageWrites: true });
    offline.initOffline(env.init);

    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, []);
    assert.strictEqual(cache.entries.size, 0);
    assert.strictEqual(offline.offlineEntryForBook(book.id), null);
  });

  await test('keeps offline title snapshots compact while preserving chapter-start heuristics', async () => {
    const cache = makeCache();
    const longChapters = [{
      index: 7,
      title: 'Opening',
      rawTitle: 'OPENING',
      type: 'chapter',
      estimatedDuration: 90,
      text: 'x'.repeat(5000),
      serverOnlyField: 'discard me'
    }];
    const env = installBrowser({
      book,
      chapters: longChapters,
      cache,
      variants: ['voice-a']
    });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    const snapshot = offline.getOfflineBookData(book.id).chapters[0];
    assert.strictEqual(snapshot.text.length, 256);
    assert.strictEqual(snapshot.index, 7);
    assert.strictEqual(snapshot.serverOnlyField, undefined);
  });

  await test('migrates a complete v2 title in place without downloading its audio again', async () => {
    const cache = makeCache();
    let env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    const v2Entry = offline.getOfflineManifest()[book.id];
    v2Entry.manifestVersion = 2;
    delete v2Entry.titleData;

    env = installBrowser({ book, chapters, cache, manifest: { [book.id]: v2Entry } });
    offline.initOffline(env.init);

    const migrated = offline.getOfflineManifest()[book.id];
    assert.strictEqual(migrated.manifestVersion, 3);
    assert.strictEqual(migrated.state, 'ready');
    assert.deepStrictEqual(env.audioRequests, []);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 1), true);
  });

  await test('keeps verified v2 audio playable before title metadata can migrate', async () => {
    const entry = {
      bookId: book.id,
      title: book.title,
      chapters: 1,
      chapterEntries: [{ size: 1, contentHash: 'legacy', variantKey: 'voice-a' }],
      manifestVersion: 2,
      mode: 'full',
      state: 'ready'
    };
    const env = installBrowser({ book: null, chapters: [], cache: makeCache(), manifest: { [book.id]: entry } });
    offline.initOffline(env.init);

    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 0), true);
    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'repair-needed');
  });

  await test('does not claim readiness when a title cover cannot be cached', async () => {
    const cache = makeCache();
    const coveredBook = { ...book, hasCover: true };
    const env = installBrowser({
      book: coveredBook,
      chapters: [{}],
      cache,
      variants: ['voice-a']
    });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, [0]);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, false);
  });

  await test('repairs only a missing chapter and retains verified audio', async () => {
    const cache = makeCache();
    let env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    const initialManifest = offline.getOfflineManifest();
    await cache.delete(offlineAudioKey('book-1', 1));

    env = installBrowser({ book, chapters, cache, manifest: initialManifest });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, [1], 'only the missing chapter should be fetched again');
    assert.deepStrictEqual(env.prepareCalls, [], 'chapter generation stays behind the title coordinator');
    assert.deepStrictEqual(env.preparationCalls.map(call => call.method), ['GET']);
    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'ready');
    assert.strictEqual(await offline.verifyOfflineEntry(cache, entry), true);
  });

  await test('replaces only an invalid cached chapter during repair', async () => {
    const cache = makeCache();
    let env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    const initialManifest = offline.getOfflineManifest();
    await cache.put(offlineAudioKey('book-1', 0), new Response('corrupt-audio'));

    env = installBrowser({ book, chapters, cache, manifest: initialManifest });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, [0], 'only the invalid chapter should be fetched again');
    assert.deepStrictEqual(env.prepareCalls, [], 'chapter generation stays behind the title coordinator');
    assert.deepStrictEqual(env.preparationCalls.map(call => call.method), ['GET']);
    assert.strictEqual(await offline.verifyOfflineEntry(cache, offline.getOfflineManifest()[book.id]), true);
  });

  await test('a fully valid repair performs no preparation or audio download', async () => {
    const cache = makeCache();
    let env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    const initialManifest = offline.getOfflineManifest();

    env = installBrowser({ book, chapters, cache, manifest: initialManifest });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.prepareCalls, []);
    assert.deepStrictEqual(env.audioRequests, []);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('replaces legacy playback audio with the compact offline package', async () => {
    const cache = makeCache();
    const key = offlineAudioKey('book-1', 0);
    const bytes = new TextEncoder().encode('legacy-audio');
    await cache.put(key, new Response(bytes, { headers: { ETag: '"legacy"' } }));
    const legacy = {
      [book.id]: { bookId: book.id, title: book.title, variantKey: 'voice-a', chapters: 1, bytes: bytes.byteLength }
    };
    const oneChapter = [{}];
    const env = installBrowser({ book, chapters: oneChapter, cache, manifest: legacy, variants: ['voice-a'] });
    offline.initOffline(env.init);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id), false, 'legacy entries must request repair first');
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, [0], 'legacy playback audio must not masquerade as 48 kbps package audio');
    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'ready');
    assert.notStrictEqual(entry.chapterEntries[0].size, bytes.byteLength);
    assert.strictEqual(await offline.verifyOfflineEntry(cache, entry), true);
  });

  await test('keeps completed chapters playable while a full download is incomplete', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    const normalFetch = global.fetch;
    let secondChapterUnavailable = true;
    global.fetch = async (input, options) => {
      const url = typeof input === 'string' ? input : (input.url || String(input));
      if (secondChapterUnavailable && url.includes('/api/offline/audio/book-1/1')) {
        return new Response('nope', { status: 503 });
      }
      return normalFetch(input, options);
    };
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'incomplete');
    assert.strictEqual(entry.autoResume, true);
    assert.strictEqual(entry.chapterEntries[0].size > 0, true, 'completed audio remains available for resume');
    assert.strictEqual(entry.chapterEntries[1], null);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 0), true);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 1), false);
    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 0), true);
    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 1), false);
    assert.deepStrictEqual(offline.getOfflineBookData(book.id), entry.titleData);
    assert.deepStrictEqual(offline.getOfflineLibraryBooks(), [book]);
    assert.deepStrictEqual(offline.offlineStatusForBook(book.id), {
      kind: 'partial-download',
      label: '1 of 2 chapters downloaded',
      downloaded: false,
      cachedChapters: 1,
      totalChapters: 2
    });

    secondChapterUnavailable = false;
    assert.strictEqual(await offline.resumeInterruptedOfflineDownloads(), true);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('stops exposing an incomplete download after the active voice changes', async () => {
    const cache = makeCache();
    let env = installBrowser({
      book,
      chapters,
      cache,
      variants: ['voice-a', 'voice-a']
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    const incomplete = structuredClone(offline.getOfflineManifest());
    incomplete[book.id].state = 'incomplete';

    env = installBrowser({
      book,
      chapters,
      cache,
      manifest: incomplete,
      variants: ['voice-b', 'voice-b']
    });
    offline.initOffline(env.init);
    for (
      let attempt = 0;
      attempt < 20 && offline.getOfflineManifest()[book.id].state !== 'stale';
      attempt++
    ) {
      await new Promise(resolve => setImmediate(resolve));
    }

    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'stale');
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 0), false);
  });

  await test('does not re-expose stale voice audio while its replacement downloads', async () => {
    const cache = makeCache();
    let env = installBrowser({
      book,
      chapters,
      cache,
      variants: ['voice-a', 'voice-a']
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    const stale = structuredClone(offline.getOfflineManifest());
    stale[book.id].state = 'stale';

    let releaseReplacement;
    const replacementGate = new Promise(resolve => { releaseReplacement = resolve; });
    env = installBrowser({
      book,
      chapters,
      cache,
      manifest: stale,
      variants: ['voice-b', 'voice-b'],
      audioGate: replacementGate
    });
    offline.initOffline(env.init);
    const replacement = offline.downloadCurrentBook();
    let replacementCompleted;
    try {
      while (env.audioRequests.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert(
        offline.getOfflineManifest()[book.id].chapterEntries.every(entry => entry === null),
        'stale chapter pointers must be hidden before replacement audio is cached'
      );
      assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 0), false);
    } finally {
      releaseReplacement();
      replacementCompleted = await replacement;
    }

    assert.strictEqual(replacementCompleted, true);
    assert.deepStrictEqual(env.audioRequests.sort(), [0, 1]);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('validates an incomplete download voice before reusing cached chapters', async () => {
    const cache = makeCache();
    let env = installBrowser({
      book,
      chapters,
      cache,
      variants: ['voice-a', 'voice-a']
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    const incomplete = structuredClone(offline.getOfflineManifest());
    incomplete[book.id].state = 'incomplete';
    incomplete[book.id].autoResume = false;

    let releaseReplacement;
    const replacementGate = new Promise(resolve => { releaseReplacement = resolve; });
    env = installBrowser({
      book,
      chapters,
      cache,
      manifest: incomplete,
      variants: ['voice-b', 'voice-b'],
      audioGate: replacementGate
    });
    offline.initOffline({ getCurrentBook: () => null, getChapters: () => [] });
    const replacement = offline.downloadBookForOffline(book, chapters);
    let replacementCompleted;
    try {
      while (env.audioRequests.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert(
        offline.getOfflineManifest()[book.id].chapterEntries.every(entry => entry === null),
        'cached chapters from a different voice must be hidden before replacement'
      );
    } finally {
      releaseReplacement();
      replacementCompleted = await replacement;
    }

    assert.strictEqual(replacementCompleted, true);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('exposes each completed chapter before the active full download finishes', async () => {
    const cache = makeCache();
    const activeChapters = [{}, {}, {}];
    const env = installBrowser({
      book,
      chapters: activeChapters,
      cache,
      variants: ['voice-a', 'voice-a', 'voice-a']
    });
    const fetchAudio = global.fetch;
    let releaseSecondChapter;
    const secondChapterGate = new Promise(resolve => { releaseSecondChapter = resolve; });
    global.fetch = async (input, options) => {
      const url = typeof input === 'string' ? input : (input.url || String(input));
      if (url.includes('/api/offline/audio/book-1/1')) await secondChapterGate;
      return fetchAudio(input, options);
    };
    offline.initOffline(env.init);

    const download = offline.downloadCurrentBook();
    let completed;
    try {
      const readinessDeadline = Date.now() + 2000;
      while (
        Date.now() < readinessDeadline &&
        (
          !offline.getOfflineManifest()[book.id]?.chapterEntries?.[0] ||
          (offline.getOfflineManifest()[book.id]?.chapterEntries?.filter(Boolean).length || 0) < 2
        )
      ) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'repairing');
      assert.strictEqual(
        offline.getOfflineManifest()[book.id].chapterEntries.filter(Boolean).length,
        2
      );
      assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 0), true);
      assert.deepStrictEqual(offline.offlineStatusForBook(book.id), {
        kind: 'downloading',
        label: 'Downloading · 2 of 3 chapters',
        downloaded: false,
        cachedChapters: 2,
        totalChapters: 3
      });
    } finally {
      releaseSecondChapter();
      completed = await download;
    }
    assert.strictEqual(completed, true);
  });

  await test('recovers from a transient chapter transfer failure without user intervention', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      transientAudioFailures: 1
    });
    offline.initOffline(env.init);
    const completed = await offline.downloadCurrentBook();
    assert.strictEqual(completed, true);
    assert.deepStrictEqual(env.audioRequests, [0, 0]);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('restarts a chapter transfer when the response stream drops', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      transientStreamFailures: 1
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.deepStrictEqual(env.audioRequests, [0, 0]);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('restarts a server-verified streaming cache write when the connection drops', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      transientStreamFailures: 1,
      serverContentHash: true
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.deepStrictEqual(env.audioRequests, [0, 0]);
    assert.strictEqual(env.hashCalls, 1);
  });

  await test('pipelines two chapters so transfer and generation can overlap', async () => {
    const cache = makeCache();
    let releaseAudio;
    const audioGate = new Promise(resolve => { releaseAudio = resolve; });
    const pipelinedChapters = [{}, {}, {}];
    const env = installBrowser({
      book,
      chapters: pipelinedChapters,
      cache,
      variants: ['voice-a', 'voice-a', 'voice-a'],
      audioGate
    });
    offline.initOffline(env.init);
    const download = offline.downloadCurrentBook();
    for (let attempt = 0; attempt < 20 && env.audioRequests.length < 2; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepStrictEqual([...env.audioRequests].sort(), [0, 1]);
    const activeDownload = env.documentEvents
      .filter(event => event.type === 'xandrio:downloadactivity')
      .at(-1)?.detail?.downloads?.[0];
    assert(activeDownload && activeDownload.percent < 100);
    releaseAudio();
    assert.strictEqual(await download, true);
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'ready');
  });

  await test('render audit marks an evicted ready entry incomplete without downloading', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    await cache.delete(offlineAudioKey('book-1', 1));
    env.audioRequests.length = 0;
    env.prepareCalls.length = 0;

    offline.renderOfflineState();
    await offline.auditOfflineManifest();

    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.deepStrictEqual(env.audioRequests, []);
  });

  await test('verified offline-library reads retain playable chapters from an evicted title', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    await cache.delete(offlineAudioKey('book-1', 1));

    assert.deepStrictEqual(
      await offline.getVerifiedOfflineLibraryBooks(),
      [book],
      'the Downloaded view should retain a title while at least one verified chapter remains'
    );
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
    assert.strictEqual(offline.getOfflineManifest()[book.id].chapterEntries[1], null);
  });

  await test('rolling cache does not write on an unverified deployment origin', async () => {
    const cache = makeCache();
    const rollingChapters = [{}, {}, {}];
    const env = installBrowser({
      book,
      chapters: rollingChapters,
      cache,
      variants: ['voice-a', 'voice-a', 'voice-a']
    });
    document.documentElement.dataset.pwaStorageAllowed = 'false';

    await offline.ensureRollingOfflineWindow(book, rollingChapters, 1, { enabled: true });

    assert.deepStrictEqual(env.audioRequests, []);
    assert.strictEqual(cache.entries.size, 0);
    assert.strictEqual(offline.offlineEntryForBook(book.id), null);
  });

  await test('rolling cache keeps one chapter behind and two ahead', async () => {
    const cache = makeCache();
    const rollingChapters = [{}, {}, {}, {}, {}];
    const env = installBrowser({
      book,
      chapters: rollingChapters,
      cache,
      variants: ['voice-a', 'voice-a', 'voice-a', 'voice-a', 'voice-a']
    });
    offline.initOffline(env.init);
    await offline.ensureRollingOfflineWindow(book, rollingChapters, 2, { enabled: true });

    let entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.mode, 'rolling');
    assert.deepStrictEqual(entry.chapterEntries.map((chapter, index) => chapter ? index : null).filter(index => index !== null), [1, 2, 3, 4]);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 2), true);

    await offline.ensureRollingOfflineWindow(book, rollingChapters, 3, { enabled: true });
    entry = offline.getOfflineManifest()[book.id];
    assert.deepStrictEqual(entry.chapterEntries.map((chapter, index) => chapter ? index : null).filter(index => index !== null), [2, 3, 4]);
    assert.strictEqual(await cache.match(offlineAudioKey('book-1', 1)), undefined);
  });

  await test('rolling cache repairs a voice change without deleting the replacement window', async () => {
    const cache = makeCache();
    const rollingChapters = [{}, {}, {}, {}, {}];
    let env = installBrowser({
      book,
      chapters: rollingChapters,
      cache,
      variants: ['voice-a', 'voice-a', 'voice-a', 'voice-a', 'voice-a']
    });
    offline.initOffline(env.init);
    await offline.ensureRollingOfflineWindow(book, rollingChapters, 2, { enabled: true });
    const initialManifest = offline.getOfflineManifest();

    env = installBrowser({
      book,
      chapters: rollingChapters,
      cache,
      manifest: initialManifest,
      variants: ['voice-b', 'voice-b', 'voice-b', 'voice-b', 'voice-b']
    });
    offline.initOffline(env.init);
    await offline.ensureRollingOfflineWindow(book, rollingChapters, 2, { enabled: true });

    const entry = offline.getOfflineManifest()[book.id];
    assert.deepStrictEqual(
      entry.chapterEntries.map((chapter, index) => chapter ? index : null).filter(index => index !== null),
      [1, 2, 3, 4]
    );
    assert(entry.chapterEntries.filter(Boolean).every(chapter => chapter.variantKey === 'voice-b'));
    for (const index of [1, 2, 3, 4]) {
      assert(await cache.match(offlineAudioKey('book-1', index)));
    }
  });

  await test('rolling cache never overwrites an incomplete full-book download', async () => {
    const cache = makeCache();
    const fullEntry = {
      bookId: book.id,
      title: book.title,
      chapters: 2,
      chapterEntries: [null, null],
      mode: 'full',
      state: 'incomplete',
      manifestVersion: 2
    };
    const env = installBrowser({ book, chapters, cache, manifest: { [book.id]: fullEntry } });
    offline.initOffline(env.init);
    await offline.ensureRollingOfflineWindow(book, chapters, 0, { enabled: true });

    assert.deepStrictEqual(env.prepareCalls, []);
    assert.strictEqual(offline.getOfflineManifest()[book.id].mode, 'full');
  });

  await test('offline availability repairs an evicted rolling manifest pointer', async () => {
    const cache = makeCache();
    const rollingChapters = [{}, {}, {}];
    const env = installBrowser({
      book,
      chapters: rollingChapters,
      cache,
      variants: ['voice-a', 'voice-a', 'voice-a']
    });
    offline.initOffline(env.init);
    await offline.ensureRollingOfflineWindow(book, rollingChapters, 1, { enabled: true });
    await cache.delete(offlineAudioKey('book-1', 1));

    assert.strictEqual(await offline.isChapterAvailableOffline(book.id, 1), false);
    assert.strictEqual(offline.getOfflineManifest()[book.id].chapterEntries[1], null);
  });

  await test('removing only an offline copy preserves playback and pending sync state', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    env.storage.set('xandrio_playback_checkpoint:book-1', JSON.stringify({ chapterIndex: 1 }));
    env.storage.set('xandrio_pending_positions', JSON.stringify([
      { bookId: 'book-1', chapterIndex: 1 }
    ]));

    await offline.removeOfflineBook('book-1');

    assert.strictEqual(env.storage.has('xandrio_playback_checkpoint:book-1'), true);
    assert.strictEqual(env.storage.has('xandrio_pending_positions'), true);
  });

  await test('title cleanup removes local audio, cover, manifest, and playback state', async () => {
    const cache = makeCache();
    const titleCache = makeCache();
    const env = installBrowser({ book, chapters, cache, titleCache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();
    await titleCache.put(
      'https://reader.test/api/cover/book-1',
      new Response('cover', { headers: { 'Content-Type': 'image/jpeg' } })
    );
    env.storage.set('xandrio_book_meta:book-1', JSON.stringify({ chapterCount: 2 }));
    env.storage.set('xandrio_playback_checkpoint:book-1', JSON.stringify({ chapterIndex: 1 }));
    env.storage.set('xandrio_pending_positions', JSON.stringify([
      { bookId: 'book-1', chapterIndex: 1 },
      { bookId: 'other', chapterIndex: 0 }
    ]));

    const result = await offline.removeOfflineBook('book-1', { removePlaybackState: true });

    assert.deepStrictEqual(result, { removed: true, audioEntries: 2, titleEntries: 1 });
    assert.strictEqual(offline.offlineEntryForBook('book-1'), null);
    assert.strictEqual(cache.entries.size, 0);
    assert.strictEqual(titleCache.entries.size, 0);
    assert.strictEqual(env.storage.has('xandrio_book_meta:book-1'), false);
    assert.strictEqual(env.storage.has('xandrio_playback_checkpoint:book-1'), false);
    assert.deepStrictEqual(JSON.parse(env.storage.get('xandrio_pending_positions')), [
      { bookId: 'other', chapterIndex: 0 }
    ]);
  });

  await test('title cleanup waits for an aborted download before deleting its late writes', async () => {
    const cache = makeCache();
    let releaseAudio;
    const audioGate = new Promise(resolve => { releaseAudio = resolve; });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      audioGate
    });
    offline.initOffline(env.init);
    const download = offline.downloadCurrentBook();
    while (env.audioRequests.length === 0) await new Promise(resolve => setImmediate(resolve));

    const removal = offline.removeOfflineBook(book.id, { removePlaybackState: true });
    releaseAudio();
    await Promise.all([download, removal]);

    assert.strictEqual(offline.offlineEntryForBook(book.id), null);
    assert.strictEqual(cache.entries.size, 0);
  });

  await test('a cancelled download stays registered until its work settles', async () => {
    const cache = makeCache();
    let releaseAudio;
    const audioGate = new Promise(resolve => { releaseAudio = resolve; });
    const env = installBrowser({
      book,
      chapters: [{}],
      cache,
      variants: ['voice-a'],
      audioGate
    });
    offline.initOffline(env.init);
    const download = offline.downloadCurrentBook();
    while (env.audioRequests.length === 0) await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(offline.cancelOfflineDownload('other-book'), false);
    assert.strictEqual(offline.cancelOfflineDownload(book.id), true);
    assert.strictEqual(offline.cancelOfflineDownload(book.id), true);
    assert.deepStrictEqual(env.audioRequests, [0]);
    assert.strictEqual(
      env.preparationCalls.some(call => call.method === 'DELETE'),
      false,
      'cancelling device transfer must not pause the completed server package'
    );

    releaseAudio();
    await download;
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
    assert.strictEqual(offline.getOfflineManifest()[book.id].autoResume, false);
  });

  await test('cold-launch library, player, cover, and deletion paths use offline title state', async () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const librarySource = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'views', 'library.js'),
      'utf8'
    );
    const workerSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

    assert(appSource.includes('getOfflineBookData(bookId)'));
    assert(appSource.includes('clearDeletedBookFromPlayer'));
    assert(appSource.includes('currentBookOfflineFallback'));
    assert(librarySource.includes('await verifiedOfflineBooks'));
    assert(librarySource.includes('getVerifiedOfflineLibraryBooks()'));
    assert(librarySource.includes("status.kind === 'partial-download'"));
    // Partial and in-progress downloads keep their own distinct labels and
    // affordances, but no longer count as available on this device: a book that
    // cannot play offline must not be filed under Downloaded. See
    // isAvailableOnDevice in library.js.
    assert(librarySource.includes("kind: 'partial-download'") === false);
    assert(/function isAvailableOnDevice\(status\) \{\s*return Boolean\(status\.downloaded\);/.test(librarySource));
    assert(librarySource.includes('${escapeHTML(status.label)} (Cancel)'));
    assert(librarySource.includes('onBookDeleted'));
    assert(librarySource.includes('await removeOfflineBook(id, { removePlaybackState: true })'));
    assert(workerSource.includes("const OFFLINE_TITLE_CACHE = 'xandrio-offline-titles';"));
    assert(workerSource.includes('isOfflineTitleRequest(request)'));
  });

  // --- Local-first routing --------------------------------------------------
  // Routing runs on the chapter-load path, so it must be cheap: presence only,
  // never a body hash. Hashing a downloaded chapter before playback would
  // reintroduce the very stall this work exists to remove.

  await test('localChapterSource reports a cached chapter without hashing its body', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const digest = crypto.webcrypto.subtle.digest;
    let digestCalls = 0;
    crypto.webcrypto.subtle.digest = function (...args) {
      digestCalls += 1;
      return digest.apply(this, args);
    };
    try {
      const source = await offline.localChapterSource(book.id, 0);
      assert.strictEqual(source.available, true);
      assert.match(source.url, /xandrio-offline-scope=/);
      assert.strictEqual(source.mode, 'full');
      assert.strictEqual(digestCalls, 0, 'routing must not hash the chapter body');
    } finally {
      crypto.webcrypto.subtle.digest = digest;
    }
  });

  await test('localChapterSource reports an uncached chapter as unavailable', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache, manifest: {} });
    offline.initOffline(env.init);

    const source = await offline.localChapterSource(book.id, 0);
    assert.strictEqual(source.available, false);
    assert.strictEqual(source.url, null);
  });

  // --- Transient vs deterministic failure -----------------------------------
  // Safari emits media errors routinely (backgrounding, buffer eviction). One
  // of those must never destroy a verified multi-hundred-megabyte download.

  await test('a suspect chapter is not durably invalidated and keeps its bytes', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const before = offline.offlineEntryForBook(book.id);
    offline.markLocalChapterSuspect(book.id, 0);

    const after = offline.offlineEntryForBook(book.id);
    assert.strictEqual(after.state, before.state, 'the manifest state is untouched');
    assert(after.chapterEntries[0], 'the chapter entry survives a transient error');
    assert(
      await cache.match(offlineAudioKey(book.id, 0)),
      'cached audio is never deleted on suspicion'
    );
    assert.strictEqual(
      (await offline.localChapterSource(book.id, 0)).available,
      false,
      'a suspect chapter is skipped for the rest of the session'
    );
  });

  await test('a suspect chapter recovers when classification finds the cache intact', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    offline.markLocalChapterSuspect(book.id, 0);

    const verdict = await offline.classifyLocalChapter(book.id, 0, {
      probe: async () => new Response(null, {
        status: 206,
        headers: {
          'Content-Range': 'bytes 0-1/6',
          'Content-Length': '2',
          'X-Xandrio-Offline-Cache': 'hit',
          'X-Xandrio-SW': SW_CACHE_VERSION
        }
      })
    });

    assert.strictEqual(verdict, 'transient');
    assert.strictEqual(
      (await offline.localChapterSource(book.id, 0)).available,
      true,
      'a proven-intact chapter is trusted again'
    );
  });

  await test('a deterministic cache miss invalidates the entry but keeps the bytes', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    offline.markLocalChapterSuspect(book.id, 0);

    const verdict = await offline.classifyLocalChapter(book.id, 0, {
      probe: async () => new Response(null, {
        status: 504,
        headers: {
          'X-Xandrio-Offline-Cache': 'miss',
          'X-Xandrio-SW': SW_CACHE_VERSION
        }
      })
    });

    assert.strictEqual(verdict, 'missing');
    const entry = offline.offlineEntryForBook(book.id);
    assert.strictEqual(entry.chapterEntries[0], null, 'the chapter entry is cleared');
    assert.strictEqual(entry.state, 'incomplete', 'the book needs repair');
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, false);
  });

  await test('repeated failures escalate to a hash check and delete only proven-corrupt bytes', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    // Corrupt the stored body behind the manifest's back.
    await cache.put(
      new Request(offlineAudioKey(book.id, 0)),
      new Response('tampered', { headers: { 'Content-Type': 'audio/mpeg' } })
    );

    const okProbe = async () => new Response(null, {
      status: 206,
      headers: {
        'Content-Range': 'bytes 0-1/8',
        'Content-Length': '2',
        'X-Xandrio-Offline-Cache': 'hit',
        'X-Xandrio-SW': SW_CACHE_VERSION
      }
    });

    offline.markLocalChapterSuspect(book.id, 0);
    assert.strictEqual(await offline.classifyLocalChapter(book.id, 0, { probe: okProbe }), 'transient');
    offline.markLocalChapterSuspect(book.id, 0);
    assert.strictEqual(await offline.classifyLocalChapter(book.id, 0, { probe: okProbe }), 'transient');
    offline.markLocalChapterSuspect(book.id, 0);
    const verdict = await offline.classifyLocalChapter(book.id, 0, { probe: okProbe });

    assert.strictEqual(verdict, 'corrupt', 'the third failure escalates past the cheap probe');
    assert.strictEqual(
      await cache.match(offlineAudioKey(book.id, 0)),
      undefined,
      'proven-corrupt bytes are the only bytes ever deleted'
    );
    assert.strictEqual(offline.offlineEntryForBook(book.id).chapterEntries[0], null);
  });

  // --- Download completion verification -------------------------------------
  // Byte-exact storage is necessary but not sufficient: the incident was a book
  // that was stored correctly and still would not play. Completion therefore
  // proves the exact scoped service-worker route serves it.

  await test('a download is only Downloaded once the scoped worker route serves it', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);

    assert(env.verificationProbes.length > 0, 'the scoped playback route is probed');
    assert(
      env.verificationProbes.every(url => url.includes('xandrio-offline-scope=')),
      'the probe uses the same URL the media element will request'
    );
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, true);
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'ready');
  });

  await test('an uncontrolled page leaves the download verifying, not ready or broken', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache, serviceWorkerController: null });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const entry = offline.offlineEntryForBook(book.id);
    assert.strictEqual(entry.state, 'verifying', 'the bytes are kept and re-checked later');
    assert(entry.chapterEntries.every(Boolean), 'no chapter is discarded');
    const status = offline.offlineStatusForBook(book.id);
    assert.strictEqual(status.downloaded, false, 'it must not claim to be Downloaded');
    assert.match(status.label, /verif/i, 'the label says what is happening');
  });

  await test('a worker that cannot serve the route fails verification instead of claiming success', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      // An older worker: no markers, and it falls through to a 200.
      verificationProbe: async () => new Response('whole file', { status: 200 })
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const entry = offline.offlineEntryForBook(book.id);
    assert.strictEqual(entry.state, 'verifying');
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, false);
  });

  await test('a mismatched Content-Range fails verification', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      verificationProbe: async () => new Response(new Uint8Array([0, 0]), {
        status: 206,
        headers: {
          // Size disagrees with the manifest entry: a different artifact.
          'Content-Range': 'bytes 0-1/999999',
          'Content-Length': '2',
          'X-Xandrio-Offline-Cache': 'hit',
          'X-Xandrio-SW': SW_CACHE_VERSION
        }
      })
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'verifying');
  });

  // --- Strict worker contract ----------------------------------------------
  // "Some version header" is not a contract. offline.js pins the exact service
  // worker version it was written against, so a worker from a different build
  // cannot satisfy verification under semantics it may not implement.

  await test('a stale service-worker version never completes verification', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      verificationProbe: async () => new Response(new Uint8Array([0, 0]), {
        status: 206,
        headers: {
          'Content-Range': 'bytes 0-1/14',
          'Content-Length': '2',
          'X-Xandrio-Offline-Cache': 'hit',
          'X-Xandrio-SW': 'xandrio-v1'
        }
      })
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'verifying');
  });

  await test('a verifying download is re-probed and promoted on the next initialization', async () => {
    const cache = makeCache();
    const failing = installBrowser({
      book,
      chapters,
      cache,
      verificationProbe: async () => new Response('', { status: 500 })
    });
    offline.initOffline(failing.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'verifying');

    // Same storage and cache, but now the page is controlled by a worker that
    // implements the contract.
    const healthy = installBrowser({
      book,
      chapters,
      cache,
      storage: failing.storage
    });
    offline.initOffline(healthy.init);
    await offline.reprobeVerifyingDownloads();

    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'ready');
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, true);
  });

  await test('a re-probe that still fails preserves the bytes and the verifying state', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      verificationProbe: async () => { throw new Error('worker unavailable'); }
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    await offline.reprobeVerifyingDownloads();

    const entry = offline.offlineEntryForBook(book.id);
    assert.strictEqual(entry.state, 'verifying');
    assert(entry.chapterEntries.every(Boolean), 'no chapter entry is dropped');
    assert(await cache.match(offlineAudioKey(book.id, 0)), 'no bytes are dropped');
  });

  // --- Strict runtime classification ---------------------------------------
  // Only an explicit, current-version cache miss is deterministic enough to
  // write to the manifest. Everything else keeps the download intact.

  for (const [name, probe] of [
    ['a fetch failure', async () => { throw new Error('offline'); }],
    ['a transient 5xx', async () => new Response('', { status: 503 })],
    ['a malformed response', async () => new Response('', {
      status: 504,
      headers: { 'X-Xandrio-Offline-Cache': 'miss' }
    })],
    ['a stale-version miss', async () => new Response('', {
      status: 504,
      headers: { 'X-Xandrio-Offline-Cache': 'miss', 'X-Xandrio-SW': 'xandrio-v1' }
    })]
  ]) {
    await test(`${name} is indeterminate: manifest, bytes and streaming all preserved`, async () => {
      const cache = makeCache();
      const env = installBrowser({ book, chapters, cache });
      offline.initOffline(env.init);
      assert.strictEqual(await offline.downloadCurrentBook(), true);
      offline.markLocalChapterSuspect(book.id, 0);

      const verdict = await offline.classifyLocalChapter(book.id, 0, { probe });

      assert.strictEqual(verdict, 'indeterminate');
      const entry = offline.offlineEntryForBook(book.id);
      assert(entry.chapterEntries[0], 'the manifest entry survives');
      assert.strictEqual(entry.state, 'ready', 'the book is not marked broken');
      assert(await cache.match(offlineAudioKey(book.id, 0)), 'the bytes survive');
      assert.strictEqual(
        (await offline.localChapterSource(book.id, 0)).available,
        false,
        'an undiagnosed chapter keeps streaming for this session'
      );
    });
  }

  await test('intact bytes that still will not play stay distrusted for the session', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const hitProbe = async () => new Response(new Uint8Array([0, 0]), {
      status: 206,
      headers: {
        'Content-Range': 'bytes 0-1/14',
        'Content-Length': '2',
        'X-Xandrio-Offline-Cache': 'hit',
        'X-Xandrio-SW': offline.EXPECTED_OFFLINE_SW_VERSION
      }
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      offline.markLocalChapterSuspect(book.id, 0);
      assert.strictEqual(await offline.classifyLocalChapter(book.id, 0, { probe: hitProbe }), 'transient');
    }
    offline.markLocalChapterSuspect(book.id, 0);
    const verdict = await offline.classifyLocalChapter(book.id, 0, { probe: hitProbe });

    // A matching hash proves the bytes are the bytes we downloaded. It does not
    // prove Safari can decode them, and three failures say it cannot.
    assert.strictEqual(verdict, 'unplayable');
    assert(await cache.match(offlineAudioKey(book.id, 0)), 'intact bytes are never deleted');
    assert(offline.offlineEntryForBook(book.id).chapterEntries[0], 'the manifest entry survives');
    assert.strictEqual(
      (await offline.localChapterSource(book.id, 0)).available,
      false,
      'the chapter keeps streaming for the rest of the session'
    );
  });

  // --- Controller requirement ----------------------------------------------

  await test('no scoped offline URL is offered when the page has no worker controller', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual((await offline.localChapterSource(book.id, 0)).available, true);

    // The scoped URL is only meaningful to the service worker. Uncontrolled, it
    // would reach the server and stream a different encode of the same chapter.
    const uncontrolled = installBrowser({
      book,
      chapters,
      cache,
      storage: env.storage,
      serviceWorkerController: null
    });
    offline.initOffline(uncontrolled.init);

    const source = await offline.localChapterSource(book.id, 0);
    assert.strictEqual(source.available, false);
    assert.strictEqual(source.url, null);
  });

  await test('partial offline playback survives while Downloaded stays strict', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    // Lose one chapter, exactly as a deterministic cache miss would.
    await offline.invalidateLocalChapter(book.id, 1, { deleteBytes: false });

    const status = offline.offlineStatusForBook(book.id);
    assert.strictEqual(status.downloaded, false, 'a partial book is not Downloaded');
    assert.strictEqual(status.kind, 'partial-download');

    // ...but the remaining chapter is still playable offline, and the player
    // can still rebuild itself from the entry after a cold launch.
    assert(offline.getOfflineBookData(book.id), 'partial entries remain hydratable');
    assert.strictEqual(
      (await offline.localChapterSource(book.id, 0)).available,
      true,
      'the chapters still present keep playing from this device'
    );
    assert.strictEqual((await offline.localChapterSource(book.id, 1)).available, false);

    const offlineSource = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'features', 'offline.js'),
      'utf8'
    );
    assert(
      /function isCompletedOfflineEntry\(entry\) \{[\s\S]*?offlineState\(entry\) === 'ready'/.test(offlineSource),
      'the Downloaded predicate is defined strictly and separately from hydration'
    );
  });

  // --- Old-worker rollout race ---------------------------------------------
  // A new app.js can run while the *previous* worker is still controlling the
  // page. That worker still has network-first semantics for the scoped URL, so
  // handing it the scoped source while online would fetch from the server and
  // report "Playing from this device" over streamed audio.

  const OLD_CONTROLLER = { scriptURL: 'https://reader.test/sw.js' };
  const MISMATCHED_CONTROLLER = { scriptURL: 'https://reader.test/sw.js?v=xandrio-v119' };

  await test('online local-first is withheld while an old worker still controls the page', async () => {
    const cache = makeCache();
    const ready = installBrowser({ book, chapters, cache });
    offline.initOffline(ready.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual((await offline.localChapterSource(book.id, 0)).available, true);

    for (const controller of [OLD_CONTROLLER, MISMATCHED_CONTROLLER]) {
      const stale = installBrowser({
        book,
        chapters,
        cache,
        storage: ready.storage,
        serviceWorkerController: controller
      });
      offline.initOffline(stale.init);
      navigator.onLine = true;

      const source = await offline.localChapterSource(book.id, 0);
      assert.strictEqual(
        source.available,
        false,
        `${controller.scriptURL} must not be handed the scoped local source while online`
      );
      assert.strictEqual(source.url, null);
    }
  });

  await test('offline playback still works through an old controller', async () => {
    const cache = makeCache();
    const ready = installBrowser({ book, chapters, cache });
    offline.initOffline(ready.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const stale = installBrowser({
      book,
      chapters,
      cache,
      storage: ready.storage,
      serviceWorkerController: OLD_CONTROLLER
    });
    offline.initOffline(stale.init);
    navigator.onLine = false;
    try {
      // The old worker is network-first, but with no network its fetch fails and
      // its existing cache fallback serves the chapter. Withholding local
      // playback here would strand an offline listener mid-activation.
      const source = await offline.localChapterSource(book.id, 0);
      assert.strictEqual(source.available, true, 'an offline listener is not stranded');
      assert.match(source.url, /xandrio-offline-scope=/);
    } finally {
      navigator.onLine = true;
    }
  });

  await test('route certification refuses to probe through an unexpected controller', async () => {
    const cache = makeCache();
    let probed = false;
    const env = installBrowser({
      book,
      chapters,
      cache,
      serviceWorkerController: MISMATCHED_CONTROLLER,
      verificationProbe: async () => {
        probed = true;
        return new Response('', { status: 200 });
      }
    });
    offline.initOffline(env.init);

    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual(probed, false, 'no probe is issued through a worker of another build');
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'verifying');
  });

  await test('runtime classification is indeterminate under an unexpected controller', async () => {
    const cache = makeCache();
    const ready = installBrowser({ book, chapters, cache });
    offline.initOffline(ready.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    const stale = installBrowser({
      book,
      chapters,
      cache,
      storage: ready.storage,
      serviceWorkerController: OLD_CONTROLLER
    });
    offline.initOffline(stale.init);
    offline.markLocalChapterSuspect(book.id, 0);

    let probed = false;
    const verdict = await offline.classifyLocalChapter(book.id, 0, {
      probe: async () => {
        probed = true;
        return new Response('', {
          status: 504,
          headers: { 'X-Xandrio-Offline-Cache': 'miss', 'X-Xandrio-SW': SW_CACHE_VERSION }
        });
      }
    });

    assert.strictEqual(probed, false, 'no probe is issued through an old worker');
    assert.strictEqual(verdict, 'indeterminate');
    assert(offline.offlineEntryForBook(book.id).chapterEntries[0], 'the manifest survives');
  });

  // --- Re-probe lifecycle for already-ready entries -------------------------
  // Downloads certified before this contract existed, or against an earlier
  // worker, carry no usable probedSwVersion. Downloaded must stay truthful for
  // them too, without ever discarding audio.

  await test('a legacy ready entry is re-certified and stamped under the expected worker', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    // Simulate a download certified before versions were recorded.
    const manifest = JSON.parse(env.storage.get('xandrio_offline_books:default'));
    delete manifest[book.id].probedSwVersion;
    env.storage.set('xandrio_offline_books:default', JSON.stringify(manifest));

    assert.strictEqual(await offline.reprobeVerifyingDownloads(), true);

    const entry = offline.offlineEntryForBook(book.id);
    assert.strictEqual(entry.state, 'ready', 'a passing legacy entry stays Downloaded');
    assert.strictEqual(
      entry.probedSwVersion,
      SW_CACHE_VERSION,
      'the certifying worker version is recorded'
    );
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, true);
  });

  await test('a stale ready entry whose route fails becomes verifying and keeps its bytes', async () => {
    const cache = makeCache();
    const env = installBrowser({
      book,
      chapters,
      cache,
      verificationProbe: async () => new Response('', { status: 500 })
    });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);

    // Force it to look like a previously certified download from an older build.
    const manifest = JSON.parse(env.storage.get('xandrio_offline_books:default'));
    manifest[book.id].state = 'ready';
    manifest[book.id].probedSwVersion = 'xandrio-v119';
    env.storage.set('xandrio_offline_books:default', JSON.stringify(manifest));
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, true);

    await offline.reprobeVerifyingDownloads();

    const entry = offline.offlineEntryForBook(book.id);
    assert.strictEqual(entry.state, 'verifying', 'Downloaded is withdrawn until re-certified');
    assert.strictEqual(offline.offlineStatusForBook(book.id).downloaded, false);
    assert(entry.chapterEntries.every(Boolean), 'no chapter entry is dropped');
    assert(await cache.match(offlineAudioKey(book.id, 0)), 'no bytes are dropped');
  });

  await test('a current-version ready entry is left alone', async () => {
    const cache = makeCache();
    let probes = 0;
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(await offline.downloadCurrentBook(), true);
    assert.strictEqual(offline.offlineEntryForBook(book.id).probedSwVersion, SW_CACHE_VERSION);

    const reprobed = await offline.reprobeVerifyingDownloads();
    assert.strictEqual(reprobed, false, 'an already-certified download is not re-probed');
    assert.strictEqual(offline.offlineEntryForBook(book.id).state, 'ready');
    assert.strictEqual(probes, 0);
  });

  await test('the re-probe also runs after audio cache migration', async () => {
    const offlineSource = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'features', 'offline.js'),
      'utf8'
    );
    const initBody = offlineSource.match(
      /export function initOffline\(options = \{\}\) \{([\s\S]*?)\n\}/
    )?.[1] || '';
    assert(initBody.length > 0, 'initOffline is present');
    assert(
      /controllerchange/.test(initBody),
      'a controller change re-checks verifying downloads'
    );
    assert(
      /migrateLegacyOfflineCaches\(\)[\s\S]*?reprobeVerifyingDownloads\(\)/.test(initBody),
      'the re-probe also runs once cache migration has completed'
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
