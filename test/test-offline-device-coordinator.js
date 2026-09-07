const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const PUBLIC = path.join(__dirname, '..', 'public');
const BLOCK_SIZE = 1024 * 1024;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

const waitFor = async (condition, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for coordinator activity');
};

function sha(bytes) {
  return `sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function fixture(bookId, revision = 'source-v1', fill = 1) {
  const bytes = Buffer.from([fill, fill + 1, fill + 2, fill + 3]);
  const artifactId = sha(bytes);
  return {
    bytes,
    descriptor: {
      index: 0,
      state: 'ready',
      artifactId,
      contentHash: artifactId,
      etag: `"${artifactId}"`,
      size: bytes.length,
      blockSize: BLOCK_SIZE,
      blockHashes: [artifactId],
      url: `/api/offline/audio/${encodeURIComponent(bookId)}/0`,
      contentType: 'audio/mpeg',
      variantKey: 'offline-mp3-v1:br48k',
      provenance: 'verified',
      sourceFingerprint: revision
    },
    manifest: {
      schemaVersion: 1,
      bookId,
      revision: `descriptor-${revision}`,
      sourceRevision: revision,
      packageVariantKey: 'offline-mp3-v1:br48k',
      state: 'ready',
      totalChapters: 1,
      readyChapters: 1,
      bytesPrepared: bytes.length,
      bytesTotal: bytes.length,
      chapters: []
    }
  };
}

async function main() {
  const state = {
    fixtures: new Map(),
    posts: [],
    audioRequests: [],
    heldPosts: new Set(),
    heldManifests: new Set(),
    hungManifestBodies: new Set(),
    oversizedManifestBodies: new Set(),
    postResponses: new Map(),
    manifestResponses: new Map()
  };
  const getFixture = bookId => {
    if (!state.fixtures.has(bookId)) state.fixtures.set(bookId, fixture(bookId));
    return state.fixtures.get(bookId);
  };
  const release = (map, bookId, status = 200) => {
    const responses = map.get(bookId) || [];
    map.delete(bookId);
    for (const response of responses) {
      if (status !== 200) response.writeHead(status).end('failed');
      else response.writeHead(202, { 'Content-Type': 'application/json' }).end('{}');
    }
  };
  const releaseManifest = bookId => {
    const responses = state.manifestResponses.get(bookId) || [];
    state.manifestResponses.delete(bookId);
    const item = getFixture(bookId);
    if (!item.manifest.chapters.length) item.manifest.chapters = [item.descriptor];
    for (const response of responses) {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: `"${item.manifest.revision}"`
      });
      response.end(JSON.stringify(item.manifest));
    }
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end('<!doctype html><title>offline device test</title>');
    }
    if (url.pathname.startsWith('/js/')) {
      const file = path.join(PUBLIC, url.pathname);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return response.writeHead(404).end();
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      return fs.createReadStream(file).pipe(response);
    }
    const manifestMatch = url.pathname.match(/^\/api\/offline\/preparation\/([^/]+)\/manifest$/);
    if (manifestMatch && request.method === 'GET') {
      const bookId = decodeURIComponent(manifestMatch[1]);
      if (state.oversizedManifestBodies.has(bookId)) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"padding":"');
        for (let index = 0; index < 33; index++) response.write('x'.repeat(64 * 1024));
        return response.end('"}');
      }
      if (state.hungManifestBodies.has(bookId)) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"schemaVersion":1');
        return;
      }
      if (state.heldManifests.has(bookId)) {
        const responses = state.manifestResponses.get(bookId) || [];
        responses.push(response);
        state.manifestResponses.set(bookId, responses);
        return;
      }
      const item = getFixture(bookId);
      if (!item.manifest.chapters.length) item.manifest.chapters = [item.descriptor];
      const etag = `"${item.manifest.revision}"`;
      if (request.headers['if-none-match'] === etag) return response.writeHead(304, { ETag: etag }).end();
      response.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
      return response.end(JSON.stringify(item.manifest));
    }
    const postMatch = url.pathname.match(/^\/api\/offline\/preparation\/([^/]+)(?:\/window)?$/);
    if (postMatch && request.method === 'POST') {
      const bookId = decodeURIComponent(postMatch[1]);
      state.posts.push({ bookId, deviceId: request.headers['x-xandrio-device-id'] || '' });
      if (state.heldPosts.has(bookId)) {
        const responses = state.postResponses.get(bookId) || [];
        responses.push(response);
        state.postResponses.set(bookId, responses);
        return;
      }
      response.writeHead(202, { 'Content-Type': 'application/json' });
      return response.end('{}');
    }
    const audioMatch = url.pathname.match(/^\/api\/offline\/audio\/([^/]+)\/0$/);
    if (audioMatch) {
      const bookId = decodeURIComponent(audioMatch[1]);
      const item = getFixture(bookId);
      state.audioRequests.push(bookId);
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      if (!range || request.headers['if-range'] !== item.descriptor.etag) {
        return response.writeHead(409).end();
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), item.bytes.length - 1);
      const body = item.bytes.subarray(start, end + 1);
      response.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': body.length,
        'Content-Range': `bytes ${start}-${end}/${item.bytes.length}`,
        ETag: item.descriptor.etag
      });
      return response.end(body);
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  async function makePage(context, scope, options = {}) {
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(({ scope, quota, usage, probeFailures }) => {
      localStorage.setItem('xandrio_offline_block_writer_v1', 'enabled');
      globalThis.__scope = scope;
      globalThis.__quota = quota;
      globalThis.__usage = usage;
      globalThis.__probeFailures = probeFailures;
    }, {
      scope,
      quota: options.quota ?? 1024 ** 3,
      usage: options.usage ?? 0,
      probeFailures: options.probeFailures ?? 0
    });
    await page.evaluate(async metadataTimeoutMs => {
      const module = await import('/js/features/offline-device.mjs');
      let device;
      const fetchImpl = (input, init = {}) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(new URL(String(input), location.origin), init);
        if (new URL(request.url).pathname.startsWith('/__xandrio_offline__/audio/')) {
          if (globalThis.__probeFailures > 0) {
            globalThis.__probeFailures--;
            return new Response(null, { status: 503 });
          }
          return XandrioOfflineStore.createAudioResponse(request, {
            store: device.store,
            workerVersion: 'test-worker',
            contractVersion: 2
          });
        }
        return fetch(request);
      };
      device = module.createOfflineDeviceCoordinator({
        fetchImpl,
        getScope: () => globalThis.__scope,
        getWorkerState: () => ({ compatible: true, contractVersion: 2 }),
        getRequestHeaders: () => ({ 'X-Xandrio-Device-Id': `device-${globalThis.__scope}` }),
        storageManager: { estimate: async () => ({ quota: globalThis.__quota, usage: globalThis.__usage }) },
        metadataTimeoutMs,
        ownerId: `owner-${globalThis.__scope}-${crypto.randomUUID()}`,
        onSnapshot: snapshot => { globalThis.__snapshot = snapshot; }
      });
      globalThis.__device = device;
      await device.hydrate(globalThis.__scope, {});
    }, options.metadataTimeoutMs ?? 15_000);
    return page;
  }

  const entry = bookId => ({
    bookId,
    title: bookId,
    titleData: { book: { id: bookId, title: bookId }, chapters: [{ text: 'chapter' }] },
    manifestVersion: 3,
    mode: 'full',
    state: 'preparing',
    chapterEntries: [null]
  });

  await test('downloads, verifies, and probes a full title through the block reader', async () => {
    const context = await browser.newContext();
    const page = await makePage(context, 'flow');
    try {
      const result = await page.evaluate(async entry => {
        const completion = __device.startFull(entry.titleData.book, entry.titleData.chapters, entry);
        const ok = await Promise.race([
          completion,
          new Promise((_, reject) => setTimeout(() => reject(new Error('download timeout')), 5000))
        ]);
        const snapshot = __device.snapshot()[entry.bookId];
        const response = await XandrioOfflineStore.createAudioResponse(
          new Request(snapshot.chapterEntries[0].localUrl, { headers: { Range: 'bytes=0-1' } }),
          { store: __device.store, workerVersion: 'test-worker', contractVersion: 2 }
        );
        return { ok, state: snapshot.state, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, entry('flow-book'));
      assert.deepStrictEqual(result, { ok: true, state: 'ready', bytes: [1, 2] });
      assert(state.posts.some(call => call.bookId === 'flow-book' && call.deviceId === 'device-flow'));
    } finally {
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('resumes a durable intent after a cold coordinator relaunch', async () => {
    const context = await browser.newContext();
    state.heldPosts.add('cold-book');
    const first = await makePage(context, 'cold');
    first.evaluate(entry => { globalThis.__firstCompletion = __device.startFull(entry.titleData.book, entry.titleData.chapters, entry); }, entry('cold-book'));
    await waitFor(() => state.posts.some(call => call.bookId === 'cold-book'));
    await first.evaluate(() => __device.close());
    await first.close();
    state.heldPosts.delete('cold-book');
    release(state.postResponses, 'cold-book');

    const second = await makePage(context, 'cold');
    try {
      await second.waitForFunction(() => __device.snapshot()['cold-book']?.state === 'ready', null, { timeout: 5000 });
      assert.strictEqual(await second.evaluate(() => __device.snapshot()['cold-book'].autoResume), false);
      assert(state.posts.filter(call => call.bookId === 'cold-book').length >= 2);
    } finally {
      await second.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('keeps ready audio active during replacement with the same source revision', async () => {
    const context = await browser.newContext();
    const page = await makePage(context, 'replacement');
    try {
      const seed = entry('replacement-book');
      assert.strictEqual(await page.evaluate(async seed => __device.startFull(
        seed.titleData.book, seed.titleData.chapters, seed
      ), seed), true);
      const original = await page.evaluate(() => __device.snapshot()['replacement-book']);
      const replacement = fixture('replacement-book', 'source-v1', 7);
      replacement.manifest.revision = 'descriptor-replacement';
      replacement.manifest.chapters = [replacement.descriptor];
      state.fixtures.set('replacement-book', replacement);
      state.heldManifests.add('replacement-book');
      await page.evaluate(seed => {
        globalThis.__replacementCompletion = __device.startFull(
          seed.titleData.book, seed.titleData.chapters, seed
        );
      }, seed);
      await waitFor(() => state.manifestResponses.has('replacement-book'));
      const staged = await page.evaluate(() => __device.snapshot()['replacement-book']);
      assert.strictEqual(staged.state, 'ready');
      assert.strictEqual(staged.revision, original.revision);
      assert.strictEqual(staged.chapterEntries[0].artifactId, original.chapterEntries[0].artifactId);
      assert.notStrictEqual(staged.replacement.storageRevision, original.revision);
      const readLocal = async localUrl => page.evaluate(async localUrl => {
        const response = await XandrioOfflineStore.createAudioResponse(
          new Request(localUrl, { headers: { Range: 'bytes=0-1' } }),
          { store: __device.store, workerVersion: 'test-worker', contractVersion: 2 }
        );
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, localUrl);
      assert.deepStrictEqual(await readLocal(original.chapterEntries[0].localUrl), { status: 206, bytes: [1, 2] });
      state.heldManifests.delete('replacement-book');
      releaseManifest('replacement-book');
      const replacementResult = await page.evaluate(async () => ({
        completed: await __replacementCompletion,
        snapshot: __device.snapshot()['replacement-book'],
        titles: await __device.store.listTitles('replacement')
      }));
      assert.strictEqual(replacementResult.completed, true, JSON.stringify(replacementResult));
      const completed = await page.evaluate(() => __device.snapshot()['replacement-book']);
      assert.strictEqual(completed.revision, staged.replacement.storageRevision);
      assert.strictEqual(completed.sourceRevision, original.sourceRevision);
      assert.strictEqual(completed.chapterEntries[0].artifactId, replacement.descriptor.artifactId);
      assert.deepStrictEqual(await readLocal(completed.chapterEntries[0].localUrl), { status: 206, bytes: [7, 8] });
    } finally {
      state.heldManifests.delete('replacement-book');
      releaseManifest('replacement-book');
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('retries verified bytes after a transient local playback probe failure', async () => {
    const context = await browser.newContext();
    const page = await makePage(context, 'probe-retry', { probeFailures: 1 });
    try {
      await page.evaluate(seed => {
        globalThis.__probeCompletion = __device.startFull(
          seed.titleData.book, seed.titleData.chapters, seed
        );
      }, entry('probe-retry-book'));
      await page.waitForFunction(() => __device.snapshot()['probe-retry-book']?.state === 'verifying');
      assert.strictEqual(await page.evaluate(() => __device.snapshot()['probe-retry-book'].autoResume), true);
      await page.evaluate(() => __device.wake({ workerCertified: true }));
      assert.strictEqual(await page.evaluate(() => __probeCompletion), true);
      assert.strictEqual(await page.evaluate(() => __device.snapshot()['probe-retry-book'].state), 'ready');
    } finally {
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('times out a stalled descriptor body while retaining resumable intent', async () => {
    const context = await browser.newContext();
    state.hungManifestBodies.add('metadata-timeout-book');
    const page = await makePage(context, 'metadata-timeout', { metadataTimeoutMs: 100 });
    try {
      await page.evaluate(seed => {
        globalThis.__metadataCompletion = __device.startFull(
          seed.titleData.book, seed.titleData.chapters, seed
        );
      }, entry('metadata-timeout-book'));
      await page.waitForFunction(() => __device.snapshot()['metadata-timeout-book']?.state === 'interrupted');
      assert.strictEqual(await page.evaluate(() => __device.snapshot()['metadata-timeout-book'].autoResume), true);
      await page.evaluate(() => __device.pause('metadata-timeout-book'));
      assert.strictEqual(await page.evaluate(() => __metadataCompletion), false);
    } finally {
      state.hungManifestBodies.delete('metadata-timeout-book');
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('rejects chunked metadata over 2 MiB without starting audio transfer', async () => {
    const context = await browser.newContext();
    const bookId = 'oversized-metadata-book';
    state.oversizedManifestBodies.add(bookId);
    const page = await makePage(context, 'oversized-metadata');
    try {
      assert.strictEqual(await page.evaluate(async seed => __device.startFull(
        seed.titleData.book, seed.titleData.chapters, seed
      ), entry(bookId)), false);
      const snapshot = await page.evaluate(bookId => __device.snapshot()[bookId], bookId);
      assert.strictEqual(snapshot.autoResume, false);
      assert.strictEqual(state.audioRequests.includes(bookId), false);
    } finally {
      state.oversizedManifestBodies.delete(bookId);
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('does not let an idle hydrated page retain the dispatcher lease', async () => {
    const context = await browser.newContext();
    const idle = await makePage(context, 'idle-owner');
    const active = await makePage(context, 'idle-owner');
    try {
      const result = await active.evaluate(async entry => Promise.race([
        __device.startFull(entry.titleData.book, entry.titleData.chapters, entry),
        new Promise((_, reject) => setTimeout(() => reject(new Error('idle lease timeout')), 5000))
      ]), entry('idle-owner-book'));
      assert.strictEqual(result, true);
      assert.strictEqual(state.posts.some(call => call.bookId === 'idle-owner-book'), true);
    } finally {
      await idle.evaluate(() => __device.close());
      await active.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('persists a storage reserve stop without fetching audio', async () => {
    const context = await browser.newContext();
    const page = await makePage(context, 'quota', { quota: 15 * 1024 * 1024, usage: 0 });
    try {
      const ok = await page.evaluate(async entry => __device.startFull(
        entry.titleData.book, entry.titleData.chapters, entry
      ), entry('quota-book'));
      assert.strictEqual(ok, false);
      assert.strictEqual(await page.evaluate(() => __device.snapshot()['quota-book'].state), 'storage-error');
      assert.strictEqual(state.audioRequests.includes('quota-book'), false);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(state.audioRequests.includes('quota-book'), false);
      assert.strictEqual(await page.evaluate(() => __device.snapshot()['quota-book'].autoResume), false);
    } finally {
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('does not post from a second tab before it owns the durable lease', async () => {
    const context = await browser.newContext();
    state.heldPosts.add('lease-book');
    const first = await makePage(context, 'lease');
    first.evaluate(entry => { globalThis.__leaseCompletion = __device.startFull(entry.titleData.book, entry.titleData.chapters, entry); }, entry('lease-book'));
    await waitFor(() => state.posts.some(call => call.bookId === 'lease-book'));
    const second = await makePage(context, 'lease');
    try {
      const result = await second.evaluate(async entry => {
        const value = await __device.startFull(entry.titleData.book, entry.titleData.chapters, entry);
        return value;
      }, entry('lease-book'));
      assert.strictEqual(result, false);
      assert.strictEqual(state.posts.filter(call => call.bookId === 'lease-book').length, 1);
    } finally {
      await first.evaluate(() => __device.close());
      state.heldPosts.delete('lease-book');
      release(state.postResponses, 'lease-book');
      await second.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('does not resurrect a deleted title after a delayed descriptor failure', async () => {
    const context = await browser.newContext();
    state.heldManifests.add('delete-book');
    const page = await makePage(context, 'delete');
    try {
      page.evaluate(entry => { globalThis.__deleteCompletion = __device.startFull(entry.titleData.book, entry.titleData.chapters, entry); }, entry('delete-book'));
      await waitFor(() => state.manifestResponses.has('delete-book'));
      await page.evaluate(() => __device.remove('delete-book'));
      state.heldManifests.delete('delete-book');
      release(state.manifestResponses, 'delete-book', 500);
      await new Promise(resolve => setTimeout(resolve, 100));
      const titles = await page.evaluate(() => __device.store.listTitles('delete'));
      assert.deepStrictEqual(titles, {});
      assert.strictEqual(await page.evaluate(() => __device.snapshot()['delete-book']), undefined);
    } finally {
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('keeps a manual pause across relaunch and resumes only on a new action', async () => {
    const context = await browser.newContext();
    state.heldPosts.add('pause-book');
    const first = await makePage(context, 'pause');
    first.evaluate(entry => { globalThis.__pauseCompletion = __device.startFull(entry.titleData.book, entry.titleData.chapters, entry); }, entry('pause-book'));
    await waitFor(() => state.posts.some(call => call.bookId === 'pause-book'));
    await first.evaluate(() => __device.pause('pause-book'));
    assert.deepStrictEqual(
      await first.evaluate(() => {
        const item = __device.snapshot()['pause-book'];
        return { state: item.state, autoResume: item.autoResume, manualPaused: item.manualPaused };
      }),
      { state: 'paused', autoResume: false, manualPaused: true }
    );
    await first.evaluate(() => __device.close());
    await first.close();
    const postCount = state.posts.filter(call => call.bookId === 'pause-book').length;
    const second = await makePage(context, 'pause');
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(state.posts.filter(call => call.bookId === 'pause-book').length, postCount);
      state.heldPosts.delete('pause-book');
      release(state.postResponses, 'pause-book');
      assert.strictEqual(await second.evaluate(async entry => __device.startFull(
        entry.titleData.book, entry.titleData.chapters, __device.snapshot()[entry.bookId]
      ), entry('pause-book')), true);
    } finally {
      await second.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('keeps a pending rolling window incomplete and restores its indexes on relaunch', async () => {
    const rolling = fixture('rolling-book');
    rolling.manifest.state = 'preparing';
    rolling.manifest.readyChapters = 0;
    rolling.manifest.bytesPrepared = 0;
    rolling.manifest.bytesTotal = null;
    rolling.manifest.chapters = [{ index: 0, state: 'preparing' }];
    state.fixtures.set('rolling-book', rolling);
    const context = await browser.newContext();
    const first = await makePage(context, 'rolling');
    first.evaluate(entry => {
      globalThis.__rollingCompletion = __device.startWindow(
        entry.titleData.book,
        entry.titleData.chapters,
        { ...entry, mode: 'rolling', state: 'partial' },
        [0],
        0
      );
    }, entry('rolling-book'));
    await waitFor(() => state.posts.some(call => call.bookId === 'rolling-book'));
    await first.waitForFunction(() => __device.snapshot()['rolling-book']?.state === 'preparing');
    const persisted = await first.evaluate(async () => {
      const item = (await __device.store.listTitles('rolling'))['rolling-book'];
      return { mode: item.mode, windowIndexes: item.windowIndexes, state: item.state };
    });
    assert.deepStrictEqual(persisted, { mode: 'rolling', windowIndexes: [0], state: 'preparing' });
    await first.evaluate(() => __device.close());
    await first.close();

    rolling.manifest.state = 'ready';
    rolling.manifest.readyChapters = 1;
    rolling.manifest.bytesPrepared = rolling.bytes.length;
    rolling.manifest.bytesTotal = rolling.bytes.length;
    rolling.manifest.revision = 'descriptor-source-v1-ready';
    rolling.manifest.chapters = [rolling.descriptor];
    const second = await makePage(context, 'rolling');
    try {
      await second.waitForFunction(() => __device.snapshot()['rolling-book']?.state === 'partial', null, { timeout: 5000 });
      assert.deepStrictEqual(
        await second.evaluate(() => __device.snapshot()['rolling-book'].windowIndexes),
        [0]
      );
    } finally {
      await second.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('retries finalization after a lost lease without stranding verified blocks', async () => {
    const context = await browser.newContext();
    const page = await makePage(context, 'finalize');
    try {
      const result = await page.evaluate(async entry => {
        const original = __device.store.finalizeTitle.bind(__device.store);
        let calls = 0;
        __device.store.finalizeTitle = async (...args) => {
          calls++;
          if (calls === 1) throw new Error('Offline storage fence is stale');
          return original(...args);
        };
        const ok = await Promise.race([
          __device.startFull(entry.titleData.book, entry.titleData.chapters, entry),
          new Promise((_, reject) => setTimeout(() => reject(new Error('finalize retry timeout')), 7000))
        ]);
        return { ok, calls, state: __device.snapshot()[entry.bookId].state };
      }, entry('finalize-book'));
      assert.deepStrictEqual(result, { ok: true, calls: 2, state: 'ready' });
    } finally {
      await page.evaluate(() => __device.close());
      await context.close();
    }
  });

  await test('keeps the old API identity active until its storage fence settles', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    try {
      const result = await page.evaluate(async () => {
        const api = await import('/js/api.js');
        await api.setCurrentUser({ id: 'old-account' });
        let release;
        const fence = new Promise(resolve => { release = resolve; });
        addEventListener('xandrio:authscopechange', event => event.detail.waitUntil(fence), { once: true });
        const transition = api.setCurrentUser({ id: 'new-account' });
        const before = { user: api.getCurrentUser()?.id, scope: api.getOfflineStorageScopeId() };
        release();
        await transition;
        return {
          before,
          after: { user: api.getCurrentUser()?.id, scope: api.getOfflineStorageScopeId() }
        };
      });
      assert.deepStrictEqual(result, {
        before: { user: 'old-account', scope: 'old-account' },
        after: { user: 'new-account', scope: 'new-account' }
      });
    } finally {
      await context.close();
    }
  });

  await browser.close();
  await new Promise(resolve => server.close(resolve));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
