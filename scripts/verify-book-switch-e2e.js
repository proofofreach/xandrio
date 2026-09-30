// Failure modes: an outgoing load commits after a new title is selected;
// native controls resume the outgoing resource while the new position loads;
// rapid A → B → C switches leave B audible; a failed open loses A's resume point.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playback-processing');
const phase = process.env.BOOK_SWITCH_PHASE || 'book-switch';
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
  const books = ['a', 'b', 'c'].map(id => ({ id, title: `Book ${id.toUpperCase()}`, author: 'Fixture', chapterCount: 1, totalDuration: 30 }));
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
    const mediaRateLimit = rateLimit({ windowMs: 60_000, limit: 600 });
    app.get('/api/legal/operator-policy', (_req, res) => res.json({ version: 1, acknowledged: true, acknowledgedAt: '2026-09-30T00:00:00Z', unverifiedSourcesEnabled: false }));
    app.get('/api/voices', (_req, res) => res.json({ current: 'edge:andrew', voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }] }));
    app.get('/api/library', (_req, res) => res.json({ books }));
    app.get('/api/book/:book', (req, res) => {
      const book = books.find(book => book.id === req.params.book);
      if (!book) return res.status(404).json({ error: 'Book not found' });
      res.json({ book, chapters });
    });
    app.get('/api/position/:book', async (req, res) => {
      await gateRequest(`position:${req.params.book}`); res.json({ position: null });
    });
    app.get('/api/chunks/:book/:chapter/status', (_req, res) => res.json({ servedTier: 'instant', status: 'ready' }));
    app.all('/api/chunks/:book/:chapter/:action', (_req, res) => res.json({ ready: true, status: 'ready', servedTier: 'instant', totalChunks: 1, readyChunks: 1 }));
    app.get(['/api/audio/:book/:chapter', '/api/audio-continuous/:book/:chapter'], mediaRateLimit, async (req, res) => {
      await gateRequest(`audio:${req.params.book}`);
      res.sendFile(audioPaths[req.params.book]);
    });
    app.all('/api/*path', (_req, res) => res.json({}));
    app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    async function check(name, fn) {
      const page = await context.newPage();
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
        return audio.currentSrc.includes(`/api/audio-continuous/${book}/`) && audio.readyState >= 3;
      }, book);
    }
    await check('late outgoing load cannot reclaim the new book player', async page => {
      const oldAudio = gate('audio:a');
      await open(page); await hit(oldAudio);
      const newPosition = gate('position:b');
      await page.evaluate(() => { location.hash = '#/player/b'; }); await hit(newPosition);
      oldAudio.release.resolve();
      // Give the outgoing HTTP response time to finish before the incoming
      // position. This is the ordering that used to republish book A.
      await page.waitForTimeout(300);
      newPosition.release.resolve();
      await page.waitForTimeout(500);
      await page.locator('#play-pause-btn').click();
      await page.waitForTimeout(300);
      const state = await page.evaluate(() => {
        const audio = document.querySelector('#audio-player');
        return { title: document.querySelector('#book-title').textContent, source: audio.currentSrc, paused: audio.paused, time: audio.currentTime };
      });
      assert.equal(state.title, 'Book B');
      assert(state.source.includes('/api/audio-continuous/b/'), JSON.stringify(state));
      assert.equal(state.paused, false); assert(state.time > 0); return state;
    });
    await check('native resume cannot play outgoing audio under a new title', async page => {
      await open(page); await ready(page, 'a');
      await page.locator('#play-pause-btn').click();
      await page.waitForFunction(() => document.querySelector('#audio-player').currentTime > 0.15);
      const newPosition = gate('position:b');
      await page.evaluate(() => { location.hash = '#/player/b'; }); await hit(newPosition);
      await page.evaluate(() => { document.querySelector('#audio-player').play().catch(() => {}); });
      await page.waitForTimeout(200);
      const state = await page.evaluate(() => ({ title: document.querySelector('#book-title').textContent, attribute: document.querySelector('#audio-player').getAttribute('src'), time: document.querySelector('#audio-player').currentTime, readyState: document.querySelector('#audio-player').readyState }));
      // Chromium can retain currentSrc and set paused=false for a pending
      // play() with no resource. No media data or advancing time can remain.
      assert.equal(state.title, 'Book B'); assert.equal(state.attribute, null, JSON.stringify(state));
      assert.equal(state.readyState, 0, JSON.stringify(state)); assert.equal(state.time, 0);
      newPosition.release.resolve(); await ready(page, 'b'); return state;
    });
    await check('rapid switches play only the latest selected book', async page => {
      await open(page); await ready(page, 'a');
      const positionB = gate('position:b');
      await page.evaluate(() => { location.hash = '#/player/b'; }); await hit(positionB);
      await page.evaluate(() => { location.hash = '#/player/c'; }); await ready(page, 'c');
      positionB.release.resolve(); await page.waitForTimeout(200);
      await page.locator('#play-pause-btn').click(); await page.waitForTimeout(200);
      const state = await page.evaluate(() => ({ title: document.querySelector('#book-title').textContent, source: document.querySelector('#audio-player').currentSrc, paused: document.querySelector('#audio-player').paused }));
      assert.equal(state.title, 'Book C'); assert(state.source.includes('/api/audio-continuous/c/')); assert.equal(state.paused, false); return state;
    });
    await check('failed book selection preserves the outgoing resume point', async page => {
      await open(page); await ready(page, 'a');
      await page.evaluate(() => { document.querySelector('#audio-player').currentTime = 8; });
      await page.evaluate(() => { location.hash = '#/player/missing'; });
      await page.waitForTimeout(300);
      await page.locator('#play-pause-btn').click(); await page.waitForTimeout(200);
      const state = await page.evaluate(() => ({ title: document.querySelector('#book-title').textContent, source: document.querySelector('#audio-player').currentSrc, paused: document.querySelector('#audio-player').paused, time: document.querySelector('#audio-player').currentTime }));
      assert.equal(state.title, 'Book A'); assert(state.source.includes('/api/audio-continuous/a/')); assert.equal(state.paused, false); assert(state.time >= 8); return state;
    });
  } finally {
    for (const item of allGates) item.release.resolve();
    if (context) await context.tracing.stop({ path: path.join(output, `${phase}.trace.zip`) });
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({ results }, null, 2));
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
