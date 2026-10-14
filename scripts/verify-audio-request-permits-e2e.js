'use strict';

// Failure modes recorded before implementation: cancelled full/Range file
// downloads retain TTS permits; cancelling a cached or generating voice sample
// does the same; cancelled HLS preparation retains its waiter permit; releasing
// on socket close lets unfinished backend work bypass its cap. Use real HTTP
// routes, then verify native browser playback still works.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
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
  // Large enough that the first client read cannot consume the whole response.
  const bytes = Buffer.alloc(44 + 24000 * 2 * 600);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  await fs.writeFile(audioPath, bytes);
  const results = [];
  async function check(name, run) {
    const limiter = createConcurrencyLimitMiddleware({ groups: defaultConcurrencyGroups({ tts: 1, search: 1, hls: 1 }) });
    const app = express(); app.use(express.json()); app.use(limiter);
    let finishBackend;
    let backendStarted = false;
    app.post('/api/search', async (_req, res) => {
      backendStarted = true;
      await new Promise(resolve => { finishBackend = resolve; });
      res.json({ done: true });
    });
    registerPreferencesRoutes(app, {
      availableVoices: [{ id: 'cached' }, { id: 'generated' }], voiceSamplesDir: temp,
      voiceSampleGenerator: async ({ signal }) => {
        backendStarted = true;
        await new Promise((resolve, reject) => {
          finishBackend = resolve;
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        });
      }
    });
    const hls = createHlsAudioStreamer({ serveAudioFile, rootDir: path.join(temp, 'hls'), maintenanceIntervalMs: 0 });
    app.get('/api/audio-hls/book/0/index.m3u8', async (req, res) => {
      await hls.servePlaylist(req, res, {
        key: 'cancelled-playlist', ownerKey: 'fixture', rateKey: 'fixture',
        createSource: async signal => {
          backendStarted = true;
          await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
            if (signal.aborted) reject(new Error('already cancelled'));
          });
        }
      });
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
      const evidence = await run({ origin, limiter, backendStarted: () => backendStarted, finishBackend: () => finishBackend?.() });
      results.push({ name, passed: true, evidence });
    } catch (error) { results.push({ name, passed: false, error: error.message, active: limiter.groups.map(g => ({ name: g.name, active: g.gate.active })) }); }
    finally { finishBackend?.(); await hls.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
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
    await check('disconnect does not release unfinished backend work', async ({ origin, limiter, backendStarted, finishBackend }) => {
      const controller = new AbortController();
      const request = fetch(`${origin}/api/search`, { method: 'POST', signal: controller.signal }).catch(() => {});
      await until(backendStarted); controller.abort(); await request; await sleep(50);
      const blocked = await fetch(`${origin}/api/search`, { method: 'POST' });
      assert.equal(blocked.status, 503); await blocked.text();
      finishBackend(); await until(() => limiter.isIdle());
      return { blockedStatus: blocked.status, idleAfterCompletion: limiter.isIdle() };
    });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  const report = { phase, passed: results.every(r => r.passed), results };
  await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify(report, null, 2));
  for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${JSON.stringify(result.evidence || result.error)}`);
  assert(report.passed, `See ${output}/${phase}.json`);
})().catch(error => { console.error(error); process.exitCode = 1; });
