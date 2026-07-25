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

function loadFetchHandler() {
  const listeners = new Map();
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'sw.js'),
    'utf8'
  );
  const context = {
    URL,
    Request,
    Response,
    Headers,
    importScripts() {},
    fetch: async () => new Response('online audio'),
    caches: {
      async open() {
        return {
          async match() { return undefined; },
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
  return listeners.get('fetch');
}

function dispatchFetch(handler, url) {
  let responsePromise = null;
  handler({
    request: new Request(url, {
      headers: { Range: 'bytes=0-' }
    }),
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
    waitUntil() {}
  });
  return responsePromise;
}

(async () => {
  const fetchHandler = loadFetchHandler();

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

  await test('scoped offline audio still uses service-worker fallback routing', async () => {
    const response = dispatchFetch(
      fetchHandler,
      'https://reader.test/api/audio/book-1/0?xandrio-offline-scope=account_a'
    );
    assert(response, 'the service worker should handle explicitly scoped offline audio');
    assert.strictEqual((await response).status, 200);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
