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
    console.error(`    ${error.stack || error.message}`);
  }
}

function makeCache() {
  const entries = new Map();
  const keyOf = input => typeof input === 'string' ? input : input.url;
  return {
    entries,
    async match(input) {
      const response = entries.get(keyOf(input));
      return response ? response.clone() : undefined;
    },
    async put(input, response) {
      entries.set(keyOf(input), response.clone());
    },
    async delete(input) {
      return entries.delete(keyOf(input));
    },
    async keys() {
      return [...entries.keys()].map(key => new Request(key));
    }
  };
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
  transientStreamFailures = 0
}) {
  const storage = new Map();
  storage.set('xandrio_offline_books', JSON.stringify(manifest));
  const elements = new Map([
    ['player-voice-name', { textContent: 'Narrator' }]
  ]);
  const documentEvents = [];
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
    getElementById: id => elements.get(id) || null,
    dispatchEvent(event) {
      documentEvents.push(event);
      return true;
    }
  };
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    writable: true,
    value: { onLine: true, storage: { estimate: async () => ({ quota: 1000000, usage: 0 }) } }
  });
  global.caches = {
    open: async name => name === 'xandrio-offline-titles' ? titleCache : cache
  };
  global.window.caches = global.caches;
  const audioRequests = [];
  const prepareCalls = [];
  const prepareBodies = [];
  let remainingAudioFailures = transientAudioFailures;
  let remainingStreamFailures = transientStreamFailures;
  global.__offlineApiSend = async (method, requestPath, body) => {
    if (method === 'POST' && requestPath.includes('/prepare-chapter-audio')) {
      prepareCalls.push(Number(requestPath.match(/\/(\d+)\/prepare-chapter-audio$/)?.[1]));
      prepareBodies.push(body);
    }
    return {};
  };
  global.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const chapter = Number(url.match(/(?:\/api\/chunks\/[^/]+\/|\/api\/audio\/[^/]+\/)(\d+)/)?.[1]);
    if (url.includes('chapter-audio-status')) {
      return Response.json({ ready: true, variantKey: variants[chapter], url: `/api/audio/${book.id}/${chapter}` });
    }
    if (url.includes('/api/audio/')) {
      audioRequests.push(chapter);
      if (audioGate) await audioGate;
      if (remainingAudioFailures > 0) {
        remainingAudioFailures -= 1;
        return new Response('try again', { status: 503 });
      }
      const bytes = new TextEncoder().encode(`audio-${variants[chapter]}-${chapter}`);
      if (remainingStreamFailures > 0) {
        remainingStreamFailures -= 1;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 2));
            controller.error(new Error('connection dropped'));
          }
        });
        return new Response(stream, {
          headers: { 'Content-Length': String(bytes.byteLength), ETag: `\"${variants[chapter]}-${chapter}\"` }
        });
      }
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength), ETag: `\"${variants[chapter]}-${chapter}\"` } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  return {
    storage,
    audioRequests,
    prepareCalls,
    prepareBodies,
    documentEvents,
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
    .replace("import { API_BASE, apiSend } from '../api.js';", "const API_BASE = window.location.origin; const apiSend = (...args) => globalThis.__offlineApiSend(...args);")
    .replace("import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';", "const escapeHTML = value => String(value); const relativeTime = () => ''; const formatDuration = () => '';")
    .replace("import { readJSON, writeJSON } from '../util/storage.js';", "const readJSON = (key, fallback = null) => { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }; const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };")
    .replace("import { showToast, showUndoToast } from '../ui/toast.js';", "const showToast = () => {}; const showUndoToast = () => {};")
    .replace(
      "import { planRollingOfflineWindow } from './rolling-offline.mjs';",
      "const planRollingOfflineWindow = ({ currentChapter, chapterCount, cachedChapters = [] }) => { const first = Math.max(0, currentChapter - 1); const last = Math.min(chapterCount - 1, currentChapter + 2); const retain = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index); const cached = new Set(cachedChapters); const kept = new Set(retain); return { retain, prepare: retain.filter(index => !cached.has(index)), evict: [...cached].filter(index => !kept.has(index)).sort((a, b) => a - b) }; };"
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const offline = await import(moduleUrl);
  const book = { id: 'book-1', title: 'A Book' };
  const chapters = [{}, {}];

  await test('writes verified per-chapter identities before marking a book ready', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'ready');
    assert.strictEqual(entry.manifestVersion, 3);
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
    assert(env.prepareBodies.every(body => body?.purpose === 'offline-download'));
    const activityEvents = env.documentEvents.filter(event => event.type === 'xandrio:downloadactivity');
    assert(activityEvents.some(event => event.detail?.downloads?.[0]?.percent >= 0));
    assert.deepStrictEqual(activityEvents.at(-1).detail.downloads, []);
  });

  await test('reports absent, partial, active, and repair states without cache scans', async () => {
    const cache = makeCache();
    let env = installBrowser({ book, chapters, cache });
    offline.initOffline(env.init);
    assert.strictEqual(offline.offlineStatusForBook(book.id).kind, 'not-downloaded');

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
      [{ ...base, mode: 'full', state: 'repairing', progressPercent: 42 }, 'downloading', 'Downloading · 42%'],
      [{ ...base, mode: 'full', state: 'incomplete' }, 'repair-needed', 'Download incomplete'],
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
    await cache.delete('https://reader.test/api/audio/book-1/1');

    env = installBrowser({ book, chapters, cache, manifest: initialManifest });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, [1], 'only the missing chapter should be fetched again');
    assert.deepStrictEqual(env.prepareCalls, [1], 'only the missing chapter should be prepared again');
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
    await cache.put('https://reader.test/api/audio/book-1/0', new Response('corrupt-audio'));

    env = installBrowser({ book, chapters, cache, manifest: initialManifest });
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    assert.deepStrictEqual(env.audioRequests, [0], 'only the invalid chapter should be fetched again');
    assert.deepStrictEqual(env.prepareCalls, [0], 'only the invalid chapter should be prepared again');
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

  await test('adopts usable legacy cache entries during repair without deleting them', async () => {
    const cache = makeCache();
    const key = 'https://reader.test/api/audio/book-1/0';
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

    assert.deepStrictEqual(env.audioRequests, [], 'usable legacy cache should not be re-downloaded');
    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'ready');
    assert.strictEqual(entry.chapterEntries[0].size, bytes.byteLength);
    assert.strictEqual(await offline.verifyOfflineEntry(cache, entry), true);
  });

  await test('keeps a failed repair resumable instead of claiming readiness', async () => {
    const cache = makeCache();
    const env = installBrowser({ book, chapters, cache });
    const normalFetch = global.fetch;
    global.fetch = async (input, options) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/audio/book-1/1')) return new Response('nope', { status: 503 });
      return normalFetch(input, options);
    };
    offline.initOffline(env.init);
    await offline.downloadCurrentBook();

    const entry = offline.getOfflineManifest()[book.id];
    assert.strictEqual(entry.state, 'incomplete');
    assert.strictEqual(entry.chapterEntries[0].size > 0, true, 'completed audio remains available for resume');
    assert.strictEqual(entry.chapterEntries[1], null);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id), false);
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
    await cache.delete('https://reader.test/api/audio/book-1/1');
    env.audioRequests.length = 0;
    env.prepareCalls.length = 0;

    offline.renderOfflineState();
    await offline.auditOfflineManifest();

    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
    assert.deepStrictEqual(env.prepareCalls, []);
    assert.deepStrictEqual(env.audioRequests, []);
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
    assert.strictEqual(await cache.match('https://reader.test/api/audio/book-1/1'), undefined);
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
      assert(await cache.match(`https://reader.test/api/audio/book-1/${index}`));
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
    await cache.delete('https://reader.test/api/audio/book-1/1');

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

    releaseAudio();
    await download;
    assert.strictEqual(offline.getOfflineManifest()[book.id].state, 'incomplete');
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
    assert(librarySource.includes('getOfflineLibraryBooks()'));
    assert(librarySource.includes('onBookDeleted'));
    assert(librarySource.includes('await removeOfflineBook(id, { removePlaybackState: true })'));
    assert(workerSource.includes("const OFFLINE_TITLE_CACHE = 'xandrio-offline-titles';"));
    assert(workerSource.includes('isOfflineTitleRequest(request)'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
