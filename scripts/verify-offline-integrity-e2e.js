// Failure modes specified before implementation: an account switch lets an
// in-flight legacy CacheStorage writer publish old-account bytes into the new
// account manifest; a self-consistent 206 response is saved as a whole chapter;
// quota failure leaves ready metadata without bytes; cancellation or removal
// permits a late cache/manifest write; a truncated body is accepted; a transient
// response cannot recover on retry; stale progress survives removal; a pending
// position queued during flush is overwritten; an unacknowledged position is
// removed from durable storage; an old account position is sent through the
// next account's authenticated session; a failed scope fence is hidden.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/deep-reliability/offline');
const phase = process.env.OFFLINE_INTEGRITY_PHASE || 'verification';
const fullBody = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x15xandrio-offline-integrity-audio');
const partialBody = fullBody.subarray(0, 12);
const sha = body => `sha256-${crypto.createHash('sha256').update(body).digest('hex')}`;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const results = [];
  const requestCounts = new Map();
  const gates = new Map();
  const positionRequests = [];
  let browser;
  let server;

  const app = express();
  app.use(express.json());
  app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><body>
    <div id="offline-books-list"></div><div id="offline-banner" hidden></div>
    <span id="player-voice-name">Integrity voice</span>
    <script type="module">
      import * as offline from '/js/features/offline.js';
      import * as api from '/js/api.js';
      window.offline = offline;
      window.api = api;
      window.activity = [];
      document.addEventListener('xandrio:downloadactivity', event => {
        window.activity.push(structuredClone(event.detail?.downloads || []));
      });
      window.startFixture = async scope => {
        await api.setCurrentUser({ id: scope });
        offline.initOffline({
          getCurrentBook: () => null,
          getChapters: () => [],
          showAudioLoading() {},
          hideAudioLoading() {}
        });
        await offline.prepareOfflineStorage();
      };
      window.book = id => ({ id, title: id, author: 'Fixture', hasCover: false });
      window.chapters = [{}];
    </script>
  </body></html>`));
  app.get('/api/offline/preparation/:bookId', (req, res) => {
    res.json({
      state: 'ready',
      totalChapters: 1,
      readyChapters: 1,
      bytesPrepared: fullBody.length,
      bytesTotal: fullBody.length,
      percent: 100,
      packageVariantKey: 'fixture:offline-mp3-v1:br48k',
      bitrateKbps: 48
    });
  });
  app.get('/api/offline/deletions', (_req, res) => res.json({ revision: 0, deletions: [] }));
  app.post('/api/position', async (req, res) => {
    positionRequests.push(structuredClone(req.body));
    if (req.body?.bookId === 'race-first') await gates.get('position-race')?.promise;
    if (req.body?.bookId === 'durability-first') await gates.get('position-durability')?.promise;
    res.json({ success: true });
  });
  app.get('/api/offline/audio/:bookId/:chapter', async (req, res) => {
    const id = req.params.bookId;
    requestCounts.set(id, (requestCounts.get(id) || 0) + 1);
    if (id === 'retry' && requestCounts.get(id) === 1) return res.status(503).send('retry');
    if (id === 'switching' || id === 'remove-active') await gates.get(id)?.promise;
    if (id === 'partial') {
      return res.status(206).set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(partialBody.length),
        'Content-Range': `bytes 0-${partialBody.length - 1}/${fullBody.length}`,
        'Accept-Ranges': 'bytes',
        'ETag': `"${sha(partialBody)}"`,
        'X-Xandrio-Content-SHA256': sha(partialBody)
      }).send(partialBody);
    }
    if (id === 'truncated') {
      res.status(200).set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(fullBody.length + 9),
        'ETag': `"${sha(fullBody)}"`,
        'X-Xandrio-Content-SHA256': sha(fullBody)
      });
      return res.end(fullBody);
    }
    return res.status(200).set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(fullBody.length),
      'ETag': `"${sha(fullBody)}"`,
      'X-Xandrio-Content-SHA256': sha(fullBody)
    }).send(fullBody);
  });
  app.use(express.static(path.join(root, 'public')));

  try {
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('console', message => {
      if (message.type() === 'error') console.error('BROWSER', message.text());
    });
    await page.goto(`${origin}/fixture`);
    await page.waitForFunction(() => window.offline && window.api);
    await page.evaluate(() => startFixture('old-account'));

    async function check(name, action) {
      let evidence;
      try {
        evidence = await action();
        results.push({ name, passed: true, evidence });
        console.log(`PASS ${name}`);
      } catch (error) {
        results.push({ name, passed: false, error: error.message, evidence: error.evidence });
        console.error(`FAIL ${name}: ${error.message}`);
      }
    }

    await check('account-switch-fences-active-cache-writer', async () => {
      gates.set('switching', deferred());
      await page.evaluate(() => {
        window.switchingDownload = offline.downloadBookForOffline(book('switching'), chapters, {
          confirmForeground: false
        });
      });
      await waitFor(() => requestCounts.get('switching') === 1, 'switching audio request');
      await page.evaluate(() => {
        window.scopeSwitch = api.setCurrentUser({ id: 'new-account' });
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      gates.get('switching').resolve();
      const evidence = await page.evaluate(async () => {
        await window.scopeSwitch;
        const completed = await window.switchingDownload;
        const oldManifest = JSON.parse(localStorage.getItem('xandrio_offline_books:old-account') || '{}');
        const newManifest = JSON.parse(localStorage.getItem('xandrio_offline_books:new-account') || '{}');
        const cacheNames = await caches.keys();
        const oldCache = await caches.open('xandrio-offline-audio:old-account');
        const newCache = await caches.open('xandrio-offline-audio:new-account');
        return {
          completed,
          currentScope: api.getOfflineStorageScopeId(),
          oldState: oldManifest.switching?.state || null,
          newState: newManifest.switching?.state || null,
          oldCacheEntries: (await oldCache.keys()).map(request => request.url),
          newCacheEntries: (await newCache.keys()).map(request => request.url),
          cacheNames
        };
      });
      try {
        assert.equal(evidence.currentScope, 'new-account');
        assert.equal(evidence.completed, false, 'the old-account transfer must be cancelled');
        assert.equal(evidence.newState, null, 'old-account metadata must not enter the new account');
        assert.notEqual(evidence.oldState, 'ready');
        assert.deepEqual(evidence.newCacheEntries, []);
      } catch (error) { error.evidence = evidence; throw error; }
      return evidence;
    });

    await check('rejects-partial-response-as-complete-chapter', async () => {
      const evidence = await page.evaluate(async () => {
        const completed = await offline.downloadBookForOffline(book('partial'), chapters, {
          confirmForeground: false
        });
        const manifest = JSON.parse(localStorage.getItem('xandrio_offline_books:new-account') || '{}');
        const cache = await caches.open('xandrio-offline-audio:new-account');
        const entries = (await cache.keys()).filter(request => new URL(request.url).pathname === '/api/audio/partial/0');
        return {
          completed,
          state: manifest.partial?.state || null,
          chapter: manifest.partial?.chapterEntries?.[0] || null,
          cachedEntries: entries.map(request => request.url)
        };
      });
      try {
        assert.equal(evidence.completed, false);
        assert.equal(evidence.chapter, null);
        assert.notEqual(evidence.state, 'ready');
        assert.deepEqual(evidence.cachedEntries, []);
      } catch (error) { error.evidence = evidence; throw error; }
      return evidence;
    });

    await check('quota-failure-does-not-publish-ready-metadata', async () => {
      const evidence = await page.evaluate(async () => {
        const originalPut = Cache.prototype.put;
        Cache.prototype.put = async function(request, response) {
          const url = new URL(typeof request === 'string' ? request : request.url, location.origin);
          if (url.pathname === '/api/audio/quota/0') throw new DOMException('fixture quota', 'QuotaExceededError');
          return originalPut.call(this, request, response);
        };
        try {
          const completed = await offline.downloadBookForOffline(book('quota'), chapters, { confirmForeground: false });
          const manifest = JSON.parse(localStorage.getItem('xandrio_offline_books:new-account') || '{}');
          const cache = await caches.open('xandrio-offline-audio:new-account');
          return {
            completed,
            state: manifest.quota?.state || null,
            chapter: manifest.quota?.chapterEntries?.[0] || null,
            cached: Boolean(await cache.match('/api/audio/quota/0?xandrio-offline-scope=new-account'))
          };
        } finally {
          Cache.prototype.put = originalPut;
        }
      });
      assert.equal(evidence.completed, false);
      assert.equal(evidence.chapter, null);
      assert.notEqual(evidence.state, 'ready');
      assert.equal(evidence.cached, false);
      return evidence;
    });

    await check('truncated-body-does-not-publish-ready-metadata', async () => {
      const evidence = await page.evaluate(async () => {
        const completed = await offline.downloadBookForOffline(book('truncated'), chapters, { confirmForeground: false });
        const manifest = JSON.parse(localStorage.getItem('xandrio_offline_books:new-account') || '{}');
        return {
          completed,
          state: manifest.truncated?.state || null,
          chapter: manifest.truncated?.chapterEntries?.[0] || null
        };
      });
      assert.equal(evidence.completed, false);
      assert.equal(evidence.chapter, null);
      assert.notEqual(evidence.state, 'ready');
      return evidence;
    });

    await check('transient-response-recovers-with-bounded-retry', async () => {
      const evidence = await page.evaluate(async () => {
        const completed = await offline.downloadBookForOffline(book('retry'), chapters, { confirmForeground: false });
        const manifest = JSON.parse(localStorage.getItem('xandrio_offline_books:new-account') || '{}');
        return {
          completed,
          state: manifest.retry?.state || null,
          chapterSize: manifest.retry?.chapterEntries?.[0]?.size || 0
        };
      });
      evidence.requests = requestCounts.get('retry') || 0;
      assert.equal(evidence.completed, true);
      assert.equal(evidence.chapterSize, fullBody.length);
      assert.equal(evidence.requests, 2);
      return evidence;
    });

    await check('removal-wins-over-active-download-and-clears-progress', async () => {
      gates.set('remove-active', deferred());
      await page.evaluate(() => {
        window.removalDownload = offline.downloadBookForOffline(book('remove-active'), chapters, {
          confirmForeground: false
        });
      });
      await waitFor(() => requestCounts.get('remove-active') === 1, 'removal audio request');
      await page.evaluate(() => {
        window.removal = offline.removeOfflineBook('remove-active');
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      gates.get('remove-active').resolve();
      const evidence = await page.evaluate(async () => {
        const [completed, removal] = await Promise.all([window.removalDownload, window.removal]);
        const manifest = JSON.parse(localStorage.getItem('xandrio_offline_books:new-account') || '{}');
        const cache = await caches.open('xandrio-offline-audio:new-account');
        const cached = (await cache.keys()).filter(request => new URL(request.url).pathname === '/api/audio/remove-active/0');
        return {
          completed,
          removal,
          manifestPresent: Boolean(manifest['remove-active']),
          cachedEntries: cached.map(request => request.url),
          lastActivity: window.activity.at(-1) || []
        };
      });
      assert.equal(evidence.completed, false);
      assert.equal(evidence.manifestPresent, false);
      assert.deepEqual(evidence.cachedEntries, []);
      assert.deepEqual(evidence.lastActivity, []);
      return evidence;
    });

    await check('position-enqueued-during-flush-is-retained', async () => {
      gates.set('position-race', deferred());
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('xandrio_pending_positions')) localStorage.removeItem(key);
        }
        offline.queuePendingPosition({
          bookId: 'race-first', chapterIndex: 0, timestamp: 1,
          userId: api.getOfflineStorageScopeId(), deviceId: 'fixture-device'
        });
        window.positionFlush = offline.flushPendingPositions();
      });
      await waitFor(
        () => positionRequests.some(request => request.bookId === 'race-first'),
        'first pending position request'
      );
      await page.evaluate(() => offline.queuePendingPosition({
        bookId: 'race-second', chapterIndex: 0, timestamp: 2,
        userId: api.getOfflineStorageScopeId(), deviceId: 'fixture-device'
      }));
      gates.get('position-race').resolve();
      const evidence = await page.evaluate(async () => {
        await window.positionFlush;
        const values = [];
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('xandrio_pending_positions')) {
            values.push(...JSON.parse(localStorage.getItem(key) || '[]'));
          }
        }
        return { pendingBookIds: values.map(item => item.bookId) };
      });
      assert.deepEqual(evidence.pendingBookIds, ['race-second']);
      return evidence;
    });

    await check('unacknowledged-position-remains-durable', async () => {
      gates.set('position-durability', deferred());
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('xandrio_pending_positions')) localStorage.removeItem(key);
        }
        offline.queuePendingPosition({
          bookId: 'durability-first', chapterIndex: 0, timestamp: 4,
          userId: api.getOfflineStorageScopeId(), deviceId: 'fixture-device'
        });
        window.durablePositionFlush = offline.flushPendingPositions();
      });
      await waitFor(
        () => positionRequests.some(request => request.bookId === 'durability-first'),
        'unacknowledged pending position request'
      );
      const during = await page.evaluate(() => {
        const key = `xandrio_pending_positions:${api.getOfflineStorageScopeId()}`;
        return JSON.parse(localStorage.getItem(key) || '[]').map(item => item.bookId);
      });
      gates.get('position-durability').resolve();
      const after = await page.evaluate(async () => {
        await window.durablePositionFlush;
        const key = `xandrio_pending_positions:${api.getOfflineStorageScopeId()}`;
        return JSON.parse(localStorage.getItem(key) || '[]').map(item => item.bookId);
      });
      const evidence = { during, after };
      try {
        assert.deepEqual(during, ['durability-first']);
        assert.deepEqual(after, []);
      } catch (error) { error.evidence = evidence; throw error; }
      return evidence;
    });

    await check('old-account-position-is-not-replayed-after-switch', async () => {
      const before = positionRequests.length;
      const evidence = await page.evaluate(async () => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('xandrio_pending_positions')) localStorage.removeItem(key);
        }
        await api.setCurrentUser({ id: 'queue-owner' });
        offline.queuePendingPosition({
          bookId: 'old-account-position', chapterIndex: 0, timestamp: 3,
          userId: 'queue-owner', deviceId: 'fixture-device'
        });
        await api.setCurrentUser({ id: 'queue-new-owner' });
        await offline.flushPendingPositions();
        const keys = Object.keys(localStorage).filter(key => key.startsWith('xandrio_pending_positions'));
        return {
          scope: api.getOfflineStorageScopeId(),
          queues: Object.fromEntries(keys.map(key => [key, JSON.parse(localStorage.getItem(key) || '[]')]))
        };
      });
      evidence.sent = positionRequests.slice(before).map(request => request.bookId);
      assert.equal(evidence.scope, 'queue-new-owner');
      assert.deepEqual(evidence.sent, []);
      assert(Object.values(evidence.queues).flat().some(item => item.bookId === 'old-account-position'));
      return evidence;
    });

    await check('pending-position-keeps-captured-owner-after-switch', async () => {
      const before = positionRequests.length;
      const evidence = await page.evaluate(async () => {
        const owner = api.getOfflineStorageScopeId();
        await api.setCurrentUser({ id: 'later-account' });
        offline.queuePendingPosition({
          bookId: 'delayed-old-owner', chapterIndex: 0, timestamp: 5,
          userId: owner, deviceId: 'fixture-device'
        }, owner);
        await offline.flushPendingPositions();
        const oldQueue = JSON.parse(localStorage.getItem(`xandrio_pending_positions:${owner}`) || '[]');
        const newQueue = JSON.parse(localStorage.getItem('xandrio_pending_positions:later-account') || '[]');
        return { owner, current: api.getOfflineStorageScopeId(), oldQueue, newQueue };
      });
      evidence.sent = positionRequests.slice(before).map(request => request.bookId);
      assert.equal(evidence.current, 'later-account');
      assert(evidence.oldQueue.some(item => item.bookId === 'delayed-old-owner'));
      assert.deepEqual(evidence.newQueue, []);
      assert.deepEqual(evidence.sent, []);
      return evidence;
    });

    await check('remembered-offline-scope-queues-position-with-local-sync-id', async () => {
      const before = positionRequests.length;
      const evidence = await page.evaluate(async () => {
        await api.setCurrentUser(null);
        const owner = api.getOfflineStorageScopeId();
        const syncId = api.getCurrentUserId();
        offline.queuePendingPosition({
          bookId: 'remembered-scope-position', chapterIndex: 0, timestamp: 6,
          userId: syncId, deviceId: 'fixture-device'
        }, owner);
        await offline.flushPendingPositions();
        const queue = JSON.parse(localStorage.getItem(`xandrio_pending_positions:${owner}`) || '[]');
        return { owner, syncId, queue };
      });
      evidence.sent = positionRequests.slice(before).map(request => request.bookId);
      assert.notEqual(evidence.owner, evidence.syncId);
      assert.deepEqual(evidence.queue, []);
      assert.deepEqual(evidence.sent, ['remembered-scope-position']);
      return evidence;
    });

    await check('legacy-position-migrates-when-scoped-queue-already-exists', async () => {
      const before = positionRequests.length;
      const evidence = await page.evaluate(async () => {
        const owner = api.getOfflineStorageScopeId();
        offline.queuePendingPosition({
          bookId: 'scoped-existing', chapterIndex: 0, timestamp: 7,
          userId: owner, deviceId: 'fixture-device'
        }, owner);
        localStorage.setItem('xandrio_pending_positions', JSON.stringify([{
          bookId: 'legacy-late', chapterIndex: 0, timestamp: 8,
          userId: owner, deviceId: 'fixture-device'
        }]));
        await offline.flushPendingPositions();
        return {
          queue: JSON.parse(localStorage.getItem(`xandrio_pending_positions:${owner}`) || '[]'),
          legacy: JSON.parse(localStorage.getItem('xandrio_pending_positions') || '[]')
        };
      });
      evidence.sent = positionRequests.slice(before).map(request => request.bookId);
      assert.deepEqual(evidence.queue, []);
      assert.deepEqual(evidence.legacy, []);
      assert.deepEqual(evidence.sent, ['scoped-existing', 'legacy-late']);
      return evidence;
    });

    await check('failed-scope-fence-rejects-identity-change', async () => {
      const evidence = await page.evaluate(async () => {
        const before = api.getOfflineStorageScopeId();
        const originalTransaction = IDBDatabase.prototype.transaction;
        let injected = false;
        IDBDatabase.prototype.transaction = function(storeNames, mode, options) {
          if (!injected && mode === 'readwrite' &&
              Array.from(typeof storeNames === 'string' ? [storeNames] : storeNames).join(',') === 'control') {
            injected = true;
            throw new DOMException('fixture scope fence failure', 'UnknownError');
          }
          return originalTransaction.call(this, storeNames, mode, options);
        };
        let rejected = false;
        try {
          await api.setCurrentUser({ id: 'fence-failure-account' });
        } catch {
          rejected = true;
        } finally {
          IDBDatabase.prototype.transaction = originalTransaction;
        }
        return { before, after: api.getOfflineStorageScopeId(), rejected, injected };
      });
      assert.equal(evidence.injected, true);
      assert.equal(evidence.rejected, true);
      assert.equal(evidence.after, evidence.before);
      return evidence;
    });

    await page.screenshot({ path: path.join(output, `${phase}-chromium.png`), fullPage: true });
    await context.tracing.stop({ path: path.join(output, `${phase}-chromium.zip`) });
    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
    const report = {
      phase,
      generatedAt: new Date().toISOString(),
      passed: results.every(result => result.passed),
      results
    };
    await fs.writeFile(path.join(output, `${phase}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Evidence: ${path.join(output, `${phase}.json`)}`);
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
