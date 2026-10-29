const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function loadFetchHandler({ cached = new Map(), network = null, cacheError = null } = {}) {
  const listeners = new Map();
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'sw.js'),
    'utf8'
  );
  const networkCalls = [];
  const openedCaches = [];
  const cacheWrites = [];
  const context = {
    URL,
    Request,
    Response,
    Headers,
    importScripts() {},
    fetch: async (request) => {
      networkCalls.push(typeof request === 'string' ? request : request.url);
      return network ? network() : new Response('online audio');
    },
    caches: {
      async open(name) {
        openedCaches.push(name);
        if (cacheError) throw cacheError;
        return {
          async match(input) {
            const key = typeof input === 'string' ? input : input.url;
            const hit = cached.get(key);
            return hit ? hit.clone() : undefined;
          },
          async put(...args) { cacheWrites.push(args); }
        };
      },
      async has() { return true; },
      async keys() { return []; },
      async match() { return undefined; }
    },
    self: {
      location: { origin: 'https://reader.test' },
      clients: { async claim() {} },
      XandrioOfflineRange: {
        async createRangeResponse() { return null; }
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      }
    }
  };
  vm.runInNewContext(source, context, { filename: 'public/sw.js' });
  const cacheVersion = source.match(/const CACHE_VERSION = '([^']+)'/)?.[1] || '';
  return { handler: listeners.get('fetch'), networkCalls, cacheVersion, openedCaches, cacheWrites };
}

function dispatchFetch(handler, url, range = null) {
  let responsePromise = null;
  handler({
    request: new Request(url, range ? { headers: { Range: range } } : undefined),
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
    waitUntil() {}
  });
  return responsePromise;
}

const SCOPED_AUDIO = 'https://reader.test/api/audio/book-1/0?xandrio-offline-scope=account_a';

(async () => {
  const { handler: fetchHandler } = loadFetchHandler();

  await test('an installed shell loads without waiting for a stalled network', async () => {
    const url = 'https://reader.test/js/api.js';
    const { handler, networkCalls, openedCaches, cacheVersion } = loadFetchHandler({
      cached: new Map([[url, new Response('installed module')]]),
      network: () => new Promise(() => {})
    });
    const response = await Promise.race([
      dispatchFetch(handler, url),
      new Promise(resolve => setTimeout(() => resolve(null), 100))
    ]);
    assert(response, 'cached shell must not wait for network settlement');
    assert.strictEqual(await response.text(), 'installed module');
    assert.deepStrictEqual(networkCalls, []);
    assert.deepStrictEqual(openedCaches, [cacheVersion], 'only the active build supplies shell assets');
  });

  await test('navigation queries use the installed index without mixing shell builds', async () => {
    const { handler, networkCalls } = loadFetchHandler({
      cached: new Map([['/', new Response('installed index')]])
    });
    const response = await dispatchFetch(handler, 'https://reader.test/?from=notification');
    assert.strictEqual(await response.text(), 'installed index');
    assert.deepStrictEqual(networkCalls, []);
  });

  await test('a missing shell entry uses the network without mutating the installed build', async () => {
    const { handler, networkCalls, cacheWrites } = loadFetchHandler({
      network: () => new Response('network module')
    });
    const response = await dispatchFetch(handler, 'https://reader.test/js/api.js');
    assert.strictEqual(await response.text(), 'network module');
    assert.deepStrictEqual(networkCalls, ['https://reader.test/js/api.js']);
    assert.deepStrictEqual(cacheWrites, [], 'individual requests cannot overwrite a build snapshot');
  });

  await test('uncached same-origin assets remain outside the shell handler', async () => {
    const { handler, networkCalls, openedCaches } = loadFetchHandler();
    assert.strictEqual(dispatchFetch(handler, 'https://reader.test/unrelated.js'), null);
    assert.deepStrictEqual(networkCalls, []);
    assert.deepStrictEqual(openedCaches, []);
  });

  await test('an unavailable browser cache still permits an online shell launch', async () => {
    const { handler, networkCalls } = loadFetchHandler({
      cacheError: new Error('Browser storage unavailable'),
      network: () => new Response('online shell')
    });
    const response = await dispatchFetch(handler, 'https://reader.test/js/api.js');
    assert.strictEqual(await response.text(), 'online shell');
    assert.strictEqual(networkCalls.length, 1);
  });

  await test('online iOS audio stays on the native media request path', async () => {
    const response = dispatchFetch(
      fetchHandler,
      'https://reader.test/api/audio-ios/book-1/0'
    );
    assert.strictEqual(
      response,
      null,
      'the service worker must not proxy an unscoped online media request'
    );
  });

  // Cache-only is the permanent contract for an explicitly scoped offline URL.
  // Network-first meant a downloaded book still streamed while online, and the
  // server route behind that URL serves a *different* encode from the one that
  // was downloaded, so falling through to it is never correct.

  await test('a scoped offline hit is served from cache with no network request', async () => {
    const cached = new Map([[SCOPED_AUDIO, new Response('cached audio', {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '12' }
    })]]);
    const { handler, networkCalls, cacheVersion } = loadFetchHandler({ cached });

    const response = await dispatchFetch(handler, SCOPED_AUDIO);

    assert(response, 'the worker handles explicitly scoped offline audio');
    assert.deepStrictEqual(networkCalls, [], 'a cached chapter must never touch the network');
    assert.strictEqual(response.headers.get('X-Xandrio-Offline-Cache'), 'hit');
    assert.strictEqual(response.headers.get('X-Xandrio-SW'), cacheVersion);
  });

  await test('a scoped offline miss is diagnosable and still never hits the network', async () => {
    const { handler, networkCalls, cacheVersion } = loadFetchHandler();

    const response = await dispatchFetch(handler, SCOPED_AUDIO);

    assert(response, 'the worker answers the request itself');
    assert.deepStrictEqual(networkCalls, [], 'a miss must not silently stream from the server');
    assert.strictEqual(response.status, 504);
    assert.strictEqual(
      response.headers.get('X-Xandrio-Offline-Cache'),
      'miss',
      'the app must be able to tell a deterministic miss from a transient media error'
    );
    assert.strictEqual(response.headers.get('X-Xandrio-SW'), cacheVersion);
  });

  await test('a scoped Range request is served 206 from cache with the hit marker', async () => {
    const cached = new Map([[SCOPED_AUDIO, new Response('0123456789', {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' }
    })]]);
    const { handler, networkCalls, cacheVersion } = loadFetchHandler({ cached });

    const response = await dispatchFetch(handler, SCOPED_AUDIO, 'bytes=0-1');

    assert.strictEqual(response.status, 206);
    assert.strictEqual(response.headers.get('Content-Range'), 'bytes 0-1/10');
    assert.strictEqual(response.headers.get('Content-Length'), '2');
    assert.strictEqual(response.headers.get('X-Xandrio-Offline-Cache'), 'hit');
    assert.strictEqual(response.headers.get('X-Xandrio-SW'), cacheVersion);
    assert.deepStrictEqual(networkCalls, []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
