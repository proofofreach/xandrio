// Failure cases defined before implementation: Play stays clickable during preparation;
// finite chapter completion does not resume; a delayed completion save or queue
// response steals a newer selection; duplicate ended advances twice; sleep timer
// completion pauses a newly selected book. All playback uses native audio.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const browserName = process.env.APP_LIFECYCLE_BROWSER || 'chromium';

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/deep-reliability/app');
const phase = process.env.APP_LIFECYCLE_PHASE || `app-lifecycle-${browserName}`;
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
  let finite = false; const advances = [];
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
    app.get('/api/voices', (_req, res) => res.json({ current: 'edge:andrew', voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }] }));
    app.get('/api/library', (_req, res) => res.json({ books }));
    app.get('/api/book/:book', (req, res) => {
      const book = books.find(book => book.id === req.params.book);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      res.json({ book, chapters: book.id === 'd' ? [...chapters, ...chapters] : chapters });
    });
    app.get('/api/position/:book', async (req, res) => {
      await gateRequest(`position:${req.params.book}`); res.json({ position: null });
    });
    app.get('/api/chunks/:book/:chapter/status', (_req, res) => res.json({ servedTier: 'instant', status: 'ready' }));
    app.all('/api/chunks/:book/:chapter/:action', async (req, res) => { await gateRequest(`prepare:${req.params.book}:${req.params.chapter}`); res.json({ ready: true, status: 'ready', servedTier: 'instant', totalChunks: 1, readyChunks: 1 }); });
    app.get(['/api/audio/:book/:chapter', '/api/audio-continuous/:book/:chapter'], mediaRateLimit, async (req, res) => {
      if (finite && req.path.startsWith('/api/audio-continuous/')) return res.sendStatus(404);
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
      finite = false; advances.length = 0; gates.clear();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => localStorage.clear());
      const diagnostics = [];
      page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push(message.text()); });
      page.on('pageerror', error => diagnostics.push(error.message));
      try {
        const evidence = await fn(page);
        results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`);
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
      return page.evaluate(() => { const a = document.querySelector('#audio-player'); return { title: document.querySelector('#book-title').textContent, source: a.currentSrc, paused: a.paused, time: a.currentTime, chapter: document.querySelector('#chapter-select').value }; });
    }
    await check('main and mini Play are visibly busy during preparation and usable when ready', async page => {
      const preparation = gate('prepare:a:0');
      await open(page); await hit(preparation);
      const busy = await page.evaluate(() => ['play-pause-btn', 'mini-player-play'].map(id => { const b = document.getElementById(id); b.click(); return { id, disabled: b.disabled, busy: b.getAttribute('aria-busy'), label: b.getAttribute('aria-label') }; }));
      for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: path.join(output, `${phase}-${name}-preparing.png`), fullPage: true });
      }
      preparation.release.resolve(); await ready(page, 'a');
      for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: path.join(output, `${phase}-${name}-ready.png`), fullPage: true });
      }
      await page.locator('#play-pause-btn').focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('#audio-player').currentTime > .05);
      const playing = await state(page);
      assert(busy.every(b => b.disabled && b.busy === 'true' && /prepar/i.test(b.label)), JSON.stringify(busy));
      assert.equal(playing.paused, false);
      await page.keyboard.press('Space');
      assert.equal(await page.locator('#play-pause-btn').isEnabled(), true);
      assert.equal((await state(page)).paused, true);
      return { busy, playing, keyboardPause: true };
    });
    await check('chapter selection intent fences stale Play while position save waits', async page => {
      await open(page, 'd'); await ready(page, 'd');
      const save = gate('save:chapter-selection');
      await page.locator('#chapter-select').selectOption('1');
      await hit(save);
      const during = await page.evaluate(() => {
        const audio = document.querySelector('#audio-player');
        const controls = ['play-pause-btn', 'mini-player-play'].map(id => {
          const button = document.getElementById(id);
          return { id, disabled: button.disabled, busy: button.getAttribute('aria-busy'), label: button.getAttribute('aria-label') };
        });
        document.getElementById('play-pause-btn').click();
        return { controls, paused: audio.paused, source: audio.currentSrc };
      });
      await page.waitForTimeout(200);
      const afterTap = await state(page);
      save.release.resolve(); await page.waitForFunction(() => document.querySelector('#chapter-select').value === '1');
      assert(during.controls.every(control => control.disabled && control.busy === 'true'), JSON.stringify(during));
      assert.equal(afterTap.paused, true, JSON.stringify(afterTap));
      return { during, afterTap };
    });
    await check('preparation failure releases busy controls and Retry loads playable audio', async page => {
      const target = '**/api/chunks/a/0/prepare-chapter-audio*';
      await page.route(target, route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture preparation failed' }) }));
      await open(page);
      await page.waitForFunction(() => document.querySelector('#audio-loading').dataset.status === 'error');
      await page.waitForFunction(() => !document.querySelector('#play-pause-btn').disabled);
      assert.equal(await page.locator('#mini-player-play').isEnabled(), true);
      await page.unroute(target);
      await page.locator('#audio-loading-actions button').filter({ hasText: 'Try again' }).click();
      await ready(page, 'a'); await page.locator('#play-pause-btn').click();
      await page.waitForFunction(() => document.querySelector('#audio-player').currentTime > .05);
      return state(page);
    });
    await check('finite chapter advances and plays when no prewarm exists', async page => {
      finite = true;
      await page.route('**/api/audio/d/1*', route => ['fetch', 'xhr'].includes(route.request().resourceType()) ? route.abort() : route.continue());
      await open(page, 'd'); await ready(page, 'd'); await finish(page);
      await page.waitForFunction(() => document.querySelector('#audio-player').currentSrc.includes('/api/audio/d/1'));
      await page.waitForTimeout(500);
      const result = await state(page); assert.equal(result.paused, false); assert(result.time > .05); return result;
    });
    await check('Pause at pending chapter boundary cancels automatic continuation', async page => {
      finite = true;
      await open(page, 'd'); await ready(page, 'd');
      const prewarm = gate('audio:d');
      await finish(page);
      await hit(prewarm);
      await page.waitForFunction(() => document.querySelector('#audio-player').ended);
      await page.locator('#play-pause-btn').click();
      prewarm.release.resolve();
      await page.waitForTimeout(450);
      const result = await state(page);
      const label = await page.locator('#play-pause-btn').getAttribute('aria-label');
      assert.equal(result.paused, true, JSON.stringify(result));
      assert(result.source.includes('/api/audio/d/0'), JSON.stringify(result));
      assert.equal(label, 'Play');
      return { ...result, label };
    });
    await check('late completion save cannot advance the newly selected book', async page => {
      const save = gate('save:a'); await open(page); await ready(page, 'a'); await finish(page); await hit(save);
      await page.evaluate(() => { location.hash = '#/player/b'; }); await ready(page, 'b');
      save.release.resolve(); await page.waitForTimeout(400);
      const result = await state(page); assert.equal(result.title, 'Book B'); assert.deepEqual(advances, []); return { ...result, advances: [...advances] };
    });
    await check('late queue response cannot reopen over a newer selection', async page => {
      const advance = gate('advance'); await open(page); await ready(page, 'a'); await finish(page); await hit(advance);
      await page.evaluate(() => { location.hash = '#/player/b'; }); await ready(page, 'b');
      advance.release.resolve(); await page.waitForTimeout(400);
      const result = await state(page); assert.equal(result.title, 'Book B'); return result;
    });
    await check('duplicate ended notifications advance the queue once', async page => {
      const save = gate('save:a'); await open(page); await ready(page, 'a'); await finish(page); await hit(save);
      await page.evaluate(() => document.querySelector('#audio-player').dispatchEvent(new Event('ended')));
      save.release.resolve(); await page.waitForTimeout(500);
      assert.deepEqual(advances, ['a']); return { advances: [...advances], state: await state(page) };
    });
    await check('sleep timer completion cannot pause a newly selected book', async page => {
      finite = true;
      await page.addInitScript(() => { localStorage.setItem('xandrio_sleep_timer_mode', 'chapter'); localStorage.setItem('xandrio_sleep_timer_chapter_target', JSON.stringify({ bookId: 'a', chapterIndex: 0 })); });
      const save = gate('save:a'); await open(page); await ready(page, 'a'); await finish(page); await hit(save);
      await page.evaluate(() => { location.hash = '#/player/b'; }); await ready(page, 'b');
      await page.locator('#play-pause-btn').click();
      save.release.resolve(); await page.waitForTimeout(400);
      const result = await state(page); assert.equal(result.title, 'Book B'); assert.equal(result.paused, false); assert.deepEqual(advances, []); return result;
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
