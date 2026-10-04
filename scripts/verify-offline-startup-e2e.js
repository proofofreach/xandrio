// Failure modes specified before implementation: unrelated legacy audio/cover
// migration delays a non-downloaded chapter or an already-scoped download;
// prioritizing Play loses the requested legacy chapter or bypasses account
// ownership; concurrent bulk migration races the requested copy; a failed copy
// deletes the original; an account switch publishes the old account audio;
// deferred migration never finishes its ownership cleanup.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-reliability/offline-audit');
const phase = process.env.OFFLINE_STARTUP_PHASE || 'verification';
const browserName = process.env.OFFLINE_STARTUP_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(browserName));
// WebKit's offline emulation also blocks cache-only worker and blob responses.
// Use a failing audio origin there; retain browser offline mode in Chromium.
const offlineTransportMode = browserName === 'webkit' ? 'audio-origin-unavailable' : 'browser-offline';
function tone() {
  const rate = 24000, count = rate * 3, bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  return bytes;
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const results = [], audioRequests = [];
  let browser, server, audioOriginUnavailable = false;
  const app = express();
  app.get('/fixture-tone.wav', (_req, res) => res.type('audio/wav').send(tone()));
  app.get('/api/audio/:book/:chapter', (req, res) => {
    audioRequests.push({ book: req.params.book, query: req.query });
    if (audioOriginUnavailable) return res.status(503).send('Audio origin deliberately unavailable');
    res.type('audio/wav').send(tone());
  });
  app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><body>
    <h1>Offline startup verification</h1><button id="play">Play</button><audio controls></audio><pre id="result"></pre>
    <script type="module">
      import * as offline from '/js/features/offline.js'; window.offline = offline;
      document.querySelector('#play').onclick = async () => {
        try {
          const began = performance.now();
          const local = await offline.localChapterSource(window.targetBook, 0);
          const elapsedMs = performance.now() - began;
          const audio = document.querySelector('audio');
          window.sourceDecision = { local, elapsedMs };
          if (local.available) { audio.src = local.url; await audio.play(); }
          window.startupResult = window.sourceDecision;
          document.querySelector('#result').textContent = JSON.stringify(window.startupResult, null, 2);
        } catch (error) { window.startupResult = { ...window.sourceDecision, error: error.message }; }
      };
    </script></body></html>`));
  // Optional saved source makes before/after runs repeatable without editing the checkout.
  if (process.env.OFFLINE_STARTUP_SOURCE) app.get('/js/features/offline.js',
    rateLimit({ windowMs: 60_000, limit: 60 }),
    (_req, res) => res.sendFile(path.resolve(process.env.OFFLINE_STARTUP_SOURCE)));
  app.use(express.static(path.join(root, 'public')));
  try {
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await ({ chromium, webkit }[browserName]).launch();
    async function check(name, options, verify) {
      audioOriginUnavailable = false;
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage();
      page.on('console', message => { if (message.type() === 'error') console.error('BROWSER', message.text()); });
      page.on('response', response => { if (response.status() >= 400) console.error('HTTP', response.status(), response.url()); });
      let evidence, originProbeStatus;
      try {
        await page.goto(`${origin}/fixture`); await page.waitForFunction(() => window.offline);
        await page.evaluate(async () => {
          await navigator.serviceWorker.register(offline.OFFLINE_WORKER_SCRIPT_URL);
          await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('service worker install timed out')), 10000))]);
        });
        await page.reload();
        await page.waitForFunction(() => window.offline && navigator.serviceWorker.controller);
        await page.evaluate(async options => {
          localStorage.setItem('xandrio_offline_account_scope', 'offline-owner');
          const audio = await (await fetch('/fixture-tone.wav')).arrayBuffer();
          const response = () => new Response(audio.slice(0), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(audio.byteLength) } });
          const entry = id => ({ bookId: id, manifestVersion: 2, mode: 'full', state: 'ready', chapterEntries: [{ size: audio.byteLength, bodyVerificationVersion: 1 }] });
          const manifest = { unrelated: entry('unrelated'), downloaded: entry('downloaded') };
          localStorage.setItem('xandrio_offline_books:offline-owner', JSON.stringify(manifest));
          localStorage.setItem('xandrio_offline_legacy_cache_owner', options.otherOwner ? 'other-account' : 'offline-owner');
          const legacy = await caches.open(offline.OFFLINE_AUDIO_CACHE);
          await legacy.put('/api/audio/unrelated/0', response());
          if (options.scoped) {
            const scoped = await caches.open(offline.OFFLINE_AUDIO_CACHE + ':offline-owner');
            await scoped.put('/api/audio/downloaded/0?xandrio-offline-scope=offline-owner', response());
          } else await legacy.put('/api/audio/downloaded/0', response());
          const covers = await caches.open(offline.OFFLINE_TITLE_CACHE);
          await covers.put('/api/cover/unrelated', new Response('cover'));
          window.migrationWrites = [];
          const originalPut = Cache.prototype.put;
          Cache.prototype.put = async function(request, response) {
            const url = new URL(typeof request === 'string' ? request : request.url, location.origin);
            if (url.searchParams.has('xandrio-offline-scope')) {
              window.migrationWrites.push(url.pathname);
              if (url.pathname.includes('/unrelated')) {
                window.unrelatedWriteStarted = true;
                await new Promise(resolve => setTimeout(resolve, 900));
              }
              if (options.switchAccount && url.pathname === '/api/audio/downloaded/0') {
                const api = await import('/js/api.js');
                await api.setCurrentUser({ id: 'other-account' });
              }
              if (options.failCopy && url.pathname === '/api/audio/downloaded/0') throw new DOMException('fixture quota failure', 'QuotaExceededError');
            }
            return originalPut.call(this, request, response);
          };
          window.restorePut = () => { Cache.prototype.put = originalPut; };
          window.targetBook = options.missing ? 'not-downloaded' : 'downloaded';
          if (options.concurrent) window.backgroundMigration = offline.prepareOfflineStorage({ waitForAudio: true });
        }, options);
        if (options.concurrent) await page.waitForFunction(() => window.unrelatedWriteStarted);
        if (options.offline) {
          if (offlineTransportMode === 'audio-origin-unavailable') {
            audioOriginUnavailable = true;
            // Probe from Node so the browser's service worker cannot intercept it.
            const probe = await fetch(`${origin}/api/audio/downloaded/0?xandrio-offline-scope=offline-owner`);
            originProbeStatus = probe.status;
            await probe.arrayBuffer();
            assert.equal(originProbeStatus, 503, 'Audio origin must fail before cached playback');
          } else await context.setOffline(true);
        }
        const requestCount = audioRequests.length;
        if (options.availability) {
          evidence = await page.evaluate(async () => {
            const began = performance.now(); const available = await offline.isChapterAvailableOffline(window.targetBook, 0);
            return { available, elapsedMs: performance.now() - began };
          });
        } else {
          await page.locator('#play').click();
          await page.waitForFunction(() => window.startupResult, { timeout: 15000 });
          evidence = await page.evaluate(() => window.startupResult);
          if (evidence.local?.available && !evidence.error) {
            await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.05);
            evidence.playhead = await page.locator('audio').evaluate(audio => audio.currentTime);
            if (options.offline && offlineTransportMode === 'audio-origin-unavailable') {
              evidence.cacheResponses = await page.evaluate(async url => {
                const responses = [];
                for (const range of [null, 'bytes=0-1023']) {
                  const response = await fetch(url, { headers: range ? { Range: range } : {} });
                  const bytes = new Uint8Array(await response.arrayBuffer());
                  responses.push({ range, status: response.status, bytes: bytes.byteLength,
                    contentType: response.headers.get('Content-Type'),
                    contentRange: response.headers.get('Content-Range'),
                    cache: response.headers.get('X-Xandrio-Offline-Cache'),
                    signature: String.fromCharCode(...bytes.slice(0, 4)) });
                }
                return responses;
              }, evidence.local.url);
            }
          }
        }
        evidence.transportMode = options.offline ? offlineTransportMode : 'online';
        if (originProbeStatus !== undefined) evidence.originProbeStatus = originProbeStatus;
        Object.assign(evidence, await page.evaluate(async () => ({
          writes: [...window.migrationWrites],
          owner: localStorage.getItem('xandrio_offline_legacy_cache_owner'),
          manifestChapterPresent: Boolean(JSON.parse(localStorage.getItem('xandrio_offline_books:offline-owner') || '{}').downloaded?.chapterEntries?.[0]),
          legacyDownloadedPresent: Boolean(await (await caches.open(offline.OFFLINE_AUDIO_CACHE)).match('/api/audio/downloaded/0')),
          scopedDownloadedPresent: Boolean(await (await caches.open(offline.OFFLINE_AUDIO_CACHE + ':offline-owner')).match('/api/audio/downloaded/0?xandrio-offline-scope=offline-owner')),
          legacyUnrelatedPresent: Boolean(await (await caches.open(offline.OFFLINE_AUDIO_CACHE)).match('/api/audio/unrelated/0'))
        })));
        evidence.networkAudioRequests = audioRequests.slice(requestCount);
        if (options.offline && offlineTransportMode === 'audio-origin-unavailable') {
          assert.equal(evidence.originProbeStatus, 503);
          assert.deepEqual(evidence.networkAudioRequests, [], 'Cached playback must not contact the failing audio origin');
          if (evidence.local?.available && !evidence.error) {
            const bytes = tone().length;
            assert.deepEqual(evidence.cacheResponses, [
              { range: null, status: 200, bytes, contentType: 'audio/wav', contentRange: null, cache: 'hit', signature: 'RIFF' },
              { range: 'bytes=0-1023', status: 206, bytes: 1024, contentType: 'audio/wav', contentRange: `bytes 0-1023/${bytes}`, cache: 'hit', signature: 'RIFF' }
            ]);
          }
        }
        if (options.finishMigration) {
          evidence.cleanup = await page.evaluate(async () => {
            window.restorePut();
            await (window.backgroundMigration || offline.prepareOfflineStorage({ waitForAudio: true }));
            return { owner: localStorage.getItem('xandrio_offline_legacy_cache_owner'),
              remainingAudio: (await (await caches.open(offline.OFFLINE_AUDIO_CACHE)).keys()).length,
              remainingCovers: (await (await caches.open(offline.OFFLINE_TITLE_CACHE)).keys()).length };
          });
        }
        verify(evidence);
        results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`);
      } catch (error) {
        results.push({ name, passed: false, error: error.message, evidence }); console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        await page.screenshot({ path: path.join(output, `${phase}-${browserName}-${name}.png`) }).catch(() => {});
        await context.tracing.stop({ path: path.join(output, `${phase}-${browserName}-${name}.zip`) });
        await context.close();
      }
    }
    const quick = e => assert(e.elapsedMs < 500, `source decision took ${e.elapsedMs} ms; ${JSON.stringify(e)}`);
    const playable = e => { assert.equal(e.error, undefined, JSON.stringify(e)); assert.equal(e.local?.available, true, JSON.stringify(e)); assert(e.playhead > 0); assert.deepEqual(e.networkAudioRequests, []); };
    await check('missing-download', { missing: true }, e => { quick(e); assert.equal(e.local?.reason, 'not-downloaded'); });
    await check('scoped-download-offline', { scoped: true, offline: true }, e => { quick(e); playable(e); });
    await check('legacy-download-offline', { offline: true, finishMigration: true }, e => {
      quick(e); playable(e); assert(e.scopedDownloadedPresent); assert.equal(e.legacyDownloadedPresent, false);
      assert.equal(e.owner, 'offline-owner'); assert(e.legacyUnrelatedPresent);
      assert.deepEqual(e.cleanup, { owner: null, remainingAudio: 0, remainingCovers: 0 });
    });
    await check('legacy-during-bulk-migration', { concurrent: true, offline: true, finishMigration: true }, e => {
      quick(e); playable(e); assert.deepEqual(e.cleanup, { owner: null, remainingAudio: 0, remainingCovers: 0 });
    });
    await check('other-account-legacy', { otherOwner: true, offline: true }, e => {
      assert.equal(e.local?.available, false); assert(e.legacyDownloadedPresent); assert.equal(e.scopedDownloadedPresent, false);
    });
    await check('account-switch-during-copy', { switchAccount: true }, e => {
      assert.equal(e.local?.available, false, JSON.stringify(e)); assert.deepEqual(e.networkAudioRequests, []);
    });
    await check('failed-copy-preserves-original', { failCopy: true }, e => {
      assert.equal(e.local?.available, false); assert(e.legacyDownloadedPresent); assert.equal(e.scopedDownloadedPresent, false); assert.equal(e.owner, 'offline-owner');
    });
    await check('availability-failed-copy-preserves-metadata', { failCopy: true, availability: true }, e => {
      assert.equal(e.available, false); assert(e.legacyDownloadedPresent); assert(e.manifestChapterPresent, 'Storage failure erased metadata for valid legacy audio');
    });
    await check('availability-missing-download', { missing: true, availability: true }, e => { quick(e); assert.equal(e.available, false); });
    await check('availability-legacy-download', { availability: true }, e => { quick(e); assert.equal(e.available, true); });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const report = { phase, browser: browserName, offlineTransportMode, generatedAt: new Date().toISOString(), results };
    await fs.writeFile(path.join(output, `${phase}-${browserName}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
