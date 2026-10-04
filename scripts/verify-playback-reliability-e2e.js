// Failure modes covered before the fix: readiness counts noncontiguous clips;
// resume prepares the chapter beginning; an unrelated clip error blocks audio;
// next-chapter work delays Play; a redundant voice probe or preparation request
// hangs forever; transient HTTP failures abort playback; a retry changes voice;
// cancellation leaves a request alive or publishes stale audio.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium, webkit } = require('playwright');
const ChunkedTTS = require('../lib/chunked-tts');
const { createPlaybackOrchestrator } = require('../lib/playback-orchestrator');
const { registerPlaybackRoutes } = require('../lib/routes/playback-routes');
const { createChapterAudioStreamer } = require('../lib/chapter-audio-stream');
const { createHlsAudioStreamer } = require('../lib/hls-audio-stream');
const { serveAudioFile } = require('../lib/audio-response');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-reliability');
const phase = process.env.PLAYBACK_RELIABILITY_PHASE || 'verification';
const browserName = process.env.PLAYBACK_RELIABILITY_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(browserName));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tone(seconds = 8) {
  const rate = 24000, samples = rate * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return bytes;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-playback-reliability-'));
  const results = [], requests = [], preparations = [], priorities = [], claims = [];
  let server, browser, context, hls;
  const tts = new ChunkedTTS(temp, null, { outputFormatProvider: () => 'wav' });
  const chapter = { text: 'An independently controlled narration clip. '.repeat(60), estimatedDuration: 48 };
  const chapters = [chapter, chapter];
  let nextChapterDelay = 0, horizonDelay = 0;
  async function fixture(bookId, statuses) {
    const chunks = await Promise.all(statuses.map(async (status, index) => {
      const file = tts.chunkPath(bookId, 0, index);
      await fs.writeFile(file, tone());
      return { index, status, duration: 8, textLength: 100, path: file };
    }));
    tts.manifests.set(tts._manifestKey(bookId, 0), {
      bookId, chapterIndex: 0, totalChunks: chunks.length, textLength: chunks.length * 100, chunks
    });
  }
  const originalPrioritize = tts.prioritizeChunk.bind(tts);
  tts.prioritizeChunk = (bookId, chapterIndex, chunkIndex, priority) => {
    priorities.push({ bookId, chapterIndex, chunkIndex, priority });
    return originalPrioritize(bookId, chapterIndex, chunkIndex, priority);
  };
  const originalClaim = tts.claimChapter.bind(tts);
  tts.claimChapter = (...args) => { claims.push({ bookId: args[0], ...args[3] && { priority: args[3] }, ...args[4] }); return originalClaim(...args); };
  async function inspectChapterAudio(bookId, chapterIndex, options = {}) {
    if (bookId === 'voice-scoped' && options.tts !== tts) return { ready: true, status: 'ready' };
    if (chapterIndex > 0) await sleep(nextChapterDelay);
    const chunks = tts.getChapterManifest(bookId, chapterIndex)?.chunks || [];
    const readyChunks = chunks.filter(chunk => chunk.status === 'ready').length;
    const errorChunks = chunks.filter(chunk => chunk.status === 'error').length;
    return { ready: false, status: errorChunks ? 'error' : 'generating', readyChunks, errorChunks, totalChunks: chunks.length };
  }
  const orchestrator = createPlaybackOrchestrator({
    resolveNarrationContext: async bookId => ({
      tier: 'active', servedTier: bookId === 'voice-scoped' ? 'premium' : null,
      ...(bookId === 'voice-scoped' ? { actualVoiceId: 'fixture-voice' } : {}), tts, voice: 'fixture'
    }),
    isPremiumVoiceActive: () => false,
    ttsForTier: () => tts, voiceForTier: () => 'fixture',
    getChapterContext: async (_book, index) => ({ book: { language: 'en' }, chapter: chapters[index], chapters }),
    manifestNeedsResume: () => false,
    generationPriority: target => index => index === target ? 'immediate' : index === target + 1 ? 'next' : 'background',
    inspectStaticAudio: async () => ({ staticNoise: false }),
    inspectChapterAudio,
    ensureChapterAudio: async (bookId, chapterIndex, options) => { preparations.push({ bookId, chapterIndex, ...options }); },
    lookAhead: () => {},
    onBackgroundError: error => { throw error; }
  });
  async function check(name, fn) {
    if (process.env.PLAYBACK_RELIABILITY_FILTER && !name.includes(process.env.PLAYBACK_RELIABILITY_FILTER)) return;
    try {
      const evidence = await fn();
      results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  try {
    await fixture('holes', ['pending', 'ready', 'ready', 'pending', 'pending', 'pending']);
    await fixture('future-error', ['ready', 'ready', 'pending', 'pending', 'pending', 'error']);
    await fixture('halted-runway', ['pending', 'pending', 'pending', 'pending', 'pending', 'error']);
    tts.getChapterManifest('halted-runway', 0)._generation = { halted: true };
    tts.getChapterManifest('future-error', 0)._generation = { halted: true };
    await fixture('resume', ['pending', 'pending', 'pending', 'pending', 'ready', 'ready']);
    await fixture('voice-scoped', ['pending', 'pending', 'pending', 'pending', 'ready', 'ready']);
    await fixture('priority', Array(6).fill('pending'));
    await fixture('ready', Array(6).fill('ready'));
    const audioFile = tts.chunkPath('ready', 0, 0);
    const app = express(); app.use(express.json());
    const counters = new Map();
    app.use(async (req, res, next) => {
      requests.push({ method: req.method, path: req.path, query: req.query, body: req.body, at: Date.now() });
      const match = req.path.match(/^\/api\/chunks\/(client-[^/]+)\/0\/(prepare-chapter-audio|chapter-audio-status)$/);
      if (!match) return next();
      const [, book, action] = match;
      const key = `${book}:${action}`;
      const count = (counters.get(key) || 0) + 1; counters.set(key, count);
      if (book === 'client-hang' || book === 'client-cancel') return;
      if (book === 'client-transient' && count === 1) return res.status(503).json({ error: 'Temporary outage' });
      if (book === 'client-forbidden') return res.status(403).json({ error: 'Forbidden' });
      if (book === 'client-rate-limit') return res.set('Retry-After', '7').status(429).json({ error: 'Rate limited' });
      if (book === 'client-html-limit') return res.set('Retry-After', '7').status(429).type('html').send('<h1>Rate limited by proxy</h1>');
      const pending = book === 'client-pending' || (book === 'client-pinned' && action === 'prepare-chapter-audio');
      return res.json({ ready: !pending, status: pending ? 'generating' : 'ready', targetChunk: 4, totalChunks: 6, readyChunks: pending ? 0 : 2, servedTier: 'instant', voiceId: 'fixture-voice' });
    });
    app.get(['/api/audio-continuous/:book/:chapter', '/api/audio/:book/:chapter'], (req, res, next) => {
      if (!req.params.book.startsWith('client-')) return next();
      return serveAudioFile(req, res, audioFile);
    });
    hls = createHlsAudioStreamer({ serveAudioFile, rootDir: path.join(temp, 'hls') });
    registerPlaybackRoutes(app, {
      playbackOrchestrator: orchestrator,
      chapterAudioStreamer: createChapterAudioStreamer({ serveAudioFile }),
      hlsAudioStreamer: hls,
      serveAudioFile, fs,
      getBookChapters: async () => ({ chapters }),
      onCurrentChapterPrepared: async () => sleep(horizonDelay),
      sendServerError(res, error) { if (!res.headersSent) res.status(500).json({ error: error.message }); else res.destroy(); }
    });
    app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><html><body><h1>Playback reliability verification</h1><audio controls></audio><button id="play">Play</button><script src="/js/lifecycle.js"></script><script type="module">import {SingleFileChapterPlayer} from "/js/single-file-chapter-player.js"; window.Player = SingleFileChapterPlayer; document.querySelector("#play").onclick = () => window.player.play();</script></body></html>'));
    app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const status = async (book, offset = 0) => (await fetch(`${origin}/api/chunks/${book}/0/chapter-audio-status?purpose=playback-runway&offsetSeconds=${offset}`)).json();
    const prepare = async (book, offset = 0) => (await fetch(`${origin}/api/chunks/${book}/0/prepare-chapter-audio`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'playback-runway', offsetSeconds: offset })
    })).json();
    await check('startup requires contiguous audio at the requested position', async () => {
      const result = await status('holes'); assert.equal(result.ready, false, JSON.stringify(result)); return result;
    });
    await check('an unrelated future failure does not block playable audio', async () => {
      const result = await status('future-error'); assert.equal(result.ready, true, JSON.stringify(result)); return result;
    });
    await check('halted generation reports an unscheduled startup clip immediately', async () => {
      const result = await status('halted-runway');
      assert.equal(result.ready, false); assert.equal(result.status, 'error', JSON.stringify(result));
      return result;
    });
    await check('resume checks the target clips rather than the chapter beginning', async () => {
      const result = await status('resume', 32); assert.equal(result.ready, true); assert.equal(result.targetChunk, 4); return result;
    });
    await check('media transport rejects unrelated ready clips before creating an encoder', async () => {
      const response = await fetch(`${origin}/api/audio-continuous/holes/0?endChapter=0`, { signal: AbortSignal.timeout(1500) });
      const result = { status: response.status }; await response.body.cancel(); assert.equal(result.status, 425); return result;
    });
    await check('resume promotes target clips and keeps whole-chapter work in background', async () => {
      const result = await prepare('priority', 32);
      const work = preparations.filter(item => item.bookId === 'priority' && item.chapterIndex === 0);
      assert(work.every(item => !(item.completeChapter && item.priority === 'immediate')), JSON.stringify(work));
      assert(claims.some(item => item.bookId === 'priority' && item.chunkIndexes?.includes(4)), JSON.stringify(claims));
      assert(priorities.some(item => item.bookId === 'priority' && item.chunkIndex === 4 && item.priority === 'immediate'));
      assert.equal(result.targetChunk, 4); return { result, work, priorities: priorities.filter(item => item.bookId === 'priority') };
    });
    await check('a slow next-chapter status does not delay current readiness', async () => {
      nextChapterDelay = 600;
      try { const began = performance.now(); const result = await status('ready'); const elapsedMs = performance.now() - began;
        assert.equal(result.ready, true); assert(elapsedMs < 400, `${elapsedMs}ms`); return { elapsedMs }; }
      finally { nextChapterDelay = 0; }
    });
    await check('lookahead bookkeeping does not delay current preparation response', async () => {
      horizonDelay = 600;
      try { const began = performance.now(); const result = await prepare('ready'); const elapsedMs = performance.now() - began;
        assert.equal(result.ready, true); assert(elapsedMs < 400, `${elapsedMs}ms`); return { elapsedMs }; }
      finally { horizonDelay = 0; }
    });
    browser = await ({ chromium, webkit }[browserName]).launch();
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    async function client(book, options = {}) {
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/fixture`); await page.waitForFunction(() => window.Player);
        return await page.evaluate(async ({ book, options }) => {
          const errors = [];
          const p = new Player(document.querySelector('audio'), {
            getChapterCount: () => 1, preparationTimeoutMs: 350,
            preparationRequestTimeoutMs: 120, runwayPollIntervalMs: 10, loadTimeoutMs: 1500,
            onError: error => errors.push(error.code || error.message),
            ...(options.hangTier ? { resolveServedTier: () => new Promise(() => {}) } : {})
          });
          const began = performance.now();
          const work = p.loadChapter(book, 0, { startOffsetSeconds: 32 }).then(() => ({ loaded: true }), error => ({ code: error.code, status: error.status, retryAfterSeconds: error.retryAfterSeconds, cancelled: Boolean(error.cancelled) }));
          if (options.cancel) setTimeout(() => p.dispose(), 40);
          let guard;
          const result = await Promise.race([work, new Promise(resolve => { guard = setTimeout(() => resolve({ hung: true }), 1000); })]);
          clearTimeout(guard);
          const evidence = { ...result, elapsedMs: performance.now() - began, errors, source: p.audio.getAttribute('src'), loading: p._isLoading };
          p.dispose(); return evidence;
        }, { book, options });
      } finally { await page.screenshot({ path: path.join(output, `${phase}-${browserName}-${book}.png`) }); await page.close(); }
    }
    await check('voice selection is resolved by preparation without a duplicate blocking probe', async () => {
      const result = await client('client-ready', { hangTier: true }); assert(result.loaded, JSON.stringify(result)); return result;
    });
    await check('a silent preparation request reaches a recoverable deadline', async () => {
      const result = await client('client-hang'); assert.equal(result.code, 'PLAYBACK_PREPARATION_TIMEOUT', JSON.stringify(result)); assert.equal(result.loading, false); return result;
    });
    await check('successful pending polls cannot leave loading stuck forever', async () => {
      const result = await client('client-pending'); assert.equal(result.code, 'PLAYBACK_PREPARATION_TIMEOUT', JSON.stringify(result)); return result;
    });
    await check('transient preparation failure retries and loads real browser audio', async () => {
      const result = await client('client-transient'); assert(result.loaded, JSON.stringify(result)); return result;
    });
    await check('preparation polls preserve the offset and selected voice', async () => {
      const result = await client('client-pinned'); assert(result.loaded, JSON.stringify(result));
      const poll = requests.find(item => item.path === '/api/chunks/client-pinned/0/chapter-audio-status');
      assert.equal(poll?.query.offsetSeconds, '32'); assert.equal(poll?.query.tier, 'instant'); assert.equal(poll?.query.voiceId, 'fixture-voice'); return { result, poll };
    });
    await check('permanent failures are not retried', async () => {
      const result = await client('client-forbidden'); assert.equal(result.status, 403); assert.equal(counters.get('client-forbidden:prepare-chapter-audio'), 1); return result;
    });
    await check('rate limits preserve Retry-After without retrying early', async () => {
      const result = await client('client-rate-limit'); assert.equal(result.status, 429); assert.equal(result.retryAfterSeconds, 7); assert.equal(counters.get('client-rate-limit:prepare-chapter-audio'), 1); return result;
    });
    await check('a proxy HTML rate limit preserves Retry-After without retries', async () => {
      const result = await client('client-html-limit'); assert.equal(result.status, 429, JSON.stringify(result)); assert.equal(result.retryAfterSeconds, 7); assert.equal(counters.get('client-html-limit:prepare-chapter-audio'), 1); return result;
    });
    await check('cancellation aborts pending preparation without a playback error', async () => {
      const result = await client('client-cancel', { cancel: true }); assert.equal(result.cancelled, true); assert.deepEqual(result.errors, []); return result;
    });
    await check('a different narrator’s completed artifact cannot replace the selected voice clips', async () => {
      const response = await fetch(`${origin}/api/audio-continuous/voice-scoped/0?offsetSeconds=32&endChapter=0`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); const bytes = (await response.arrayBuffer()).byteLength;
      assert(bytes > 1000); return { status: response.status, bytes, voiceId: response.headers.get('x-voice-id') };
    });
    await check('real continuous audio resumes without generating or decoding the chapter prefix', async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/fixture`); await page.waitForFunction(() => window.Player);
        const loadMs = await page.evaluate(async isWebkit => {
          window.player = new Player(document.querySelector('audio'), { getChapterCount: () => 2, isIOSLike: () => isWebkit });
          const began = performance.now();
          await player.loadChapter('resume', 0, { startOffsetSeconds: 32, endChapterIndex: 0 });
          return performance.now() - began;
        }, browserName === 'webkit');
        const began = performance.now(); await page.locator('#play').click();
        await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.15, null, { timeout: 5000 });
        const state = await page.evaluate(() => ({ position: player.getPosition(), source: player.audio.currentSrc, paused: player.audio.paused }));
        assert.equal(state.paused, false); assert(state.position.totalEstimatedTime >= 32, JSON.stringify(state));
        assert(loadMs < 3000, `Cached resume took ${loadMs}ms`);
        await page.screenshot({ path: path.join(output, `${phase}-${browserName}-real-resume.png`) });
        await page.evaluate(() => player.dispose());
        return { loadMs, playToAdvanceMs: performance.now() - began, ...state };
      } finally { await page.close(); }
    });
  } finally {
    if (context) await context.tracing.stop({ path: path.join(output, `${phase}-${browserName}.trace.zip`) });
    if (browser) await browser.close();
    await hls?.dispose();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `${phase}-${browserName}.json`), JSON.stringify({ browserName, results }, null, 2));
  }
  console.log(`${results.filter(result => result.passed).length} passed, ${results.filter(result => !result.passed).length} failed`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
