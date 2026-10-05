// Failure modes recorded before fixes: delayed narrator save resumes after Pause;
// delayed save reloads a newer chapter; preparation rewinds a later seek or elapsed playback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const browserName = process.env.VOICE_SWITCH_BROWSER || 'chromium';

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-interruption/voices');
const phase = process.env.VOICE_SWITCH_PHASE || `voice-switch-${browserName}`;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function tone(frequency) {
  const rate = 8000, samples = rate * 30;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return bytes;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-book-switch-'));
  const gates = new Map(), allGates = new Set(), results = [];
  let browser, context, server;
  let finite = false; const advances = []; const audioRequests = []; let voice = 'edge:andrew';
  const books = ['a', 'b', 'c', 'd'].map(id => ({ id, title: `Book ${id.toUpperCase()}`, author: 'Fixture', chapterCount: 1, totalDuration: 30 }));
  const chapters = [{ title: 'Chapter One', type: 'chapter', text: 'A deterministic narration fixture.', estimatedDuration: 30 }];
  function gate(key) {
    const item = { hit: deferred(), release: deferred() };
    gates.set(key, item); allGates.add(item); return item;
  }
  async function gateRequest(key) {
    const item = gates.get(key);
    if (!item) return;
    gates.delete(key); item.hit.resolve(); await item.release.promise;
  }
  async function hit(item) {
    let timer;
    try { await Promise.race([item.hit.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected request gate was not reached')), 10000); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    const audioPaths = {};
    for (const [index, book] of books.entries()) {
      audioPaths[book.id] = path.join(temp, `${book.id}.wav`);
      await fs.writeFile(audioPaths[book.id], tone(220 + index * 220));
    }
    const app = express();
    app.use(express.json());
    app.post('/api/position', async (req, res) => { if (req.body.finished) await gateRequest(`save:${req.body.bookId}`); await gateRequest('save:chapter-selection'); res.json({}); });
    app.get('/api/listening-queue', (_req, res) => res.json({ queue: { bookIds: ['a', 'b', 'c'], autoContinue: true, bookSettings: {} }, books }));
    app.post('/api/listening-queue/advance', async (req, res) => { advances.push(req.body.finishedBookId); await gateRequest('advance'); res.json({ nextBookId: 'c' }); });
    const mediaRateLimit = rateLimit({ windowMs: 60_000, limit: 600 });
    app.get('/api/legal/operator-policy', (_req, res) => res.json({ version: 1, acknowledged: true, acknowledgedAt: '2026-09-30T00:00:00Z', unverifiedSourcesEnabled: false }));
    app.get('/api/engines/status', (_req, res) => res.json({ engines: { edge: { up: true, status: 'ready' } } }));
    app.get('/api/narration/:book', (req, res) => res.json({ bookId: req.params.book, voiceId: voice, inherited: false }));
    app.post('/api/narration/:book', async (req, res) => { await gateRequest('narration-save'); voice = req.body.voiceId; res.json({ bookId: req.params.book, voiceId: voice, inherited: false }); });
    app.get('/api/voices', (_req, res) => res.json({ current: 'edge:andrew', voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }, { id: 'edge:brian', name: 'Brian', provider: 'edge', gender: 'male' }] }));
    app.get('/api/library', (_req, res) => res.json({ books }));
    app.get('/api/book/:book', (req, res) => {
      const book = books.find(book => book.id === req.params.book);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      res.json({ book, chapters: book.id === 'd' ? [...chapters, ...chapters] : chapters });
    });
    app.get('/api/position/:book', async (req, res) => {
      await gateRequest(`position:${req.params.book}`); res.json({ position: null });
    });
    app.get('/api/chunks/:book/:chapter/status', (_req, res) => res.json({ servedTier: 'instant', voiceId: voice, status: 'ready' }));
    app.all('/api/chunks/:book/:chapter/:action', async (req, res) => { if (req.params.action === 'prepare') await gateRequest('voice-prepare'); await gateRequest(`prepare:${req.params.book}:${req.params.chapter}`); res.json({ voiceId: voice, targetStatus: 'ready', ready: true, status: 'ready', servedTier: 'instant', totalChunks: 1, readyChunks: 1 }); });
    app.get(['/api/audio/:book/:chapter', '/api/audio-continuous/:book/:chapter'], mediaRateLimit, async (req, res) => {
      if (finite && req.path.startsWith('/api/audio-continuous/')) return res.sendStatus(404);
      audioRequests.push(req.originalUrl);
      await gateRequest(`audio:${req.params.book}`);
      res.sendFile(audioPaths[req.params.book]);
    });
    app.all('/api/*path', (_req, res) => res.json({}));
    app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await (browserName === 'webkit' ? webkit : chromium).launch(browserName === 'webkit' ? {} : { args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    async function check(name, fn) {
      if (process.env.VOICE_SWITCH_CASE && !name.includes(process.env.VOICE_SWITCH_CASE)) return;
      finite = false; advances.length = 0; audioRequests.length = 0; gates.clear(); voice = 'edge:andrew';
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => localStorage.clear());
      const diagnostics = [];
      page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push(message.text()); });
      page.on('pageerror', error => diagnostics.push(error.message));
      try {
        const evidence = await fn(page);
        results.push({ name, passed: true, skipped: Boolean(evidence?.skipped), evidence });
        console.log(`${evidence?.skipped ? 'SKIP' : 'PASS'} ${name}`);
      } catch (error) {
        const evidence = await page.evaluate(() => ({ title: document.querySelector('#book-title')?.textContent, source: document.querySelector('#audio-player')?.currentSrc, paused: document.querySelector('#audio-player')?.paused })).catch(() => ({}));
        results.push({ name, passed: false, error: error.message, evidence, diagnostics }); console.error(`FAIL ${name}: ${error.message}\n${diagnostics.join('\n')}`);
      } finally {
        for (const item of allGates) item.release.resolve();
        await page.screenshot({ path: path.join(output, `${phase}-${results.length}.png`) });
        await page.close();
      }
    }
    async function open(page, book = 'a') {
      await page.goto(`${origin}/#/player/${book}`);
      await page.waitForSelector('#player-view.active');
    }
    async function ready(page, book) {
      await page.waitForFunction(book => {
        const audio = document.querySelector('#audio-player');
        return (audio.currentSrc.includes(`/api/audio-continuous/${book}/`) || audio.currentSrc.includes(`/api/audio/${book}/`)) && audio.readyState >= 3;
      }, book);
    }
    async function finish(page) {
      await page.locator('#play-pause-btn').click();
      await page.waitForFunction(() => document.querySelector('#audio-player').currentTime > .05);
      await page.evaluate(() => { const audio = document.querySelector('#audio-player'); audio.currentTime = audio.duration - .12; });
    }
    async function state(page) {
      return page.evaluate(() => { const a = document.querySelector('#audio-player'); return { title: document.querySelector('#book-title').textContent, source: a.currentSrc, paused: a.paused, time: window.xandrioPlaybackReport()?.position?.currentTime ?? a.currentTime, chapter: document.querySelector('#chapter-select').value }; });
    }
    async function chooseNarrator(page) {
      await page.locator('#player-voice-status').click();
      await page.locator('#player-voice-list [data-voice-id="edge:brian"] [data-voice-action="select"]').click();
    }
    async function playing(page) {
      await page.locator('#play-pause-btn').click();
      await page.waitForFunction(() => document.querySelector('#audio-player').currentTime > .1);
    }
    async function switched(page) {
      await page.waitForFunction(() => {
        const a = document.querySelector('#audio-player');
        return a.readyState >= 3 && a.currentSrc.includes('voiceId=edge%3Abrian');
      });
      await page.waitForTimeout(400);
    }
    await check('selecting the next chapter while playing continues playback', async page => {
      await open(page, 'd'); await ready(page, 'd'); await playing(page);
      await page.locator('#chapter-select').selectOption('1');
      await page.waitForFunction(() => document.querySelector('#audio-player').currentSrc.includes('/d/1'));
      await page.waitForTimeout(400); const after = await state(page);
      assert.equal(after.paused, false, JSON.stringify(after)); return after;
    });
    await check('pausing during narrator save stays paused after the new voice is ready', async page => {
      await open(page, 'd'); await ready(page, 'd'); await playing(page);
      const save = gate('narration-save'); await chooseNarrator(page); await hit(save);
      await page.evaluate(() => document.querySelector('#play-pause-btn').click());
      assert.equal((await state(page)).paused, true);
      save.release.resolve(); await switched(page);
      const after = await state(page);
      assert.equal(after.paused, true, JSON.stringify(after)); return after;
    });
    await check('lock-screen pause while replacement narrator audio loads stays paused', async page => {
      await page.addInitScript(() => {
        const media = navigator.mediaSession;
        if (!media?.setActionHandler) return;
        const original = media.setActionHandler;
        Object.defineProperty(media, 'setActionHandler', {
          configurable: true,
          value(action, handler) {
            (window.__mediaActions ||= {})[action] = handler;
            return original.call(this, action, handler);
          }
        });
      });
      await open(page, 'd'); await ready(page, 'd'); await playing(page);
      const preparation = gate('voice-prepare'); await chooseNarrator(page); await hit(preparation);
      const replacementAudio = gate('audio:d'); preparation.release.resolve(); await hit(replacementAudio);
      const during = await page.evaluate(() => ({
        buttonDisabled: document.querySelector('#play-pause-btn').disabled,
        buttonLabel: document.querySelector('#play-pause-btn').getAttribute('aria-label'),
        mediaPauseRegistered: typeof window.__mediaActions?.pause === 'function'
      }));
      assert.equal(during.buttonDisabled, true, JSON.stringify(during));
      if (!during.mediaPauseRegistered) {
        replacementAudio.release.resolve();
        return { skipped: 'Media Session pause action is unavailable in this browser', during };
      }
      await page.evaluate(() => window.__mediaActions.pause());
      replacementAudio.release.resolve(); await switched(page);
      const after = await state(page);
      assert.equal(after.paused, true, JSON.stringify({ during, after })); return { during, after };
    });
    await check('narrator preparation renders on phone and desktop', async page => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, 'd'); await ready(page, 'd');
      const preparation = gate('voice-prepare'); await chooseNarrator(page); await hit(preparation);
      const phone = path.join(output, `${phase}-preparing-phone.png`);
      const desktop = path.join(output, `${phase}-preparing-desktop.png`);
      await page.screenshot({ path: phone });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: desktop });
      preparation.release.resolve(); await switched(page);
      return { phone, desktop };
    });
    await check('a later chapter selection is not reloaded by an older narrator save', async page => {
      await open(page, 'd'); await ready(page, 'd');
      await page.evaluate(() => { document.querySelector('#audio-player').currentTime = 12; });
      const save = gate('narration-save'); await chooseNarrator(page); await hit(save);
      await page.evaluate(() => { const c = document.querySelector('#chapter-select'); c.value = '1'; c.dispatchEvent(new Event('change')); });
      await page.waitForFunction(() => document.querySelector('#audio-player').currentSrc.includes('/d/1'));
      const before = await state(page), countBefore = audioRequests.length;
      save.release.resolve(); await page.waitForTimeout(1200);
      const after = await state(page);
      assert.equal(after.chapter, '1'); assert(after.time < 1, JSON.stringify(after));
      assert.equal(audioRequests.length, countBefore, JSON.stringify(audioRequests));
      return { before, after, requestsAfterSave: audioRequests.length - countBefore };
    });
    await check('a pending chapter selection takes precedence over narrator preparation', async page => {
      await open(page, 'd'); await ready(page, 'd');
      const preparation = gate('voice-prepare'); await chooseNarrator(page); await hit(preparation);
      const save = gate('save:chapter-selection');
      await page.evaluate(() => { const c = document.querySelector('#chapter-select'); c.value = '1'; c.dispatchEvent(new Event('change')); });
      await hit(save); const countBefore = audioRequests.length;
      preparation.release.resolve(); await page.waitForTimeout(400);
      save.release.resolve();
      await page.waitForFunction(() => document.querySelector('#audio-player').currentSrc.includes('/d/1'));
      const after = await state(page);
      assert.equal(after.chapter, '1');
      assert(!audioRequests.slice(countBefore).some(url => url.includes('/d/0')), JSON.stringify(audioRequests));
      return { after, newRequests: audioRequests.slice(countBefore) };
    });
    await check('a seek made during narrator preparation is retained', async page => {
      await open(page, 'd'); await ready(page, 'd');
      await page.evaluate(() => { document.querySelector('#audio-player').currentTime = 3; });
      const preparation = gate('voice-prepare'); await chooseNarrator(page); await hit(preparation);
      await page.evaluate(() => { document.querySelector('#audio-player').currentTime = 18; });
      preparation.release.resolve(); await switched(page);
      const after = await state(page);
      assert(after.time >= 17.5, JSON.stringify(after)); assert.equal(after.paused, true); return after;
    });
    await check('continuous listening retains elapsed progress while the next narrator prepares', async page => {
      await open(page, 'd'); await ready(page, 'd'); await playing(page);
      const preparation = gate('voice-prepare'); await chooseNarrator(page); await hit(preparation);
      await page.waitForTimeout(1800); const before = await state(page);
      preparation.release.resolve(); await switched(page); const after = await state(page);
      const report = await page.evaluate(() => window.xandrioPlaybackReport());
      assert.equal(after.paused, false); assert(report.position.currentTime >= before.time - .3, JSON.stringify({before, after, report}));
      return {before, after, position: report.position};
    });
  } finally {
    for (const item of allGates) item.release.resolve();
    if (context) await context.tracing.stop({ path: path.join(output, `${phase}.trace.zip`) });
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({ browser: browserName, results }, null, 2));
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
