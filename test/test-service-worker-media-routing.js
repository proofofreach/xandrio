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

function loadFetchHandler({ cached = new Map(), network = null } = {}) {
  const listeners = new Map();
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'sw.js'),
    'utf8'
  );
  const networkCalls = [];
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
      async open() {
        return {
          async match(input) {
            const key = typeof input === 'string' ? input : input.url;
            const hit = cached.get(key);
            return hit ? hit.clone() : undefined;
          },
          async put() {}
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
  return { handler: listeners.get('fetch'), networkCalls, cacheVersion };
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
