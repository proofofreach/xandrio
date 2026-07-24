/** Offline contract tests for the public Z-Library client interface. */
const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { ReadableStream } = require('stream/web');
const { createZLibraryClient, ZLibraryError, BUILT_IN_BASE_URLS } = require('../lib/zlibrary');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (error) { console.error(`  ❌ ${name}`); throw error; }
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function bytes(value, headers = {}) {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(value)); controller.close(); } }), { status: 200, headers: { 'content-type': 'application/epub+zip', ...headers } });
}
function queuedFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected fetch');
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { fetchImpl, calls };
}
async function tempClient(fetchImpl, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zlibrary-'));
  return { directory, authFile: path.join(directory, 'auth.json'), client: createZLibraryClient({ fetchImpl, lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }], authFile: path.join(directory, 'auth.json'), baseUrl: 'https://z-library.test', fallbackBaseUrls: [], requestTimeoutMs: 100, downloadTimeoutMs: 100, maxDownloadBytes: 100, maxJsonBytes: 4096, ...options }) };
}
async function writesSession(authFile) { await fs.writeFile(authFile, JSON.stringify({ version: 2, userId: '7', userKey: 'token', baseUrl: 'https://z-library.test', verifiedAt: '2026-01-01T00:00:00.000Z' })); }

(async () => {
  console.log('\n━━━ Z-Library client ━━━');
  await test('search is anonymous and encodes repeated filters', async () => {
    const mock = queuedFetch(json({ success: true, books: [{ id: 1, title: 'Book', extension: 'epub', hash: 'h' }] }));
    const { client, directory } = await tempClient(mock.fetchImpl);
    const results = await client.search('book', { limit: 2, extensions: ['epub', 'pdf'], languages: ['english', 'spanish'] });
    assert.equal(results[0].source, 'zlibrary');
    assert.equal(mock.calls[0].options.headers.Cookie, undefined);
    assert.match(mock.calls[0].options.body, /extensions%5B%5D=epub/);
    assert.match(mock.calls[0].options.body, /extensions%5B%5D=pdf/);
    assert.match(mock.calls[0].options.body, /languages%5B%5D=english/);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('search preserves cover and ISBN metadata needed by result cards', async () => {
    const mock = queuedFetch(json({ success: true, books: [{
      id: 1,
      title: 'Covered Book',
      author: 'Known Author',
      extension: 'epub',
      hash: 'covered',
      cover: 'https://covers.z-library.test/covered.jpg',
      identifier: '9780316284820, 0316284823'
    }] }));
    const { client, directory } = await tempClient(mock.fetchImpl);
    const [result] = await client.search('covered book');
    assert.equal(result.coverUrl, 'https://covers.z-library.test/covered.jpg');
    assert.deepEqual(result.isbn, ['9780316284820', '0316284823']);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('built-in fallbacks include every public domain from the access guide', async () => {
    assert.deepEqual(BUILT_IN_BASE_URLS, [
      'https://go-to-library.sk',
      'https://z-library.sk',
      'https://z-lib.sk',
      'https://z-lib.fm',
      'https://z-lib.gd'
    ]);
  });

  await test('connect validates then persists token-only v2 session', async () => {
    const mock = queuedFetch(
      json({ success: true, response: { user_id: '7', user_key: 'token' } }),
      json({ success: true, user: { downloads_today: 2, downloads_limit: 10 } })
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    const status = await client.connect({ email: 'reader@example.test', password: 'secret' });
    const saved = JSON.parse(await fs.readFile(authFile, 'utf8'));
    assert.equal(status.downloadsRemaining, 8);
    assert.deepEqual(Object.keys(saved).sort(), ['baseUrl', 'userId', 'userKey', 'verifiedAt', 'version']);
    assert.equal((await fs.stat(authFile)).mode & 0o777, 0o600);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('connect accepts the current EAPI user token shape', async () => {
    const mock = queuedFetch(
      json({ success: 1, user: { id: 7, remix_userkey: 'token' } }),
      json({ success: 1, user: { downloads_today: 0, downloads_limit: 10 } })
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl, { now: () => new Date('2026-07-11T18:00:00.000Z') });
    const status = await client.connect({ email: 'reader@example.test', password: 'secret' });
    assert.equal(JSON.parse(await fs.readFile(authFile, 'utf8')).verifiedAt, '2026-07-11T18:00:00.000Z');
    assert.equal(status.lastVerifiedAt, '2026-07-11T18:00:00.000Z');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('rejected login never creates a credential file', async () => {
    const mock = queuedFetch(json({ success: false, errors: ['bad credentials'] }));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await assert.rejects(() => client.connect({ email: 'reader@example.test', password: 'bad' }), error => error.code === 'ZLIB_AUTH_INVALID');
    await assert.rejects(() => fs.access(authFile));
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('legacy sessions are scrubbed before they are used', async () => {
    const mock = queuedFetch(json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } }));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await fs.writeFile(authFile, JSON.stringify({ userId: '7', userKey: 'token', email: 'reader@example.test', password: 'secret', loginAt: Date.now() }));
    assert.equal((await client.getStatus()).state, 'connected');
    const saved = JSON.parse(await fs.readFile(authFile, 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(Object.hasOwn(saved, 'email'), false);
    assert.equal(Object.hasOwn(saved, 'password'), false);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('anonymous search failures throw a typed upstream error', async () => {
    const mock = queuedFetch(json({ message: 'down' }, 503), json({ message: 'down' }, 503));
    const { client, directory } = await tempClient(mock.fetchImpl, { sleep: async () => {} });
    await assert.rejects(() => client.search('book'), error => error.code === 'ZLIB_UNAVAILABLE');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('anonymous search discovers a working content domain without auth headers', async () => {
    const mock = queuedFetch(
      json({ message: 'down' }, 503),
      json({ message: 'down' }, 503),
      json({ success: 1, domains: [{ domain: 'working.test', contentAvailable: true, isRedirector: false }] }),
      json({ success: 1, books: [{ id: 1, title: 'Recovered', extension: 'epub', hash: 'h' }] })
    );
    const { client, directory } = await tempClient(mock.fetchImpl, { sleep: async () => {} });
    const results = await client.search('book');
    assert.equal(results[0].title, 'Recovered');
    assert.equal(mock.calls[2].url, 'https://z-library.test/eapi/info/domains');
    assert.equal(mock.calls[2].options.headers.Cookie, undefined);
    assert.equal(mock.calls[3].url, 'https://working.test/eapi/book/search');
    assert.equal(mock.calls[3].options.headers.Cookie, undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('request aborts classify as timeouts', async () => {
    const abort = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const mock = queuedFetch(abort(), abort());
    const { client, directory } = await tempClient(mock.fetchImpl, { sleep: async () => {} });
    await assert.rejects(() => client.search('book'), error => error.code === 'ZLIB_TIMEOUT');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('authenticated JSON requests disable automatic redirects', async () => {
    const mock = queuedFetch(new Response('', {
      status: 302,
      headers: { location: 'https://attacker.example/collect' }
    }));
    const { client, directory } = await tempClient(mock.fetchImpl);
    await assert.rejects(
      () => client.connect({ email: 'reader@example.test', password: 'secret' }),
      error => error.code === 'ZLIB_UNAVAILABLE'
    );
    assert.strictEqual(mock.calls.length, 1);
    assert.strictEqual(mock.calls[0].options.redirect, 'manual');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('JSON responses are bounded before parsing', async () => {
    const mock = queuedFetch(json({ success: 1, books: [], padding: 'x'.repeat(256) }));
    const { client, directory } = await tempClient(mock.fetchImpl, { maxJsonBytes: 64 });
    await assert.rejects(() => client.search('book'), error => error.code === 'ZLIB_UNAVAILABLE');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('request deadline remains active while reading a JSON body', async () => {
    const fetchImpl = async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          controller.error(error);
        }, { once: true });
        controller.enqueue(Buffer.from('{'));
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { client, directory } = await tempClient(fetchImpl, { requestTimeoutMs: 20 });
    await assert.rejects(
      Promise.race([
        client.connect({ email: 'reader@example.test', password: 'secret' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('test deadline exceeded')), 250))
      ]),
      error => error.code === 'ZLIB_TIMEOUT'
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('search retries only eligible transient responses', async () => {
    for (const [label, firstResponse] of [
      ['HTTP 500', json({ message: 'error' }, 500)],
      ['429 without short Retry-After', json({ message: 'slow down' }, 429)],
      ['HTML challenge', new Response('<html>challenge</html>', { status: 503, headers: { 'content-type': 'text/html' } })]
    ]) {
      const mock = queuedFetch(firstResponse);
      const { client, directory } = await tempClient(mock.fetchImpl, { sleep: async () => {} });
      await assert.rejects(() => client.search('book'), error => error.code === 'ZLIB_UNAVAILABLE' || error.code === 'ZLIB_RATE_LIMITED', label);
      assert.equal(
        mock.calls.filter(call => call.url === 'https://z-library.test/eapi/book/search').length,
        1,
        `${label} must not retry on the same domain`
      );
      await fs.rm(directory, { recursive: true, force: true });
    }

    const retryableMock = queuedFetch(
      json({ message: 'slow down' }, 429, { 'retry-after': '1' }),
      json({ success: 1, books: [] })
    );
    const { client, directory } = await tempClient(retryableMock.fetchImpl, { sleep: async () => {} });
    assert.deepEqual(await client.search('book'), []);
    assert.equal(retryableMock.calls.length, 2, '429 with short Retry-After retries once');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('status distinguishes an expired token and disconnect clears storage', async () => {
    const mock = queuedFetch(json({ message: 'Please login' }, 400));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    const status = await client.getStatus();
    assert.equal(status.state, 'auth-expired');
    assert.equal(status.searchAvailable, true);
    assert.equal(status.downloadAvailable, false);
    await client.disconnect();
    assert.equal(client.hasStoredSession(), false);
    await assert.rejects(() => fs.access(authFile));
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('status treats a generic authenticated 401 as an expired session', async () => {
    const mock = queuedFetch(json({ message: 'Unauthorized' }, 401));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    const status = await client.getStatus();
    assert.equal(status.state, 'auth-expired');
    assert.equal(status.errorCode, 'ZLIB_AUTH_EXPIRED');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('status treats a generic authenticated profile 400 as an expired session', async () => {
    const mock = queuedFetch(json({ message: 'Bad request' }, 400));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    const status = await client.getStatus();
    assert.equal(status.state, 'auth-expired');
    assert.equal(status.errorCode, 'ZLIB_AUTH_EXPIRED');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('IPv4-mapped IPv6 loopback base URLs are rejected before fetch', async () => {
    let fetchCalls = 0;
    const { client, directory } = await tempClient(async () => {
      fetchCalls++;
      throw new Error('must not fetch');
    }, { baseUrl: 'https://[::ffff:127.0.0.1]' });
    await assert.rejects(() => client.search('book'), error => error.code === 'ZLIB_UNAVAILABLE');
    assert.equal(fetchCalls, 0);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('hostnames resolving to private addresses are rejected before fetch', async () => {
    let fetchCalls = 0;
    const { client, directory } = await tempClient(async () => {
      fetchCalls++;
      throw new Error('must not fetch');
    }, { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }] });
    await assert.rejects(() => client.search('book'), error => error.code === 'ZLIB_UNAVAILABLE');
    assert.equal(fetchCalls, 0);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('a stalled DNS lookup is bounded by the request deadline', async () => {
    let fetchCalls = 0;
    const { client, directory } = await tempClient(async () => {
      fetchCalls++;
      throw new Error('must not fetch');
    }, { lookupImpl: async () => new Promise(resolve => {
      const timer = setTimeout(() => resolve([]), 1000);
      timer.unref?.();
    }), requestTimeoutMs: 20 });
    const started = Date.now();
    await assert.rejects(
      () => client.connect({ email: 'reader@example.test', password: 'not-persisted' }),
      error => error.code === 'ZLIB_TIMEOUT'
    );
    assert(Date.now() - started < 200);
    assert.equal(fetchCalls, 0);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('stored untrusted domains never receive session credentials', async () => {
    const mock = queuedFetch(json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } }));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await fs.writeFile(authFile, JSON.stringify({
      version: 2,
      userId: '7',
      userKey: 'token',
      baseUrl: 'https://attacker.test',
      verifiedAt: '2026-01-01T00:00:00.000Z'
    }));
    const status = await client.getStatus();
    assert.equal(status.state, 'connected');
    assert.equal(mock.calls[0].url, 'https://z-library.test/eapi/user/profile');
    assert.equal(mock.calls.some(call => call.url.startsWith('https://attacker.test/')), false);
    assert.equal(JSON.parse(await fs.readFile(authFile, 'utf8')).baseUrl, 'https://z-library.test');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('status falls back directly to a trusted built-in domain', async () => {
    const mock = queuedFetch(
      json({ message: 'down' }, 503),
      json({ message: 'down' }, 503),
      json({ success: 1, user: { downloads_today: 2, downloads_limit: 10 } })
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl, {
      fallbackBaseUrls: ['https://backup.test'],
      sleep: async () => {}
    });
    await writesSession(authFile);
    assert.equal((await client.getStatus()).state, 'connected');
    assert.equal(mock.calls[2].url, 'https://backup.test/eapi/user/profile');
    assert.equal(JSON.parse(await fs.readFile(authFile, 'utf8')).baseUrl, 'https://backup.test');
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('download checks live quota before requesting a file ticket', async () => {
    const mock = queuedFetch(json({ success: true, user: { downloads_today: 10, downloads_limit: 10 } }));
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    await assert.rejects(() => client.download({ zlibId: '1', hash: 'h' }, path.join(directory, 'book.epub')), error => error instanceof ZLibraryError && error.code === 'ZLIB_DAILY_LIMIT');
    assert.equal(mock.calls.length, 1);
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('authenticated file-ticket 400 is an expired session', async () => {
    const mock = queuedFetch(
      json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } }),
      json({ message: 'Bad request' }, 400)
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    await assert.rejects(
      () => client.download({ zlibId: '1', hash: 'h' }, path.join(directory, 'book.epub')),
      error => error.code === 'ZLIB_AUTH_EXPIRED'
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('malformed download URLs produce a redacted typed error', async () => {
    const mock = queuedFetch(
      json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } }),
      json({ success: 1, file: { downloadLink: 'not-a-url?token=secret' } })
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    await assert.rejects(
      () => client.download({ zlibId: '1', hash: 'h' }, path.join(directory, 'book.epub')),
      error => error.code === 'ZLIB_DOWNLOAD_INVALID' &&
        !String(error.stack).includes('token=secret') &&
        !JSON.stringify(error).includes('token=secret')
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('malformed redirect URLs produce a redacted typed error', async () => {
    const mock = queuedFetch(
      json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } }),
      json({ success: 1, file: { downloadLink: 'https://cdn.example.test/book.epub' } }),
      new Response('', { status: 302, headers: { location: 'https://[::1?token=secret' } })
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    await assert.rejects(
      () => client.download({ zlibId: '1', hash: 'h' }, path.join(directory, 'book.epub')),
      error => error.code === 'ZLIB_DOWNLOAD_INVALID' &&
        !String(error.stack).includes('token=secret') &&
        !JSON.stringify(error).includes('token=secret')
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  await test('download streams atomically and does not send cookies to a CDN', async () => {
    const mock = queuedFetch(
      json({ success: true, user: { downloads_today: 1, downloads_limit: 10 } }),
      json({ success: true, file: { downloadLink: 'https://cdn.example.test/book.epub' } }),
      bytes('epub-bytes', { 'content-length': '10' })
    );
    const { client, authFile, directory } = await tempClient(mock.fetchImpl);
    await writesSession(authFile);
    const destination = path.join(directory, 'book.epub');
    await client.download({ zlibId: '1', hash: 'h' }, destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'epub-bytes');
    assert.equal(mock.calls[2].url, 'https://cdn.example.test/book.epub');
    assert.equal(mock.calls[2].options.headers.Cookie, undefined);
    await assert.rejects(() => fs.access(`${destination}.part`));
    await fs.rm(directory, { recursive: true, force: true });
  });

  for (const [label, payload] of [
    ['obvious HTML bytes', '<html><body>challenge</body></html>'],
    ['an oversized stream', 'x'.repeat(101)]
  ]) {
    await test(`invalid download (${label}) removes its part file and preserves destination`, async () => {
      const mock = queuedFetch(
        json({ success: 1, user: { downloads_today: 1, downloads_limit: 10 } }),
        json({ success: 1, file: { downloadLink: 'https://cdn.example.test/book.epub' } }),
        bytes(payload, { 'content-type': 'application/octet-stream' })
      );
      const { client, authFile, directory } = await tempClient(mock.fetchImpl);
      await writesSession(authFile);
      const destination = path.join(directory, 'book.epub');
      await fs.writeFile(destination, 'existing-book');
      await assert.rejects(() => client.download({ zlibId: '1', hash: 'h' }, destination), error => error.code === 'ZLIB_DOWNLOAD_INVALID');
      assert.equal(await fs.readFile(destination, 'utf8'), 'existing-book');
      await assert.rejects(() => fs.access(`${destination}.part`));
      await fs.rm(directory, { recursive: true, force: true });
    });
  }

  console.log(`\n${passed} passed`);
})().catch(error => { console.error(error); process.exit(1); });
