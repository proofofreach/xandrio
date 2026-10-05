// Failures specified before production edits: delayed reset changes a newer book;
// save feedback reports a newer unsaved speed; rapid choices persist in response
// order; a failed save blocks a later choice; custom speeds skip adjacent presets;
// an old profile's late response changes the active book after switching profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium, webkit } = require('playwright');
const browserName = process.env.BOOK_SPEED_BROWSER || 'chromium';
const phase = process.env.BOOK_SPEED_PHASE || `after-${browserName}`;
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/general-reliability/book-speed');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function tone() {
  const rate = 8000, samples = rate * 30, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2);
  return bytes;
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-book-speed-'));
  let browser, context, server, nextGate = null;
  let settings = {}, requests = [], completed = [];
  const results = [], allGates = [];
  const books = ['a', 'b'].map(id => ({ id, title: `Book ${id.toUpperCase()}`, author: 'Fixture', chapterCount: 1, totalDuration: 30 }));
  function gate({ fail = false } = {}) { const g = { hit: deferred(), release: deferred(), fail }; nextGate = g; allGates.push(g); return g; }
  async function hit(g) {
    let timer;
    try { await Promise.race([g.hit.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Save request did not reach server')), 10000); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    const audioPath = path.join(temp, 'tone.wav'); await fs.writeFile(audioPath, tone());
    const app = express(); app.use(express.json());
    app.get('/api/auth/status', (_req, res) => res.json({ authenticationRequired: false, authenticated: true }));
    app.get('/api/sync/profile', (_req, res) => res.json({ profile: null }));
    app.post('/api/sync/profile', (_req, res) => res.json({ success: true, userId: 'profile_b', profile: { id: 'profile_b', name: 'Fixture', devices: [] } }));
    app.get('/api/legal/operator-policy', (_req, res) => res.json({ version: 1, acknowledged: true }));
    app.get('/api/engines/status', (_req, res) => res.json({ engines: { edge: { up: true, status: 'ready' } } }));
    app.get('/api/voices', (_req, res) => res.json({ current: 'edge:andrew', voices: [{ id: 'edge:andrew', name: 'Andrew', provider: 'edge', gender: 'male' }] }));
    app.get('/api/narration/:book', (req, res) => res.json({ bookId: req.params.book, voiceId: 'edge:andrew', inherited: false }));
    app.get('/api/library', (_req, res) => res.json({ books }));
    app.get('/api/book/:book', (req, res) => res.json({ book: books.find(book => book.id === req.params.book), chapters: [{ title: 'Chapter One', type: 'chapter', text: 'A deterministic narration fixture.', estimatedDuration: 30 }] }));
    app.get('/api/position/:book', (_req, res) => res.json({ position: null }));
    app.get('/api/listening-queue', (req, res) => res.json({ queue: { bookIds: [], autoContinue: true, bookSettings: req.get('X-Xandrio-User-Id') === 'profile_b' ? {} : settings }, books }));
    app.get('/api/listening-queue/books/:book/settings', (req, res) => res.json({ settings: req.get('X-Xandrio-User-Id') === 'profile_b' ? {} : settings[req.params.book] || {} }));
    app.put('/api/listening-queue/books/:book/settings', async (req, res) => {
      const g = nextGate; nextGate = null;
      const entry = { userId: req.get('X-Xandrio-User-Id') || 'default', bookId: req.params.book, settings: req.body.settings };
      requests.push(entry);
      if (g) { g.hit.resolve(); await g.release.promise; }
      if (g?.fail) { completed.push({ ...entry, failed: true }); return res.status(500).json({ error: 'Fixture save failed' }); }
      const updated = { ...settings[entry.bookId] };
      for (const [key, value] of Object.entries(entry.settings)) { if (value === null) delete updated[key]; else updated[key] = value; }
      settings[entry.bookId] = updated; completed.push(entry); res.json({ settings: updated });
    });
    app.get('/api/chunks/:book/:chapter/status', (_req, res) => res.json({ servedTier: 'instant', voiceId: 'edge:andrew', status: 'ready' }));
    app.all('/api/chunks/:book/:chapter/:action', (_req, res) => res.json({ voiceId: 'edge:andrew', targetStatus: 'ready', ready: true, status: 'ready', servedTier: 'instant', totalChunks: 1, readyChunks: 1 }));
    app.get(['/api/audio/:book/:chapter', '/api/audio-continuous/:book/:chapter'], (_req, res) => res.sendFile(audioPath));
    app.all('/api/*path', (_req, res) => res.json({})); app.use(express.static(path.join(root, 'public')));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await (browserName === 'webkit' ? webkit : chromium).launch(browserName === 'webkit' ? {} : { args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    async function state(page) {
      return page.evaluate(() => ({ title: document.querySelector('#book-title').textContent, rate: document.querySelector('#audio-player').playbackRate, speed: document.querySelector('#utility-speed-value').textContent, toast: document.querySelector('#success-toast').textContent, rewind: document.querySelector('[data-book-smart-rewind].active')?.dataset.bookSmartRewind, offline: document.querySelector('[data-book-rolling-offline].active')?.dataset.bookRollingOffline }));
    }
    async function check(name, fn) {
      if (process.env.BOOK_SPEED_CASE && !name.includes(process.env.BOOK_SPEED_CASE)) return;
      settings = { a: { playbackSpeed: 1.5 }, b: { playbackSpeed: 2 } }; requests = []; completed = []; nextGate = null;
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('xandrio_playback_speed', '1'); });
      const diagnostics = []; page.on('pageerror', e => diagnostics.push(e.message));
      try { const evidence = await fn(page); results.push({ name, passed: true, evidence, requests, completed, stored: structuredClone(settings), diagnostics }); console.log(`PASS ${name}`); }
      catch (e) { results.push({ name, passed: false, error: e.message, evidence: await state(page).catch(() => ({})), requests, completed, stored: structuredClone(settings), diagnostics }); console.error(`FAIL ${name}: ${e.message}`); }
      finally { for (const g of allGates) g.release.resolve(); await page.close(); }
    }
    async function open(page, book = 'a') {
      if (page.url() === 'about:blank') await page.goto(`${origin}/#/player/${book}`);
      else await page.evaluate(id => { location.hash = `#/player/${id}`; }, book);
      await page.waitForFunction(book => { const a = document.querySelector('#audio-player'); return a?.readyState >= 3 && a.currentSrc.includes(`/${book}/`) && document.querySelector('#book-title').textContent === `Book ${book.toUpperCase()}`; }, book);
    }
    async function sheet(page) { await page.locator('#speed-sheet-btn').click(); await page.locator('#speed-sheet.active').waitFor(); }
    async function saveSettled(page, count = 1) {
      await page.waitForResponse(r => r.url().includes('/api/listening-queue/books/') && r.request().method() === 'PUT');
      await page.waitForTimeout(180);
      assert(completed.length >= count, JSON.stringify(completed));
    }
    await check('a delayed reset cannot change the newly opened book', async page => {
      await open(page); await sheet(page); const g = gate();
      await page.locator('#clear-book-speed-btn').click(); await hit(g); await open(page, 'b');
      const before = await state(page), response = saveSettled(page); g.release.resolve(); await response;
      const after = await state(page); assert.equal(after.rate, 2, JSON.stringify({ before, after }));
      assert.equal(settings.a.playbackSpeed, undefined); assert.equal(settings.b.playbackSpeed, 2); return { before, after };
    });
    await check('a delayed save does not claim a newer unsaved speed', async page => {
      await open(page); await sheet(page); const g = gate();
      await page.locator('#set-book-speed-btn').click(); await hit(g);
      await page.locator('.speed-preset[data-speed="2"]').click(); const response = saveSettled(page); g.release.resolve(); await response;
      const after = await state(page); assert.equal(settings.a.playbackSpeed, 1.5); assert.equal(after.rate, 2);
      assert(!after.toast.includes('Using 2.00x for this book'), JSON.stringify(after)); return after;
    });
    await check('rapid rewind choices persist in click order', async page => {
      await open(page); await sheet(page); const g = gate();
      await page.locator('[data-book-smart-rewind="on"]').click(); await hit(g);
      await page.locator('[data-book-smart-rewind="off"]').click(); await page.waitForTimeout(250);
      const response = saveSettled(page); g.release.resolve(); await response;
      await page.waitForTimeout(250); const after = await state(page);
      assert.equal(settings.a.smartRewindEnabled, false, JSON.stringify({ after, requests, completed })); assert.equal(after.rewind, 'off'); return after;
    });
    await check('a newer book speed save supersedes a pending reset', async page => {
      await open(page); await sheet(page); const g = gate();
      await page.locator('#clear-book-speed-btn').click(); await hit(g);
      await page.locator('#set-book-speed-btn').click(); await page.waitForTimeout(250);
      const response = saveSettled(page); g.release.resolve(); await response; await page.waitForTimeout(250);
      const after = await state(page); assert.equal(settings.a.playbackSpeed, 1.5); assert.equal(after.rate, 1.5, JSON.stringify(after)); return after;
    });
    await check('queued book settings do not cross a sync profile switch', async page => {
      await open(page); await sheet(page); const g = gate();
      await page.locator('[data-book-smart-rewind="on"]').click(); await hit(g);
      await page.locator('[data-book-smart-rewind="off"]').click();
      await page.locator('#close-speed-sheet-btn').click();
      await page.evaluate(() => { location.hash = '#/settings/sync'; });
      await page.locator('#sync-profile-input').fill('Fixture'); await page.locator('#sync-start-btn').click();
      await page.waitForFunction(() => localStorage.getItem('xandrio_sync_user_id') === 'profile_b' && !document.querySelector('#sync-start-btn').disabled);
      const response = saveSettled(page); g.release.resolve(); await response; await page.waitForTimeout(250);
      assert.equal(requests.length, 1, JSON.stringify(requests));
      assert.equal(requests[0].userId, 'default');
      await page.evaluate(() => { location.hash = '#/player/a'; });
      await page.locator('#player-view.active').waitFor();
      await sheet(page);
      const after = await state(page);
      assert.equal(after.rewind, 'default', JSON.stringify(after));
      return { requests, completed, after };
    });
    await check('a failed book save allows the following setting to save', async page => {
      await open(page); await sheet(page); const g = gate({ fail: true });
      await page.locator('[data-book-rolling-offline="on"]').click(); await hit(g);
      await page.locator('[data-book-rolling-offline="off"]').click(); const response = saveSettled(page); g.release.resolve(); await response;
      await page.waitForTimeout(250); const after = await state(page);
      assert.equal(settings.a.rollingOfflineEnabled, false); assert.equal(after.offline, 'off'); return after;
    });
    await check('a current reset applies global speed and reports save failure', async page => {
      await open(page); await sheet(page); const g = gate({ fail: true });
      await page.locator('#clear-book-speed-btn').click(); await hit(g); let response = saveSettled(page); g.release.resolve(); await response;
      assert.equal((await state(page)).rate, 1.5); assert.equal((await state(page)).toast, 'Could not reset book speed');
      response = saveSettled(page); await page.locator('#clear-book-speed-btn').click(); await response;
      const after = await state(page); assert.equal(after.rate, 1); assert.equal(settings.a.playbackSpeed, undefined); return after;
    });
    await check('keyboard speed changes select the adjacent preset from a custom speed', async page => {
      await open(page); await sheet(page);
      await page.locator('#speed-stepper-down').click(); // 1.45x
      await page.keyboard.press('ArrowUp'); const up = await state(page); assert.equal(up.rate, 1.5, JSON.stringify(up));
      await page.locator('#speed-stepper-up').click(); // 1.55x
      await page.keyboard.press('ArrowDown'); const down = await state(page); assert.equal(down.rate, 1.5, JSON.stringify(down)); return { up, down };
    });
    await check('cycling above the last preset wraps to the first preset', async page => {
      await open(page); await sheet(page); await page.locator('.speed-preset[data-speed="2"]').click();
      await page.locator('#speed-stepper-up').click(); await page.locator('#close-speed-sheet-btn').click();
      await page.locator('#speed-btn').click(); const after = await state(page); assert.equal(after.rate, .8, JSON.stringify(after)); return after;
    });
  } finally {
    for (const g of allGates) g.release.resolve();
    if (context) await context.tracing.stop({ path: path.join(output, `${phase}.trace.zip`) });
    if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({ browser: browserName, results }, null, 2));
  }
  if (results.some(r => !r.passed)) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
