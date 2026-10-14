'use strict';

// Failure modes recorded before implementation: cancelled full/Range file
// downloads retain TTS permits; cancelling a cached or generating voice sample
// does the same; cancelled HLS preparation retains its waiter permit; releasing
// on socket close lets unfinished backend work bypass its cap. Use real HTTP
// routes, then verify native browser playback still works.
// A catalog entry must not let a requested voice escape the samples directory.
// Uncancellable HLS setup must retain request and session capacity until it ends.
// Mixed ready/preparing sessions must evict a cancellable encoder before new
// admission. A failed initial directory removal must still get its final retry.
// Killing ffmpeg must not free request/session capacity while its input task
// still waits for an uncancellable audio preparation.
// Owner replacement at a full global limit must cancel its old stream; at an
// account limit it must leave another owner's stream alone.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium } = require('playwright');
const { createConcurrencyLimitMiddleware, defaultConcurrencyGroups } = require('../lib/concurrency-limit');
const { registerPlaybackRoutes } = require('../lib/routes/playback-routes');
const { registerPreferencesRoutes } = require('../lib/routes/preferences-routes');
const { serveAudioFile } = require('../lib/audio-response');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');

const output = path.resolve(__dirname, '../output/audio-request-permits');
const phase = process.env.AUDIO_REQUEST_PERMITS_PHASE || 'verified';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  assert(predicate(), 'request permit was not released after backend cleanup');
}
function abortDownload(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume(); reject(new Error(`download returned HTTP ${res.statusCode}`)); return;
      }
      res.once('data', () => { res.destroy(); req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-audio-permits-'));
  const audioPath = path.join(temp, 'cached.mp3');
  const unsafeVoiceId = `../${path.basename(temp)}-outside`;
  const outsidePath = path.resolve(temp, `${unsafeVoiceId}.mp3`);
  // Large enough that the first client read cannot consume the whole response.
  const bytes = Buffer.alloc(44 + 24000 * 2 * 600);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  await fs.writeFile(audioPath, bytes);
  const firstSegmentPath = path.join(temp, 'first-segment.wav');
  const firstSegment = Buffer.from(bytes.subarray(0, 44 + 24000 * 2 * 6));
  firstSegment.writeUInt32LE(firstSegment.length - 8, 4);
  firstSegment.writeUInt32LE(firstSegment.length - 44, 40);
  await fs.writeFile(firstSegmentPath, firstSegment);
  await fs.writeFile(outsidePath, bytes);
  const results = [];
  async function check(name, run, options = {}) {
    const limiter = createConcurrencyLimitMiddleware({ groups: defaultConcurrencyGroups({ tts: 1, search: 1, hls: options.hlsRequests || 1 }) });
    const app = express(); app.use(express.json());
    app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
    app.use(limiter);
    let finishBackend;
    let backendStarted = false;
    const readySourceAborts = new Map();
    let cleanupAttempts = 0;
    let failedCleanupDirectory;
    const originalRemove = fs.rm;
    app.post('/api/search', async (_req, res) => {
      backendStarted = true;
      await new Promise(resolve => { finishBackend = resolve; });
      res.json({ done: true });
    });
    registerPreferencesRoutes(app, {
      availableVoices: [{ id: 'cached' }, { id: 'generated' }, { id: unsafeVoiceId }], voiceSamplesDir: temp,
      voiceSampleGenerator: async ({ signal }) => {
        backendStarted = true;
        await new Promise((resolve, reject) => {
          finishBackend = resolve;
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        });
      }
    });
    const hlsRoot = path.join(temp, 'hls');
    if (options.failInitialCleanup) fs.rm = async (directory, ...args) => {
      if (path.dirname(directory) === hlsRoot) {
        cleanupAttempts++;
        if (cleanupAttempts === 1) {
          failedCleanupDirectory = directory;
          throw Object.assign(new Error('temporary directory removal failure'), { code: 'EBUSY' });
        }
      }
      return originalRemove(directory, ...args);
    };
    const hls = createHlsAudioStreamer({ serveAudioFile, rootDir: hlsRoot, maintenanceIntervalMs: 0, maxActiveSessions: options.hlsSessions || 3, maxActiveSessionsPerAccount: options.hlsAccountSessions || 4 });
    app.get('/api/audio-hls/:book/0/index.m3u8', async (req, res) => {
      try { await hls.servePlaylist(req, res, {
        key: req.params.book, ownerKey: req.query.owner || req.params.book, rateKey: 'fixture',
        createSource: async signal => {
          if (req.params.book === 'held-input') return {
            async *iterateInputs() {
              backendStarted = true;
              await new Promise(resolve => { finishBackend = resolve; });
              yield audioPath;
            }
          };
          if (req.params.book.startsWith('ready')) {
            readySourceAborts.set(req.params.book, false);
            signal.addEventListener('abort', () => { readySourceAborts.set(req.params.book, true); }, { once: true });
            return { async *iterateInputs() {
              if (req.params.book === 'ready-held') {
                yield firstSegmentPath;
                backendStarted = true;
                await new Promise(resolve => { finishBackend = resolve; });
              } else yield audioPath;
            } };
          }
          if (req.params.book === 'overflow') throw new Error('unexpected concurrent setup');
          backendStarted = true;
          await new Promise((resolve, reject) => {
            if (req.params.book === 'held') { finishBackend = resolve; return; }
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
            if (signal.aborted) reject(new Error('already cancelled'));
          });
        }
      }); } catch (error) { if (!res.destroyed) res.status(500).json({ error: error.message }); }
    });
    registerPlaybackRoutes(app, {
      playbackOrchestrator: {
        prepareChapterAudio: async () => ({ path: audioPath }),
        startChapterAudio: async () => ({ ready: true })
      }, serveAudioFile, sendServerError: (res, error) => res.status(500).json({ error: error.message })
    });
    app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><title>Playback after cancelled downloads</title><h1>Playback after cancelled downloads</h1><audio controls src="/api/audio/book/0"></audio>'));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const evidence = await run({ origin, limiter, backendStarted: () => backendStarted, finishBackend: () => finishBackend?.(), readySourceAborted: (book = 'ready') => Boolean(readySourceAborts.get(book)), cleanup: () => ({ attempts: cleanupAttempts, directory: failedCleanupDirectory }) });
      results.push({ name, passed: true, evidence });
    } catch (error) { results.push({ name, passed: false, error: error.message, active: limiter.groups.map(g => ({ name: g.name, active: g.gate.active })) }); }
    finally { fs.rm = originalRemove; finishBackend?.(); await hls.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  try {
    for (const ranged of [false, true]) {
      await check(`${ranged ? 'Range' : 'full'} chapter cancellations preserve preparation and native playback`, async ({ origin, limiter }) => {
        const statuses = [];
        for (let i = 0; i < 12; i++) {
          statuses.push(await abortDownload(`${origin}/api/audio/book/0`, ranged ? { Range: 'bytes=0-' } : {}));
          await until(() => limiter.isIdle());
        }
        const prepared = await fetch(`${origin}/api/chunks/book/0/prepare-chapter-audio`, { method: 'POST' });
        assert.equal(prepared.status, 200); await prepared.text();
        const browser = await chromium.launch();
        const context = await browser.newContext();
        await context.tracing.start({ screenshots: true, snapshots: true });
        let playback;
        try {
          const page = await context.newPage(); await page.goto(`${origin}/fixture`);
          await page.locator('audio').evaluate(audio => audio.play());
          await page.waitForFunction(() => document.querySelector('audio').currentTime > 1);
          playback = await page.locator('audio').evaluate(audio => ({ time: audio.currentTime, paused: audio.paused, error: audio.error?.code || null }));
          assert(!playback.paused && !playback.error);
          await page.screenshot({ path: path.join(output, `${phase}-${ranged ? 'range' : 'full'}.png`) });
          await context.tracing.stop({ path: path.join(output, `${phase}-${ranged ? 'range' : 'full'}-trace.zip`) });
        } finally { await context.close(); await browser.close(); }
        await until(() => limiter.isIdle());
        return { statuses, preparationStatus: prepared.status, playback };
      });
    }
    await check('cached voice sample cancellation releases its permit', async ({ origin, limiter }) => {
      await abortDownload(`${origin}/api/voice-sample/cached`);
      await until(() => limiter.isIdle());
      return { idle: limiter.isIdle() };
    });
    await check('catalog voice identifiers cannot escape the sample directory', async ({ origin }) => {
      const response = await fetch(`${origin}/api/voice-sample/${encodeURIComponent(unsafeVoiceId)}`, { method: 'HEAD' });
      assert.equal(response.status, 400);
      return { status: response.status };
    });
    await check('cancelled voice generation releases after synthesis settles', async ({ origin, limiter, backendStarted }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/voice-sample/generated`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request;
      await until(() => limiter.isIdle());
      return { idle: limiter.isIdle() };
    });
    await check('cancelled HLS playlist preparation releases its request permit', async ({ origin, limiter, backendStarted }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/audio-hls/book/0/index.m3u8`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request;
      await until(() => limiter.isIdle());
      return { idle: limiter.isIdle() };
    });
    await check('cancelled uncancellable HLS setup retains its request permit until completion', async ({ origin, limiter, backendStarted, finishBackend }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/audio-hls/held/0/index.m3u8`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request; await sleep(50);
      assert.equal(limiter.groups.find(group => group.name === 'hls').gate.active, 1);
      const blocked = await fetch(`${origin}/api/audio-hls/overflow/0/index.m3u8`);
      assert.equal(blocked.status, 503); await blocked.text();
      finishBackend(); await until(() => limiter.isIdle());
      return { blockedStatus: blocked.status, idleAfterCompletion: limiter.isIdle() };
    });
    await check('abandoned HLS setup counts toward active-session capacity', async ({ origin, limiter, backendStarted, finishBackend }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/audio-hls/held/0/index.m3u8`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request; await sleep(50);
      const blocked = await fetch(`${origin}/api/audio-hls/overflow/0/index.m3u8`);
      assert.equal(blocked.status, 503); await blocked.text();
      finishBackend(); await until(() => limiter.isIdle());
      return { blockedStatus: blocked.status, idleAfterCompletion: limiter.isIdle() };
    }, { hlsRequests: 2, hlsSessions: 1 });
    await check('mixed account capacity cancels a ready encoder before admitting another source', async ({ origin, limiter, backendStarted, finishBackend, readySourceAborted }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/audio-hls/held/0/index.m3u8`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request; await sleep(50);
      const ready = await fetch(`${origin}/api/audio-hls/ready/0/index.m3u8`);
      assert.equal(ready.status, 200); await ready.text();
      const next = await fetch(`${origin}/api/audio-hls/overflow/0/index.m3u8`);
      await next.text();
      assert(readySourceAborted(), 'new source was admitted without cancelling the account\'s ready encoder');
      assert.equal(next.status, 503, 'replacement was admitted before the cancelled encoder and its input settled');
      let admittedStatus;
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(30);
        const retry = await fetch(`${origin}/api/audio-hls/overflow/0/index.m3u8`);
        admittedStatus = retry.status; await retry.text();
        if (admittedStatus !== 503) break;
      }
      assert.equal(admittedStatus, 500, 'capacity did not return after the prior encoder stopped');
      finishBackend(); await until(() => limiter.isIdle());
      return { readyStatus: ready.status, priorEncoderCancelled: readySourceAborted(), heldDuringCancellation: next.status, admittedAfterCompletion: admittedStatus };
    }, { hlsRequests: 3, hlsSessions: 4, hlsAccountSessions: 2 });
    await check('abandoned source retries directory removal after initial cleanup fails', async ({ origin, limiter, backendStarted, finishBackend, cleanup }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/audio-hls/held/0/index.m3u8`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request;
      await until(() => cleanup().attempts === 1);
      finishBackend(); await until(() => limiter.isIdle());
      assert(cleanup().attempts >= 2, 'final directory removal was skipped');
      await assert.rejects(fs.stat(cleanup().directory), { code: 'ENOENT' });
      return { removalAttempts: cleanup().attempts, directoryRemoved: true };
    }, { failInitialCleanup: true });
    await check('cancelled encoder retains capacity until its uncancellable input task settles', async ({ origin, limiter, backendStarted, finishBackend }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/audio-hls/held-input/0/index.m3u8`, { signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request; await sleep(50);
      assert.equal(limiter.groups.find(group => group.name === 'hls').gate.active, 1, 'request capacity was freed while input preparation still ran');
      const blocked = await fetch(`${origin}/api/audio-hls/overflow/0/index.m3u8`);
      assert.equal(blocked.status, 503); await blocked.text();
      finishBackend(); await until(() => limiter.isIdle());
      return { blockedStatus: blocked.status, idleAfterInputCompletion: limiter.isIdle() };
    }, { hlsRequests: 2, hlsSessions: 1 });
    for (const accountLimit of [false, true]) {
      await check(`owner replacement at full ${accountLimit ? 'account' : 'global'} capacity cancels only its prior stream`, async ({ origin, limiter, readySourceAborted, backendStarted, finishBackend }) => {
        if (accountLimit) {
          const other = await fetch(`${origin}/api/audio-hls/ready-other/0/index.m3u8?owner=other`);
          assert.equal(other.status, 200); await other.text();
        }
        const ownBook = accountLimit ? 'ready-held' : 'ready-own';
        const own = await fetch(`${origin}/api/audio-hls/${ownBook}/0/index.m3u8?owner=shared`);
        assert.equal(own.status, 200); await own.text();
        if (accountLimit) await until(backendStarted);
        const replacementUrl = `${origin}/api/audio-hls/overflow/0/index.m3u8?owner=shared`;
        const replacement = await fetch(replacementUrl);
        assert.equal(replacement.status, 503); await replacement.text();
        assert(readySourceAborted(ownBook), 'capacity rejection did not cancel the replaced stream');
        assert(!readySourceAborted('ready-other'), 'replacement cancelled another owner\'s stream');
        if (accountLimit) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const retry = await fetch(replacementUrl);
            assert.equal(retry.status, 503); await retry.text();
            assert(!readySourceAborted('ready-other'), 'retry cancelled another device while the prior input still ran');
          }
          finishBackend();
        }
        let admittedStatus;
        for (let attempt = 0; attempt < 10; attempt++) {
          await sleep(30);
          const retry = await fetch(replacementUrl);
          admittedStatus = retry.status; await retry.text();
          if (admittedStatus !== 503) break;
        }
        assert.equal(admittedStatus, 500, 'replacement stayed blocked after its prior backend stopped');
        assert(!readySourceAborted('ready-other'), 'retry cancelled another owner\'s stream');
        await until(() => limiter.isIdle());
        return { initialStatus: replacement.status, priorCancelled: true, otherOwnerPreserved: true, admittedAfterCompletion: admittedStatus };
      }, { hlsSessions: accountLimit ? 4 : 1, hlsAccountSessions: accountLimit ? 2 : 4 });
    }
    await check('disconnect does not release unfinished backend work', async ({ origin, limiter, backendStarted, finishBackend }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/search`, { method: 'POST', signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request; await sleep(50);
      const blocked = await fetch(`${origin}/api/search`, { method: 'POST' });
      assert.equal(blocked.status, 503); await blocked.text();
      finishBackend(); await until(() => limiter.isIdle());
      return { blockedStatus: blocked.status, idleAfterCompletion: limiter.isIdle() };
    });
  } finally { await fs.rm(temp, { recursive: true, force: true }); await fs.unlink(outsidePath); }
  const report = { phase, passed: results.every(r => r.passed), results };
  await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify(report, null, 2));
  for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${JSON.stringify(result.evidence || result.error)}`);
  assert(report.passed, `See ${output}/${phase}.json`);
})().catch(error => { console.error(error); process.exitCode = 1; });
