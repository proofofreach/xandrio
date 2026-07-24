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
    }
  };
}

function installBrowser({ book, chapters, cache, manifest = {}, variants = ['voice-a', 'voice-a'] }) {
  const storage = new Map();
  storage.set('xandrio_offline_books', JSON.stringify(manifest));
  const elements = new Map([
    ['player-voice-name', { textContent: 'Narrator' }]
  ]);
  global.localStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  global.window = { location: { origin: 'https://reader.test' }, addEventListener() {} };
  global.document = { getElementById: id => elements.get(id) || null };
  global.navigator = { onLine: true, storage: { estimate: async () => ({ quota: 1000000, usage: 0 }) } };
  global.caches = { open: async () => cache };
  global.window.caches = global.caches;
  const audioRequests = [];
  const prepareCalls = [];
  global.__offlineApiSend = async (method, requestPath) => {
    if (method === 'POST' && requestPath.includes('/prepare-chapter-audio')) {
      prepareCalls.push(Number(requestPath.match(/\/(\d+)\/prepare-chapter-audio$/)?.[1]));
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
      const bytes = new TextEncoder().encode(`audio-${variants[chapter]}-${chapter}`);
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength), ETag: `\"${variants[chapter]}-${chapter}\"` } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  return { storage, audioRequests, prepareCalls, init: { getCurrentBook: () => book, getChapters: () => chapters } };
}

(async () => {
  // API_BASE is captured while the module evaluates.
  global.window = { location: { origin: 'https://reader.test' }, addEventListener() {} };
  global.crypto = require('crypto').webcrypto;
  let source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'offline.js'), 'utf8');
  source = source
    .replace("import { API_BASE, apiSend } from '../api.js';", "const API_BASE = window.location.origin; const apiSend = (...args) => globalThis.__offlineApiSend(...args);")
    .replace("import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';", "const escapeHTML = value => String(value); const relativeTime = () => ''; const formatDuration = () => '';")
    .replace("import { readJSON, writeJSON } from '../util/storage.js';", "const readJSON = (key, fallback = null) => { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }; const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));")
    .replace("import { showToast, showUndoToast } from '../ui/toast.js';", "const showToast = () => {}; const showUndoToast = () => {};");
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
    assert.strictEqual(entry.manifestVersion, 2);
    assert.strictEqual(entry.chapterEntries.length, 2);
    assert.deepStrictEqual(entry.chapterEntries.map(chapter => chapter.variantKey), ['voice-a', 'voice-a']);
    assert(entry.chapterEntries.every(chapter => chapter.size > 0 && /^sha256-[a-f0-9]{64}$/.test(chapter.contentHash)));
    assert.strictEqual(await offline.verifyOfflineEntry(cache, entry), true);
    assert.strictEqual(offline.isBookDownloadedForOffline(book.id, 1), true);
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
