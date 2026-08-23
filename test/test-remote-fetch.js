const assert = require('assert');
const { Readable } = require('stream');
const { requestRemote, readBoundedBuffer } = require('../lib/remote-fetch');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

function responseStream(body) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.statusCode = 200;
  stream.statusMessage = 'OK';
  stream.headers = { 'content-length': String(Buffer.byteLength(body)) };
  stream.rawHeaders = ['content-length', String(Buffer.byteLength(body))];
  return stream;
}

(async () => {
  await test('production transport pins its connection to the validated DNS address', async () => {
    let fetchOptions;
    let dispatcherOptions;
    let dispatcherClosed = false;
    const remote = await requestRemote('https://catalog.example/feed.xml', {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: () => { throw new Error('legacy https transport used'); },
      directFetchImpl: async (_url, options) => {
        fetchOptions = options;
        return new Response('ok');
      },
      dispatcherFactory: options => {
        dispatcherOptions = options;
        return { close: async () => { dispatcherClosed = true; } };
      }
    });
    try {
      const pinned = await new Promise((resolve, reject) => {
        dispatcherOptions.connect.lookup('catalog.example', {}, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address, family });
        });
      });
      assert.deepStrictEqual(pinned, { address: '93.184.216.34', family: 4 });
      const pinnedAll = await new Promise((resolve, reject) => {
        dispatcherOptions.connect.lookup('catalog.example', { all: true }, (error, records) => {
          if (error) reject(error);
          else resolve(records);
        });
      });
      assert.deepStrictEqual(pinnedAll, [{ address: '93.184.216.34', family: 4 }]);
      assert.strictEqual(fetchOptions.dispatcher !== undefined, true);
      assert.strictEqual((await readBoundedBuffer(remote.response, 16)).toString(), 'ok');
    } finally {
      remote.close();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(dispatcherClosed, true);
  });

  await test('proxy transport connects to the validated address while preserving TLS and Host identity', async () => {
    let fetchUrl;
    let fetchOptions;
    let dispatcherOptions;
    const remote = await requestRemote('https://catalog.example/feed.xml', {
      proxyUrl: 'http://127.0.0.1:3128',
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: () => { throw new Error('legacy proxy transport used'); },
      directFetchImpl: async (url, options) => {
        fetchUrl = new URL(url);
        fetchOptions = options;
        return new Response('ok');
      },
      proxyDispatcherFactory: options => {
        dispatcherOptions = options;
        return { close: async () => {} };
      }
    });
    try {
      assert.strictEqual(fetchUrl.hostname, '93.184.216.34');
      assert.strictEqual(fetchOptions.headers.host, 'catalog.example');
      assert.strictEqual(dispatcherOptions.uri, 'http://127.0.0.1:3128');
      assert.strictEqual(dispatcherOptions.requestTls.servername, 'catalog.example');
      assert.strictEqual((await readBoundedBuffer(remote.response, 16)).toString(), 'ok');
    } finally {
      remote.close();
    }
  });

  await test('production transport preserves an explicit method and request body', async () => {
    let requestOptions;
    let endedWith;
    const remote = await requestRemote('https://catalog.example/session', {
      method: 'POST',
      body: 'key=value',
      headersForUrl: () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      requestImpl: (_url, options, callback) => {
        requestOptions = options;
        queueMicrotask(() => callback(responseStream('{}')));
        return { once: () => {}, end: body => { endedWith = body; } };
      }
    });
    try {
      assert.strictEqual(requestOptions.method, 'POST');
      assert.strictEqual(endedWith, 'key=value');
      assert.strictEqual((await readBoundedBuffer(remote.response, 16)).toString(), '{}');
    } finally {
      remote.close();
    }
  });

  await test('a 303 redirect becomes GET and does not replay the request body', async () => {
    const requests = [];
    const remote = await requestRemote('https://catalog.example/session', {
      method: 'POST',
      body: 'secret=form-value',
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (_url, options) => {
        requests.push({ method: options.method, body: options.body });
        return requests.length === 1
          ? new Response(null, { status: 303, headers: { location: '/result' } })
          : new Response('ok');
      }
    });
    try {
      assert.deepStrictEqual(requests, [
        { method: 'POST', body: 'secret=form-value' },
        { method: 'GET', body: undefined }
      ]);
    } finally {
      remote.close();
    }
  });

  await test('rejects a private target before invoking the HTTP transport', async () => {
    let calls = 0;
    await assert.rejects(
      requestRemote('https://127.0.0.1/private', {
        fetchImpl: async () => { calls += 1; throw new Error('must not fetch'); }
      }),
      /safe public HTTPS URL/
    );
    assert.strictEqual(calls, 0);
  });

  await test('rejects a redirect to a link-local address before following it', async () => {
    let calls = 0;
    await assert.rejects(
      requestRemote('https://catalog.example/redirect', {
        lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, {
            status: 302,
            headers: { location: 'https://169.254.169.254/latest/meta-data/' }
          });
        }
      }),
      /safe public HTTPS URL/
    );
    assert.strictEqual(calls, 1);
  });

  await test('rejects an oversized declared body before consuming or writing it', async () => {
    let bodyAccessed = false;
    const response = {
      headers: { get: name => name === 'content-length' ? '2048' : null },
      get body() {
        bodyAccessed = true;
        return Readable.toWeb(Readable.from([Buffer.from('body')]));
      }
    };
    await assert.rejects(readBoundedBuffer(response, 1024), /exceeds the allowed size/);
    assert.strictEqual(bodyAccessed, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
