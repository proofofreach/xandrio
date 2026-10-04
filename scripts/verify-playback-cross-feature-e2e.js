'use strict';

// Failure modes recorded before each fix: slow preparation publishes a stale
// book; pause/dispose revives a relocating stream; native errors have read-only
// codes; retries lose speed, voice, offset, or session; cold seeks skip target
// preparation; pause or a newer book fails to supersede a preparing seek;
// a pause after metadata turns an interrupted play into a false seek error,
// or a play promise that never settles leaves relocation loading forever.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-reliability/adversarial');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browserName = process.env.PLAYBACK_ADVERSARIAL_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(browserName));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function wavTone(seconds = 8, frequency = 440) {
  const rate = 24000;
  const samples = rate * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    bytes.writeInt16LE(
      Math.round(1000 * Math.sin(2 * Math.PI * frequency * index / rate)),
      44 + index * 2
    );
  }
  return bytes;
}

function requestRecord(req) {
  return {
    method: req.method,
    path: req.path,
    query: Object.fromEntries(Object.entries(req.query || {}).map(([key, value]) => [key, String(value)])),
    body: req.body || null,
    at: Date.now()
  };
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-adversarial-playback-'));
  const audioFiles = new Map();
  for (const [id, frequency] of [['a', 220], ['b', 330], ['c', 440], ['pause-seek', 550], ['dispose-seek', 660], ['retry-voice', 770], ['cold-seek', 880], ['cold-pause', 990], ['cold-supersede', 1100], ['late-pause', 1200], ['pending-play', 1300]]) {
    const file = path.join(temp, `${id}.wav`);
    await fs.writeFile(file, wavTone(8, frequency));
    audioFiles.set(id, file);
  }

  const requests = [];
  const results = [];
  const gates = new Map();
  const preparedOffsets = new Set();
  let retryReady = false;
  let browser;
  let context;
  let server;
  const preparedKey = (book, offset) => `${book}:${Number(offset) || 0}`;

  function gate(key) {
    const item = { key, hit: deferred(), release: deferred(), aborted: false, claimed: false };
    gates.set(key, item);
    return item;
  }

  async function hold(req, res, key) {
    const item = gates.get(key);
    if (!item) return;
    item.claimed = true;
    const markAborted = () => { if (!res.writableEnded) item.aborted = true; };
    req.once('aborted', markAborted);
    res.once('close', markAborted);
    item.hit.resolve();
    await item.release.promise;
  }

  async function waitForGate(item, timeoutMs = 10000) {
    let timer;
    try {
      await Promise.race([
        item.hit.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Request gate ${item.key} was not reached`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function check(name, run) {
    if (process.env.PLAYBACK_ADVERSARIAL_CASE && !name.includes(process.env.PLAYBACK_ADVERSARIAL_CASE)) return;
    const page = await context.newPage();
    const diagnostics = [];
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`));
    try {
      const evidence = await run(page);
      results.push({ name, passed: true, evidence, diagnostics });
      console.log(`PASS ${name}`);
    } catch (error) {
      const evidence = await page.evaluate(() => ({
        hash: location.hash,
        title: document.querySelector('#book-title')?.textContent,
        source: document.querySelector('audio')?.currentSrc,
        paused: document.querySelector('audio')?.paused,
        time: document.querySelector('audio')?.currentTime
      })).catch(() => ({}));
      results.push({ name, passed: false, error: error.stack || error.message, evidence, diagnostics });
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      await page.screenshot({
        path: path.join(output, `${browserName}-${String(results.length).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`),
        fullPage: true
      }).catch(() => {});
      await page.close();
    }
  }

  try {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.path.startsWith('/api/')) requests.push(requestRecord(req));
      next();
    });

    const books = ['a', 'b', 'c'].map(id => ({
      id,
      title: `Book ${id.toUpperCase()}`,
      author: 'Adversarial fixture',
      chapterCount: 1,
      totalDuration: 60
    }));
    const chapters = [{
      title: 'Chapter One',
      type: 'chapter',
      text: 'A deterministic playback fixture.',
      estimatedDuration: 60
    }];

    app.get('/api/legal/operator-policy', (_req, res) => res.json({
      version: 1,
      acknowledged: true,
      acknowledgedAt: '2026-10-04T00:00:00Z',
      unverifiedSourcesEnabled: false
    }));
    app.get('/api/voices', (_req, res) => res.json({
      current: 'edge:andrew',
      voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }]
    }));
    app.get('/api/library', (_req, res) => res.json({ books }));
    app.get('/api/book/:book', (req, res) => {
      const book = books.find(candidate => candidate.id === req.params.book);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      return res.json({ book, chapters });
    });
    app.get('/api/position/:book', (_req, res) => res.json({ position: null }));

    app.all('/api/chunks/:book/:chapter/:action', async (req, res) => {
      const { book, action } = req.params;
      if (book === 'b' && action === 'prepare-chapter-audio') {
        await hold(req, res, 'book-b-prepare');
        if (res.destroyed) return;
      }
      if (['cold-pause', 'cold-supersede'].includes(book)
          && action === 'prepare-chapter-audio'
          && Number(req.query.offsetSeconds) === 24) {
        await hold(req, res, `${book}-prepare-24`);
        if (res.destroyed) return;
      }
      if (['cold-seek', 'cold-pause', 'cold-supersede'].includes(book)
          && action === 'prepare-chapter-audio') {
        preparedOffsets.add(preparedKey(book, req.query.offsetSeconds));
      }
      return res.json({
        ready: true,
        status: 'ready',
        servedTier: book === 'retry-voice' ? 'premium' : 'instant',
        voiceId: book === 'retry-voice' ? 'voice-fixture' : 'edge:andrew',
        targetChunk: 0,
        readyChunks: 1,
        totalChunks: 1
      });
    });

    const mediaRateLimit = rateLimit({ windowMs: 60_000, limit: 600 });
    app.get(['/api/audio-continuous/:book/:chapter', '/api/audio/:book/:chapter'], mediaRateLimit, async (req, res) => {
      const book = req.params.book;
      const offset = Number(req.query.offsetSeconds) || 0;
      if (book === 'pause-seek' && offset === 20) {
        await hold(req, res, 'pause-seek-offset');
        if (res.destroyed) return;
      }
      if (book === 'dispose-seek' && offset === 20) {
        await hold(req, res, 'dispose-seek-offset');
        if (res.destroyed) return;
      }
      if (book === 'retry-voice' && offset === 30 && !retryReady) {
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'Controlled relocation failure' });
      }
      if (['cold-seek', 'cold-pause', 'cold-supersede'].includes(book)
          && !preparedOffsets.has(preparedKey(book, offset))) {
        res.set('Cache-Control', 'no-store');
        return res.status(425).json({ error: 'Target playback runway is not ready' });
      }
      const file = audioFiles.get(book);
      if (!file) return res.status(404).end();
      res.set('Cache-Control', 'no-store');
      return res.sendFile(file);
    });

    app.get('/adversarial-fixture', (_req, res) => res.type('html').send(`<!doctype html>
      <html><body>
      <h1>Adversarial playback fixture</h1>
      <audio controls></audio><button id="play">Play</button>
      <script src="/js/lifecycle.js"></script>
      <script type="module">
        import { SingleFileChapterPlayer } from '/js/single-file-chapter-player.js';
        window.Player = SingleFileChapterPlayer;
        document.querySelector('#play').onclick = () => {
          window.playWork = window.player.play().catch(error => {
            window.playError = { name: error.name, code: error.code, message: error.message };
          });
        };
      </script>
      </body></html>`));
    app.all('/api/*path', (_req, res) => res.json({}));
    app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await ({ chromium, webkit }[browserName]).launch(
      browserName === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : {}
    );
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const initializeDirectPlayer = async (page, book, options = {}) => {
      await page.goto(`${origin}/adversarial-fixture`);
      await page.waitForFunction(() => Boolean(window.Player));
      await page.evaluate(async ({ book, options }) => {
        window.events = [];
        window.errors = [];
        window.readyEvents = [];
        window.preparingEvents = [];
        window.player = new Player(document.querySelector('audio'), {
          getChapterCount: () => 1,
          getEstimatedDuration: () => 60,
          getContinuousEndChapter: () => 0,
          loadTimeoutMs: 5000,
          playTimeoutMs: 5000,
          playProgressTimeoutMs: 3000,
          preparationTimeoutMs: 5000,
          preparationRequestTimeoutMs: 3000,
          runwayPollIntervalMs: 50,
          onReady: () => window.readyEvents.push({ bookId: window.player.bookId, chapterIndex: window.player.chapterIndex }),
          onPreparing: detail => window.preparingEvents.push(detail),
          onPlaybackChange: (playing, detail) => window.events.push({ playing, reason: detail?.reason || null, at: performance.now() }),
          onError: error => window.errors.push({ name: error.name, code: error.code, message: error.message })
        });
        if (options.rate) window.player.setSpeed(options.rate);
        await window.player.loadChapter(book, 0, options.load || {});
      }, { book, options });
    };

    // Keep a real media source and real metadata events. Only the return value
    // of the relocation's native play() call is controlled, so a pause can be
    // placed precisely after metadata while the player awaits that promise.
    const holdRelocationPlay = async (page, offset, startNativePlayback = true) => {
      await page.evaluate(({ offset, startNativePlayback }) => {
        const audio = window.player.audio;
        const nativePlay = audio.play.bind(audio);
        window.heldRelocationPlay = { called: false, metadata: false };
        audio.addEventListener('loadedmetadata', () => {
          if (new URL(audio.src).searchParams.get('offsetSeconds') === String(offset)) {
            window.heldRelocationPlay.metadata = true;
          }
        });
        audio.play = function () {
          if (new URL(this.src).searchParams.get('offsetSeconds') !== String(offset)) {
            return nativePlay();
          }
          const nativeResult = startNativePlayback ? nativePlay() : null;
          nativeResult?.catch(() => {});
          window.heldRelocationPlay.called = true;
          return new Promise((resolve, reject) => {
            window.heldRelocationPlay.resolve = resolve;
            window.heldRelocationPlay.reject = reject;
          });
        };
      }, { offset, startNativePlayback });
    };

    await check('superseded slow preparation cannot commit or play the outgoing book', async page => {
      const bookBPrepare = gate('book-b-prepare');
      const failedRequests = [];
      page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText || '' }));
      await page.goto(`${origin}/#/player/a`);
      await page.waitForFunction(() => {
        const audio = document.querySelector('#audio-player');
        return document.querySelector('#book-title')?.textContent === 'Book A'
          && audio?.currentSrc.includes('/api/audio-continuous/a/');
      });
      await page.evaluate(() => { location.hash = '#/player/b'; });
      await waitForGate(bookBPrepare);
      await page.evaluate(() => { location.hash = '#/player/c'; });
      await page.waitForFunction(() => {
        const audio = document.querySelector('#audio-player');
        return document.querySelector('#book-title')?.textContent === 'Book C'
          && audio?.currentSrc.includes('/api/audio-continuous/c/');
      }, null, { timeout: 10000 });
      await sleep(300);
      bookBPrepare.release.resolve();
      await sleep(400);
      await page.locator('#play-pause-btn').click();
      await page.waitForFunction(() => document.querySelector('#audio-player')?.currentTime > 0.1);
      const state = await page.evaluate(() => {
        const audio = document.querySelector('#audio-player');
        return {
          title: document.querySelector('#book-title')?.textContent,
          hash: location.hash,
          source: audio.currentSrc,
          paused: audio.paused,
          time: audio.currentTime
        };
      });
      const bAudio = requests.filter(item => item.path.includes('/api/audio-continuous/b/'));
      const bPolls = requests.filter(item => item.path.includes('/api/chunks/b/') && item.path.endsWith('/chapter-audio-status'));
      const browserObservedAbort = failedRequests.some(item => item.url.includes('/api/chunks/b/0/prepare-chapter-audio'));
      assert.equal(state.title, 'Book C', JSON.stringify(state));
      assert(state.source.includes('/api/audio-continuous/c/'), JSON.stringify(state));
      assert.equal(state.paused, false, JSON.stringify(state));
      assert.equal(bAudio.length, 0, JSON.stringify(bAudio));
      assert.equal(bPolls.length, 0, JSON.stringify(bPolls));
      assert(bookBPrepare.aborted || browserObservedAbort, JSON.stringify({ gate: bookBPrepare, failedRequests }));
      return { state, heldPreparationAborted: bookBPrepare.aborted, browserObservedAbort, bAudio, bPolls };
    });

    await check('pause during a held nonseekable relocation stays paused after reconnect', async page => {
      const seekGate = gate('pause-seek-offset');
      await initializeDirectPlayer(page, 'pause-seek');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await page.evaluate(() => {
        window.seekWork = window.player.seek(20).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message, cancelled: Boolean(error.cancelled) })
        );
      });
      await waitForGate(seekGate);
      const beforePause = await page.evaluate(() => window.events.length);
      await page.evaluate(() => window.player.pause('app'));
      await sleep(200);
      seekGate.release.resolve();
      const seekResult = await page.evaluate(() => window.seekWork);
      await sleep(350);
      const state = await page.evaluate(() => ({
        paused: player.audio.paused,
        playing: player.isPlaying,
        loading: player.isPreparingSource(),
        ready: player.ownsReadySource('pause-seek', 0),
        position: player.getCurrentTime(),
        rate: player.audio.playbackRate,
        source: player.audio.currentSrc,
        events: window.events,
        errors: window.errors
      }));
      const latePlay = state.events.slice(beforePause).some(event => event.playing);
      assert.deepEqual(seekResult, { ok: true }, JSON.stringify(seekResult));
      assert.equal(state.paused, true, JSON.stringify(state));
      assert.equal(state.playing, false, JSON.stringify(state));
      assert.equal(state.loading, false, JSON.stringify(state));
      assert.equal(latePlay, false, JSON.stringify(state.events));
      assert.equal(state.errors.length, 0, JSON.stringify(state.errors));
      return { seekResult, state, latePlay };
    });

    await check('controlled late pause after metadata keeps the relocated source ready', async page => {
      await initializeDirectPlayer(page, 'late-pause');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await holdRelocationPlay(page, 20);
      await page.evaluate(() => {
        window.seekWork = player.seek(20).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message })
        );
      });
      await page.waitForFunction(() => heldRelocationPlay.called && heldRelocationPlay.metadata);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      await page.evaluate(() => {
        player.pause('app');
        heldRelocationPlay.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
      });
      const seekResult = await page.evaluate(() => Promise.race([
        window.seekWork,
        new Promise(resolve => setTimeout(() => resolve({ pending: true }), 2000))
      ]));
      const state = await page.evaluate(() => ({
        paused: player.audio.paused,
        loading: player.isPreparingSource(),
        ready: player.ownsReadySource('late-pause', 0),
        position: player.getCurrentTime(),
        errors: window.errors
      }));
      assert.deepEqual(seekResult, { ok: true }, JSON.stringify({ seekResult, state }));
      assert.equal(state.paused, true, JSON.stringify(state));
      assert.equal(state.loading, false, JSON.stringify(state));
      assert.equal(state.ready, true, JSON.stringify(state));
      assert.equal(state.errors.length, 0, JSON.stringify(state));
      return { seekResult, state };
    });

    await check('controlled pending play after metadata has a bounded relocation deadline', async page => {
      await initializeDirectPlayer(page, 'pending-play');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await page.evaluate(() => { player.playTimeoutMs = 300; });
      // The source is real audio. The controlled play() return stays pending,
      // like a browser that has metadata but cannot start reading media data.
      await holdRelocationPlay(page, 20, false);
      await page.evaluate(() => {
        window.seekWork = player.seek(20).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message })
        );
      });
      await page.waitForFunction(() => heldRelocationPlay.called && heldRelocationPlay.metadata);
      const seekResult = await page.evaluate(() => Promise.race([
        window.seekWork,
        new Promise(resolve => setTimeout(() => resolve({ pending: true }), 1500))
      ]));
      const state = await page.evaluate(() => ({
        paused: player.audio.paused,
        loading: player.isPreparingSource(),
        ready: player.ownsReadySource('pending-play', 0),
        errors: window.errors
      }));
      assert.equal(seekResult.ok, false, JSON.stringify({ seekResult, state }));
      assert.equal(seekResult.code, 'MEDIA_PLAY_TIMEOUT', JSON.stringify({ seekResult, state }));
      assert.equal(state.paused, true, JSON.stringify(state));
      assert.equal(state.loading, false, JSON.stringify(state));
      assert.equal(state.ready, false, JSON.stringify(state));
      assert.equal(state.errors.length, 1, JSON.stringify(state));
      return { seekResult, state };
    });

    await check('controlled pending relocation cannot pause a newer book', async page => {
      await initializeDirectPlayer(page, 'pending-play');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await holdRelocationPlay(page, 20, false);
      await page.evaluate(() => {
        window.seekWork = player.seek(20).then(
          () => ({ ok: true }),
          error => ({ ok: false, cancelled: Boolean(error.cancelled), code: error.code })
        );
      });
      await page.waitForFunction(() => heldRelocationPlay.called && heldRelocationPlay.metadata);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      await page.evaluate(() => { window.replacementWork = player.loadChapter('c', 0); });
      await page.evaluate(() => window.replacementWork);
      await page.locator('#play').click();
      await page.waitForFunction(() => player.bookId === 'c' && !player.audio.paused && player.audio.currentTime > 0.1);
      const seekResult = await page.evaluate(() => Promise.race([
        window.seekWork,
        new Promise(resolve => setTimeout(() => resolve({ pending: true }), 2000))
      ]));
      const state = await page.evaluate(() => ({
        bookId: player.bookId,
        source: player.audio.currentSrc,
        paused: player.audio.paused,
        ready: player.ownsReadySource('c', 0),
        errors: window.errors
      }));
      assert.equal(seekResult.cancelled, true, JSON.stringify({ seekResult, state }));
      assert.equal(state.bookId, 'c', JSON.stringify(state));
      assert(state.source.includes('/api/audio-continuous/c/'), JSON.stringify(state));
      assert.equal(state.paused, false, JSON.stringify(state));
      assert.equal(state.ready, true, JSON.stringify(state));
      assert.deepEqual(state.errors, [], JSON.stringify(state));
      return { seekResult, state };
    });

    await check('controlled pending relocation settles quietly on dispose', async page => {
      await initializeDirectPlayer(page, 'pending-play');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await holdRelocationPlay(page, 20, false);
      await page.evaluate(() => {
        window.seekWork = player.seek(20).then(
          () => ({ ok: true }),
          error => ({ ok: false, cancelled: Boolean(error.cancelled), code: error.code })
        );
      });
      await page.waitForFunction(() => heldRelocationPlay.called && heldRelocationPlay.metadata);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      await page.evaluate(() => player.dispose());
      const seekResult = await page.evaluate(() => Promise.race([
        window.seekWork,
        new Promise(resolve => setTimeout(() => resolve({ pending: true }), 2000))
      ]));
      const state = await page.evaluate(() => ({
        source: player.audio.getAttribute('src'),
        paused: player.audio.paused,
        loading: player.isPreparingSource(),
        ready: player.ownsReadySource('pending-play', 0),
        errors: window.errors
      }));
      assert.equal(seekResult.cancelled, true, JSON.stringify({ seekResult, state }));
      assert.equal(state.source, null, JSON.stringify(state));
      assert.equal(state.paused, true, JSON.stringify(state));
      assert.equal(state.loading, false, JSON.stringify(state));
      assert.equal(state.ready, false, JSON.stringify(state));
      assert.deepEqual(state.errors, [], JSON.stringify(state));
      return { seekResult, state };
    });

    await check('dispose cancels a held relocation without stale callbacks or source', async page => {
      const seekGate = gate('dispose-seek-offset');
      await initializeDirectPlayer(page, 'dispose-seek');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await page.evaluate(() => {
        window.seekWork = window.player.seek(20).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message, cancelled: Boolean(error.cancelled) })
        );
      });
      await waitForGate(seekGate);
      await page.evaluate(() => window.player.dispose());
      await sleep(250);
      seekGate.release.resolve();
      const seekResult = await page.evaluate(() => window.seekWork);
      await sleep(250);
      const state = await page.evaluate(() => ({
        src: player.audio.getAttribute('src'),
        currentSrc: player.audio.currentSrc,
        paused: player.audio.paused,
        loading: player.isPreparingSource(),
        ready: player.ownsReadySource('dispose-seek', 0),
        events: window.events,
        errors: window.errors
      }));
      assert.equal(seekResult.ok, false, JSON.stringify(seekResult));
      assert.equal(seekResult.cancelled, true, JSON.stringify(seekResult));
      assert.equal(state.src, null, JSON.stringify(state));
      assert.equal(state.paused, true, JSON.stringify(state));
      assert.equal(state.loading, false, JSON.stringify(state));
      assert.equal(state.ready, false, JSON.stringify(state));
      assert.deepEqual(state.errors, [], JSON.stringify(state.errors));
      return { seekResult, state, requestAborted: seekGate.aborted };
    });

    await check('failed relocation retry preserves voice offset speed end bound and session', async page => {
      retryReady = false;
      await initializeDirectPlayer(page, 'retry-voice', {
        rate: 1.75,
        load: { startOffsetSeconds: 12, servedTier: 'premium', voiceId: 'voice-fixture', endChapterIndex: 0 }
      });
      await page.evaluate(() => {
        window.seekWork = window.player.seek(30).then(
          () => ({ ok: true }),
          error => ({
            ok: false,
            name: error.name,
            code: error.code,
            message: error.message,
            chapterTime: error.chapterTime,
            voiceId: player.voiceId,
            servedTier: player.servedTier,
            endChapterIndex: player.endChapterIndex
          })
        );
      });
      const failure = await page.evaluate(() => window.seekWork);
      assert.equal(failure.ok, false, JSON.stringify(failure));
      assert.equal(failure.chapterTime, 30, JSON.stringify(failure));
      retryReady = true;
      const recovered = await page.evaluate(async failure => {
        await player.loadChapter('retry-voice', 0, {
          startOffsetSeconds: failure.chapterTime,
          servedTier: failure.servedTier,
          voiceId: failure.voiceId,
          endChapterIndex: failure.endChapterIndex
        });
        return {
          position: player.getCurrentTime(),
          servedTier: player.servedTier,
          voiceId: player.voiceId,
          endChapterIndex: player.endChapterIndex,
          playbackRate: player.playbackRate,
          nativeRate: player.audio.playbackRate,
          source: player.audio.currentSrc,
          ready: player.ownsReadySource('retry-voice', 0),
          errors: window.errors
        };
      }, failure);
      const relocationMedia = requests.filter(item =>
        item.path === '/api/audio-continuous/retry-voice/0' && item.query.offsetSeconds === '30'
      );
      const retryPrepare = requests.filter(item =>
        item.path === '/api/chunks/retry-voice/0/prepare-chapter-audio'
        && item.query.offsetSeconds === '30'
      ).at(-1);
      const sessions = [...new Set(relocationMedia.map(item => item.query.session).filter(Boolean))];
      assert(relocationMedia.length >= 2, JSON.stringify(relocationMedia));
      assert.equal(sessions.length, 1, JSON.stringify(relocationMedia));
      assert.equal(retryPrepare?.query.tier, 'premium', JSON.stringify(retryPrepare));
      assert.equal(retryPrepare?.query.voiceId, 'voice-fixture', JSON.stringify(retryPrepare));
      assert.equal(retryPrepare?.query.endChapter, '0', JSON.stringify(retryPrepare));
      assert.equal(retryPrepare?.body?.offsetSeconds, 30, JSON.stringify(retryPrepare));
      assert.equal(retryPrepare?.body?.playbackRate, 1.75, JSON.stringify(retryPrepare));
      assert.equal(recovered.servedTier, 'premium', JSON.stringify(recovered));
      assert.equal(recovered.voiceId, 'voice-fixture', JSON.stringify(recovered));
      assert.equal(recovered.endChapterIndex, 0, JSON.stringify(recovered));
      assert.equal(recovered.playbackRate, 1.75, JSON.stringify(recovered));
      assert.equal(recovered.nativeRate, 1.75, JSON.stringify(recovered));
      assert(recovered.position >= 30 && recovered.position < 31, JSON.stringify(recovered));
      assert.equal(recovered.ready, true, JSON.stringify(recovered));
      return { failure, recovered, retryPrepare, relocationMedia, sessions };
    });

    await check('cold nonseekable seek prepares the target before opening replacement media', async page => {
      preparedOffsets.clear();
      await initializeDirectPlayer(page, 'cold-seek');
      const beforeSeek = await page.evaluate(() => ({ ready: readyEvents.length, preparing: preparingEvents.length }));
      const result = await page.evaluate(async () => {
        try {
          await player.seek(24);
          return {
            ok: true,
            position: player.getCurrentTime(),
            source: player.audio.currentSrc,
            readyEvents: readyEvents.length,
            preparingEvents: preparingEvents.length
          };
        } catch (error) {
          return {
            ok: false,
            name: error.name,
            code: error.code,
            status: error.status,
            message: error.message,
            chapterTime: error.chapterTime
          };
        }
      });
      const targetPrepares = requests.filter(item =>
        item.path === '/api/chunks/cold-seek/0/prepare-chapter-audio'
        && item.query.offsetSeconds === '24'
      );
      const targetMedia = requests.filter(item =>
        item.path === '/api/audio-continuous/cold-seek/0'
        && item.query.offsetSeconds === '24'
      );
      assert.equal(result.ok, true, JSON.stringify({ result, targetPrepares, targetMedia }));
      assert.equal(targetPrepares.length, 1, JSON.stringify(targetPrepares));
      assert(targetMedia.length >= 1, JSON.stringify(targetMedia));
      assert(result.position >= 24, JSON.stringify(result));
      assert(result.preparingEvents > beforeSeek.preparing, JSON.stringify({ result, beforeSeek }));
      assert.equal(result.readyEvents, beforeSeek.ready + 1, JSON.stringify({ result, beforeSeek }));
      return { result, targetPrepares, targetMedia };
    });

    await check('pause during cold-target preparation completes paused and explicit play still works', async page => {
      preparedOffsets.clear();
      const prepareGate = gate('cold-pause-prepare-24');
      await initializeDirectPlayer(page, 'cold-pause');
      await page.locator('#play').click();
      await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
      await page.evaluate(() => {
        window.seekWork = player.seek(24).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message, cancelled: Boolean(error.cancelled) })
        );
      });
      await waitForGate(prepareGate);
      const mediaBeforeRelease = requests.filter(item =>
        item.path === '/api/audio-continuous/cold-pause/0'
        && item.query.offsetSeconds === '24'
      );
      assert.equal(mediaBeforeRelease.length, 0, JSON.stringify(mediaBeforeRelease));
      const eventCountAtPause = await page.evaluate(() => {
        player.pause('app');
        return window.events.length;
      });
      await sleep(200);
      prepareGate.release.resolve();
      const seekResult = await page.evaluate(() => window.seekWork);
      await sleep(250);
      const paused = await page.evaluate(() => ({
        paused: player.audio.paused,
        playing: player.isPlaying,
        ready: player.ownsReadySource('cold-pause', 0),
        position: player.getCurrentTime(),
        events: window.events,
        errors: window.errors
      }));
      assert.deepEqual(seekResult, { ok: true }, JSON.stringify(seekResult));
      assert.equal(paused.paused, true, JSON.stringify(paused));
      assert.equal(paused.playing, false, JSON.stringify(paused));
      assert.equal(paused.ready, true, JSON.stringify(paused));
      assert.equal(paused.events.slice(eventCountAtPause).some(event => event.playing), false, JSON.stringify(paused.events));
      assert.deepEqual(paused.errors, [], JSON.stringify(paused.errors));
      await page.locator('#play').click();
      await page.waitForFunction(() => !player.audio.paused && player.audio.currentTime > 0.1);
      const resumed = await page.evaluate(() => ({
        paused: player.audio.paused,
        playing: player.isPlaying,
        position: player.getCurrentTime()
      }));
      assert.equal(resumed.paused, false, JSON.stringify(resumed));
      assert.equal(resumed.playing, true, JSON.stringify(resumed));
      assert(resumed.position > 24, JSON.stringify(resumed));
      return { seekResult, paused, resumed, preparationAborted: prepareGate.aborted };
    });

    await check('new load aborts cold-target preparation without stale media or callbacks', async page => {
      preparedOffsets.clear();
      const prepareGate = gate('cold-supersede-prepare-24');
      await initializeDirectPlayer(page, 'cold-supersede');
      const readyCountBeforeSeek = await page.evaluate(() => window.readyEvents.length);
      await page.evaluate(() => {
        window.seekWork = player.seek(24).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message, cancelled: Boolean(error.cancelled) })
        );
      });
      await waitForGate(prepareGate);
      const replacement = await page.evaluate(() => {
        window.replacementWork = player.loadChapter('pause-seek', 0).then(
          () => ({ ok: true }),
          error => ({ ok: false, name: error.name, code: error.code, message: error.message, cancelled: Boolean(error.cancelled) })
        );
        return true;
      });
      assert.equal(replacement, true);
      const replacementResult = await page.evaluate(() => window.replacementWork);
      prepareGate.release.resolve();
      const seekResult = await page.evaluate(() => window.seekWork);
      await sleep(250);
      const staleMedia = requests.filter(item =>
        item.path === '/api/audio-continuous/cold-supersede/0'
        && item.query.offsetSeconds === '24'
      );
      const state = await page.evaluate(() => ({
        bookId: player.bookId,
        paused: player.audio.paused,
        readyReplacement: player.ownsReadySource('pause-seek', 0),
        readyEvents: window.readyEvents,
        errors: window.errors,
        source: player.audio.currentSrc
      }));
      assert.deepEqual(replacementResult, { ok: true }, JSON.stringify(replacementResult));
      assert.equal(seekResult.ok, false, JSON.stringify(seekResult));
      assert.equal(seekResult.cancelled, true, JSON.stringify(seekResult));
      assert.equal(state.bookId, 'pause-seek', JSON.stringify(state));
      assert.equal(state.readyReplacement, true, JSON.stringify(state));
      assert.equal(staleMedia.length, 0, JSON.stringify(staleMedia));
      assert.equal(state.readyEvents.length, readyCountBeforeSeek + 1, JSON.stringify(state.readyEvents));
      assert.equal(state.readyEvents.at(-1)?.bookId, 'pause-seek', JSON.stringify(state.readyEvents));
      assert.deepEqual(state.errors, [], JSON.stringify(state.errors));
      return { replacementResult, seekResult, state, staleMedia, preparationAborted: prepareGate.aborted };
    });
  } finally {
    for (const item of gates.values()) item.release.resolve();
    if (context) await context.tracing.stop({ path: path.join(output, `cross-feature-${browserName}.trace.zip`) });
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(
      path.join(output, `cross-feature-${browserName}.json`),
      JSON.stringify({ browserName, results, requestCount: requests.length, requests }, null, 2)
    );
  }

  const passed = results.filter(result => result.passed).length;
  const failed = results.length - passed;
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
