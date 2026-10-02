// Failure cases are recorded before implementation in docs/plans/narration-preparation-ux.md.
// Real app + browser; only the external speech service is deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/narration-workflow');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
(async () => {
  await fs.mkdir(output, { recursive: true });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-narration-workflow-'));
  await fs.mkdir(path.join(data, 'cache'));
  const books = {};
  for (const [id, title] of [['narration-a', 'The Quiet City'], ['narration-b', 'Along the River'],
    ['narration-c', 'The Long Walk'], ['narration-d', 'Before Sunrise'], ['narration-e', 'Quiet Hills'], ['narration-f', 'Short Dialogue']]) {
    const bookPath = path.join(data, 'cache', `${id}.xbook.json`);
    const chapters = ['First', 'Second', 'Third', 'Fourth'].map((name, index) => ({
      title: `${name} chapter`, id: `${id}-${index}`, type: 'chapter', estimatedDuration: 30,
      text: `${name} chapter of ${title}. The rain stopped before dawn. Elena opened the window and listened to the quiet street. A bird sang in the garden.`
    }));
    if (id === 'narration-f') chapters[0].text = '“No.”\n\nThe little rabbit went home and sat under a tree. He watched the birds and waited for his mother to come back from the garden.';
    await fs.writeFile(bookPath, JSON.stringify({ _xbookVersion: 2, metadata: { title, language: 'en' }, chapters }));
    books[id] = { id, title, author: 'Mira Reed', path: bookPath, language: 'en', chapterCount: 4 };
  }
  await fs.writeFile(path.join(data, 'books.json'), JSON.stringify(books));
  await fs.writeFile(path.join(data, 'shelves.json'), JSON.stringify({ users: { default: { books: Object.fromEntries(Object.keys(books).map(id => [id, { addedAt: new Date().toISOString() }])) } } }));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ voice: 'kokoro:af_heart', premiumPrepEnabled: false,
    operatorPolicy: { version: 1, acknowledgedAt: new Date().toISOString(), unverifiedSourcesEnabled: false } }));
  // Delay one real text-preparation await, before its manifest exists. The
  // application and speech path remain real; files make the overlap repeatable.
  const preloadPath = path.join(data, 'pre-manifest-delay.cjs');
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const ChunkedTTS = require(${JSON.stringify(path.join(root, 'lib/chunked-tts'))});
    const base = ${JSON.stringify(data)};
    const originalGenerate = ChunkedTTS.prototype._generateChapter;
    ChunkedTTS.prototype._generateChapter = async function(bookId, index, text, language, priority, options) {
      if (bookId === 'narration-d' && index === 0 && options.origin === 'premium-prep') this.delayNarrationFixture = true;
      try { return await originalGenerate.call(this, bookId, index, text, language, priority, options); }
      finally { this.delayNarrationFixture = false; }
    };
    const originalText = ChunkedTTS.prototype._narrationText;
    ChunkedTTS.prototype._narrationText = async function(text, bookId, index, language) {
      if (bookId === 'narration-d' && index === 0 && this.delayNarrationFixture) {
        await fs.writeFile(path.join(base, 'before-manifest'), 'entered');
        while (await fs.access(path.join(base, 'release-manifest')).then(() => false, () => true))
          await new Promise(resolve => setTimeout(resolve, 20));
      }
      return originalText.call(this, text, bookId, index, language);
    };
    const originalClaim = ChunkedTTS.prototype.claimChapter;
    ChunkedTTS.prototype.claimChapter = async function(bookId, index, activity, ...rest) {
      if (bookId === 'narration-d' && index === 0 && activity.origin === 'playback-current' && !this.getChapterManifest(bookId, index))
        await fs.writeFile(path.join(base, 'foreground-before-manifest'), 'joined');
      return originalClaim.call(this, bookId, index, activity, ...rest);
    };
  `);
  const wav = await fs.readFile(path.join(root, 'tts-benchmark-samples/kokoro-af-heart.wav'));
  const calls = [];
  let active = 0, peak = 0, online = true, hold = false, child, origin, log = '';
  const held = new Set();
  const service = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.writeHead(online ? 200 : 503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: online, device: 'cpu' })); }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); calls.push(payload); active++; peak = Math.max(peak, active);
    try {
      if (hold && payload.text.includes('Second chapter')) await new Promise(resolve => {
        const release = () => { held.delete(release); resolve(); }; held.add(release); res.once('close', release);
      });
      await delay(100);
      if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav); }
    } finally { active--; }
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  const engineUrl = `http://127.0.0.1:${service.address().port}`;
  async function stop(abrupt = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(abrupt ? 'SIGKILL' : 'SIGTERM');
    await Promise.race([exited, delay(2500)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  async function start(nanoEnabled = true) {
    await stop();
    const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, CACHE_DIR: path.join(data, 'cache'),
      XANDRIO_TOKEN: 'narration-e2e-token', XANDRIO_VOICE_PROVIDERS: 'kokoro,moss-nano',
      MOSS_NANO_ENABLED: String(nanoEnabled), MOSS_NANO_AUTO_START: 'false', MOSS_NANO_TTS_URL: engineUrl,
      KOKORO_AUTO_START: 'false', CHATTERBOX_AUTO_START: 'false', KOKORO_TTS_URL: engineUrl,
      XANDRIO_RATE_LIMIT_DISABLED: 'true'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
    await until(async () => { try { return (await request('/api/voices')).ok; } catch { return false; } }, 'app startup');
  }
  function request(route, options = {}) {
    return fetch(origin + route, { ...options, headers: { Authorization: 'Bearer narration-e2e-token', 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: options.signal || AbortSignal.timeout(20000) });
  }
  const json = async (route, options) => { const res = await request(route, options); assert(res.ok, `${route}: ${res.status} ${await (!res.ok ? res.text() : Promise.resolve(''))}`); return res.json(); };
  const post = (route, value) => json(route, { method: 'POST', body: JSON.stringify(value) });
  async function until(probe, label) { for (let i = 0; i < 160; i++) { const result = await probe(); if (result) return result; await delay(100); } throw new Error(`Timed out: ${label}`); }
  async function check(name, run) { try { const evidence = await run(); results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); } }
  const status = (id = 'narration-a', query = '') => json(`/api/premium-prep/${id}/status${query}`);
  try {
    await start();
    await check('book narrator choices are independent and default to waiting', async () => {
      await post('/api/narration/narration-a', { voiceId: 'moss-nano:Nathan' });
      await post('/api/narration/narration-b', { voiceId: 'moss-nano:Bella' });
      const a = await json('/api/narration/narration-a'), b = await json('/api/narration/narration-b');
      assert.equal(a.voiceId, 'moss-nano:Nathan'); assert.equal(b.voiceId, 'moss-nano:Bella');
      assert.equal(a.fallbackPolicy, 'wait'); assert.equal((await json('/api/voices')).current, 'kokoro:af_heart');
      assert.equal((await request('/api/narration/missing', { method: 'POST', body: JSON.stringify({ voiceId: 'moss-nano:Nathan' }) })).status, 404);
      assert.equal((await request('/api/narration/narration-a', { method: 'POST', body: JSON.stringify({ fallbackPolicy: 'maybe' }) })).status, 400);
    });
    await check('explicit fallback choice routes and labels the actual narrator', async () => {
      const waiting = await json('/api/chunks/narration-a/1/chapter-audio-status');
      assert.equal(waiting.servedTier, 'premium'); assert.equal(waiting.voiceId, 'moss-nano:Nathan');
      await post('/api/narration/narration-a', { fallbackPolicy: 'instant' });
      const fallback = await json('/api/chunks/narration-a/1/chapter-audio-status');
      assert.equal(fallback.servedTier, 'instant'); assert(fallback.voiceId.startsWith('kokoro:'));
      await post('/api/narration/narration-a', { fallbackPolicy: 'wait' });
      return { preparedVoice: waiting.voiceId, fallbackVoice: fallback.voiceId };
    });
    await check('chapter routes preserve concurrent book narrators and reveal a middle gap', async () => {
      const before = calls.length;
      await Promise.all(['/api/audio/narration-a/0?tier=premium', '/api/audio/narration-a/2?tier=premium', '/api/audio/narration-b/0?tier=premium'].map(async route => {
        const response = await request(route); assert.equal(response.status, 200); assert((await response.arrayBuffer()).byteLength > 1000);
      }));
      const added = calls.slice(before); assert(added.some(c => c.voice === 'Nathan')); assert(added.some(c => c.voice === 'Bella')); assert.equal(peak, 1);
      const one = await status('narration-a', '?chapterIndex=0&offsetSeconds=0&speed=1');
      const two = await status('narration-a', '?chapterIndex=0&offsetSeconds=0&speed=2');
      const gap = await status('narration-a', '?chapterIndex=1&offsetSeconds=0&speed=1');
      assert.deepEqual(one.chapters, [true, false, true, false]); assert.equal(one.firstUnreadyChapter, 1);
      assert(one.readyAudioSeconds > 0 && one.readyAudioSeconds < 90);
      assert(Math.abs(two.readyListeningSeconds * 2 - one.readyListeningSeconds) < 0.01);
      assert.equal(gap.readyAudioSeconds, 0);
      return { at1x: one.readyListeningSeconds, at2x: two.readyListeningSeconds, firstGap: one.firstUnreadyChapter };
    });
    await check('library default changes and restart preserve explicit book choices', async () => {
      await post('/api/voice', { voiceId: 'kokoro:am_michael' }); await start();
      assert.equal((await json('/api/narration/narration-a')).voiceId, 'moss-nano:Nathan');
      assert.equal((await json('/api/narration/narration-b')).voiceId, 'moss-nano:Bella');
      assert.equal((await json('/api/voices')).current, 'kokoro:am_michael');
      assert.deepEqual((await status()).chapters, [true, false, true, false]);
    });
    await check('pause is durable, visible, and cannot be undone by opening a chapter', async () => {
      hold = true; await post('/api/premium-prep/settings', { enabled: true });
      await post('/api/premium-prep/narration-a/start', { fromChapter: 1 });
      await until(() => held.size > 0, 'second chapter generating');
      await post('/api/premium-prep/narration-a/pause', {});
      await until(async () => (await status()).status === 'userPaused', 'paused status');
      const queue = await json('/api/queue/status');
      assert(queue.books.some(b => b.id === 'narration-a' && b.preparationStatus === 'userPaused'));
      await stop(true); await start(); const count = calls.length;
      await json('/api/chunks/narration-a/1/chapter-audio-status'); await delay(500);
      assert.equal((await status()).status, 'userPaused'); assert.equal(calls.length, count);
      assert.deepEqual((await status()).chapters, [true, false, true, false]);
      return { pausedVisible: true, callsAfterRestart: calls.length - count };
    });
    await check('foreground playback survives a background pause and resume completes missing work', async () => {
      await post('/api/premium-prep/narration-a/resume', {});
      await until(() => held.size > 0, 'resumed background owns chapter');
      const foreground = request('/api/audio/narration-a/1');
      await delay(250);
      await post('/api/premium-prep/narration-a/pause', {});
      hold = false; for (const release of held) release();
      const response = await foreground; assert.equal(response.status, 200); await response.arrayBuffer();
      assert.equal((await status()).status, 'userPaused');
      await post('/api/premium-prep/narration-a/resume', {});
      await until(async () => (await status()).status === 'ready', 'all prepared');
      assert.deepEqual((await status()).chapters, [true, true, true, true]);
      return { complete: true, peakConcurrentInference: peak };
    });
    await check('off/on toggles retire the old run and disabled resume preserves a paused job', async () => {
      hold = true;
      await post('/api/premium-prep/narration-b/start', { fromChapter: 1 });
      await until(() => held.size > 0, 'background run held');
      await post('/api/premium-prep/settings', { enabled: false });
      await post('/api/premium-prep/settings', { enabled: true });
      await until(() => held.size > 0, 'replacement run held');
      await post('/api/premium-prep/narration-b/pause', {});
      hold = false; for (const release of held) release();
      await post('/api/premium-prep/settings', { enabled: false });
      await post('/api/premium-prep/narration-b/resume', {});
      assert.equal((await status('narration-b')).status, 'userPaused');
      const count = calls.length; await delay(600);
      assert.equal(calls.length, count);
    });
    await check('an in-flight request keeps its narrator while book preferences change', async () => {
      await post('/api/premium-prep/settings', { enabled: false });
      hold = true;
      const inFlight = request('/api/audio/narration-b/1');
      await until(() => held.size > 0, 'held Bella request');
      await post('/api/narration/narration-b', { voiceId: 'moss-nano:Nathan', fallbackPolicy: 'instant' });
      hold = false; for (const release of held) release();
      const response = await inFlight; assert.equal(response.status, 200); await response.arrayBuffer();
      assert.equal(response.headers.get('x-voice-id'), 'moss-nano:Bella');
      const changed = await status('narration-b');
      assert.deepEqual(changed.chapters, [false, false, false, false]); assert.equal(changed.readyAudioSeconds, 0);
      const fallback = await request('/api/audio/narration-b/0'); assert.equal(fallback.status, 200); await fallback.arrayBuffer();
      assert(fallback.headers.get('x-voice-id').startsWith('kokoro:'));
      await post('/api/narration/narration-b', { voiceId: 'moss-nano:Bella', fallbackPolicy: 'wait' });
    });
    await check('continuous playback keeps one narrator across a preference change', async () => {
      await post('/api/narration/narration-c', { voiceId: 'moss-nano:Nathan' });
      const first = await request('/api/audio/narration-c/0'); await first.arrayBuffer();
      hold = true;
      const before = calls.length;
      const stream = request('/api/audio-continuous/narration-c/0?endChapter=1', { signal: AbortSignal.timeout(60000) });
      await until(() => held.size > 0, 'continuous second chapter');
      await post('/api/narration/narration-c', { voiceId: 'moss-nano:Bella', fallbackPolicy: 'instant' });
      hold = false; for (const release of held) release();
      const response = await stream;
      assert.equal(response.status, 200); assert.equal(response.headers.get('x-voice-id'), 'moss-nano:Nathan');
      assert((await response.arrayBuffer()).byteLength > 1000);
      assert(calls.slice(before).every(call => call.voice === 'Nathan'));
    });
    await check('pause preserves a foreground owner that joins before the manifest exists', async () => {
      await post('/api/premium-prep/settings', { enabled: true });
      await post('/api/narration/narration-d', { voiceId: 'moss-nano:Nathan' });
      await until(() => fs.access(path.join(data, 'before-manifest')).then(() => true, () => false), 'pre-manifest delay');
      const foreground = request('/api/audio/narration-d/0');
      foreground.catch(() => {});
      await until(() => fs.access(path.join(data, 'foreground-before-manifest')).then(() => true, () => false), 'foreground joined before manifest');
      await post('/api/premium-prep/narration-d/pause', {});
      await fs.writeFile(path.join(data, 'release-manifest'), 'resume');
      const response = await foreground; assert.equal(response.status, 200); await response.arrayBuffer();
      assert.equal((await status('narration-d')).status, 'userPaused');
      const before = calls.length;
      await post('/api/narration/narration-d', { voiceId: 'moss-nano:Bella' });
      await delay(300);
      assert.equal((await status('narration-d')).status, 'userPaused');
      assert.equal(calls.length, before, 'narrator change must keep manual pause');
    });
    await check('short Nano dialogue survives the complete pipeline without merging paragraphs', async () => {
      await post('/api/premium-prep/settings', { enabled: false });
      await post('/api/narration/narration-f', { voiceId: 'moss-nano:Nathan' });
      const count = calls.length;
      const response = await request('/api/audio/narration-f/0');
      assert.equal(response.status, 200); await response.arrayBuffer();
      const added = calls.slice(count);
      assert(added.some(call => call.text.includes('No') && call.text.length < 20));
      assert(added.some(call => call.text.startsWith('The little rabbit')));
      assert(added.every(call => call.text.length <= 160 && !call.text.includes('\n\n')));
    });
    await check('separate accounts cannot view or control another library job', async () => {
      await post('/api/accounts', { username: 'listener-one', password: 'temporary-e2e-password', role: 'member' });
      await post('/api/accounts', { username: 'listener-two', password: 'temporary-e2e-password', role: 'member' });
      const login = async username => {
        const res = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password: 'temporary-e2e-password' }) });
        assert.equal(res.status, 200); return res.headers.get('set-cookie').split(';')[0];
      };
      const ownerCookie = await login('listener-one'), strangerCookie = await login('listener-two');
      const asAccount = (cookie, route, method = 'GET') => fetch(origin + route, { method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal((await asAccount(ownerCookie, '/api/shelf/narration-d', 'POST')).status, 200);
      assert.equal((await asAccount(ownerCookie, '/api/narration/narration-d')).status, 200);
      const hidden = await asAccount(strangerCookie, '/api/queue/status').then(res => res.json());
      assert(!hidden.books.some(book => book.id === 'narration-d'));
      for (const [route, method] of [['/api/narration/narration-d', 'GET'], ['/api/premium-prep/narration-d/status', 'GET'],
        ['/api/premium-prep/narration-d/pause', 'POST'], ['/api/premium-prep/narration-d/resume', 'POST']]) {
        assert.equal((await asAccount(strangerCookie, route, method)).status, 403, route);
      }
    });
    await check('restart retires stale narrator intent and preserves unrelated durable claims', async () => {
      await post('/api/premium-prep/settings', { enabled: false });
      await post('/api/narration/narration-b', { voiceId: 'moss-nano:Nathan' });
      const old = await status('narration-b');
      await stop(true);
      const settingsPath = path.join(data, 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath));
      settings.bookNarration['narration-b'].voiceId = 'moss-nano:Bella';
      await fs.writeFile(settingsPath, JSON.stringify(settings));
      const GenerationJournal = require('../lib/generation-journal');
      const journal = new GenerationJournal(path.join(data, 'generation-state.json'));
      await journal.selectPremium({ bookId: 'narration-b', variantKey: old.variantKey, voiceId: old.voiceId,
        jobId: 'stale-book-job', desiredState: 'running', fromChapter: 2 });
      const chapter = { bookId: 'narration-b', chapterIndex: 2, variantKey: old.variantKey,
        text: 'A stale background chapter must not restart.', voice: old.voiceId, chunkSize: 160,
        origin: 'premium-prep', requestId: 'stale-book-job', priority: 'background' };
      await journal.putChapter(chapter);
      const shared = { ...chapter, chapterIndex: 3 };
      await journal.putChapter(shared);
      await journal.addChapterClaim({ ...shared, origin: 'offline-download', requestId: 'retained-download', priority: 'download' });
      await journal.recordChapterFailure(shared.bookId, shared.chapterIndex, shared.variantKey, { error: 'fixture quarantine', permanent: true });
      const before = calls.length;
      await start(); await delay(500);
      assert.equal(calls.length, before, 'stale background must make zero speech calls');
      const persisted = JSON.parse(await fs.readFile(path.join(data, 'generation-state.json')));
      assert(!Object.values(persisted.jobs).some(job => job.jobId === 'stale-book-job'));
      const retained = Object.values(persisted.quarantinedChapterJobs).find(job => job.requestId === 'retained-download');
      assert(retained); assert.equal(retained.claims.length, 1); assert.equal(retained.claims[0].origin, 'offline-download');
    });
    await check('a crash between narrator preference and job selection preserves manual pause', async () => {
      const old = await status('narration-d');
      await stop(true);
      const settingsPath = path.join(data, 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsPath));
      settings.bookNarration['narration-d'].voiceId = 'moss-nano:Nathan';
      settings.premiumPrepEnabled = true;
      await fs.writeFile(settingsPath, JSON.stringify(settings));
      const GenerationJournal = require('../lib/generation-journal');
      const journal = new GenerationJournal(path.join(data, 'generation-state.json'));
      await journal.selectPremium({ bookId: 'narration-d', variantKey: old.variantKey, voiceId: old.voiceId,
        jobId: 'paused-before-choice', desiredState: 'paused', status: 'userPaused', fromChapter: 1 });
      const before = calls.length;
      await start(); await delay(500);
      assert.equal((await status('narration-d')).voiceId, 'moss-nano:Nathan');
      assert.equal((await status('narration-d')).status, 'userPaused');
      assert.equal(calls.length, before);
      const persisted = JSON.parse(await fs.readFile(path.join(data, 'generation-state.json')));
      const selected = Object.values(persisted.jobs).find(job => job.bookId === 'narration-d');
      assert.equal(selected.voiceId, 'moss-nano:Nathan'); assert.equal(selected.desiredState, 'paused');
      assert.notEqual(selected.jobId, 'paused-before-choice');
    });
    await check('desktop and phone pickers support keyboard selection and truthful preparation states', async () => {
      const browser = await chromium.launch();
      const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { Authorization: 'Bearer narration-e2e-token' } });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/#/settings/voice`);
        await page.locator('.voice-settings-filters summary').click();
        await page.locator('#voice-filter-bar [data-voice-filter="provider"]').selectOption('moss-nano');
        const select = page.locator('#voice-list [data-voice-id="moss-nano:Adam"] [data-voice-action="select"]');
        assert.equal(await select.evaluate(el => el.tagName), 'BUTTON'); await select.focus(); await page.keyboard.press('Enter');
        await until(async () => (await json('/api/voices')).current === 'moss-nano:Adam', 'keyboard default selection');
        assert.equal((await json('/api/narration/narration-a')).voiceId, 'moss-nano:Nathan');
        await page.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
        await page.goto(`${origin}/#/library`);
        await page.locator('#queue-status').click();
        const resume = page.locator('[data-narration-book="narration-d"][data-narration-action="resume"]');
        await resume.waitFor();
        hold = true;
        await resume.click();
        await until(() => held.size > 0, 'Activity resumes paused book');
        await page.locator('[data-narration-book="narration-d"][data-narration-action="pause"]').click();
        await until(async () => (await status('narration-d')).status === 'userPaused', 'Activity pauses book');
        await resume.waitFor();
        await page.screenshot({ path: path.join(output, 'activity-paused-desktop.png'), fullPage: true });
        hold = false; for (const release of held) release();
        await page.keyboard.press('Escape');
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
          await page.goto(`${origin}/#/player/narration-a`);
          await page.locator('#player-voice-status').click();
          await page.locator('#voice-sheet').waitFor({ state: 'visible' });
          assert((await page.locator('#voice-sheet').innerText()).includes('this book'));
          await page.keyboard.press('Escape');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          const targets = await page.locator('#hq-voice-prep button:visible').evaluateAll(elements => elements.map(el => ({ text: el.textContent, height: el.getBoundingClientRect().height })));
          assert(targets.every(target => target.height >= 45), JSON.stringify(targets));
          await page.screenshot({ path: path.join(output, `player-${width}.png`), fullPage: true });
        }
        await post('/api/premium-prep/settings', { enabled: false });
        await page.locator('#player-voice-status').click();
        await until(async () => await page.locator('#voice-sheet').getAttribute('aria-busy') !== 'true', 'voice choices loaded');
        await page.locator('#voice-sheet-search-input').fill('Bella');
        const bookSelect = page.locator('#player-voice-list [data-voice-id="moss-nano:Bella"] [data-voice-action="select"]').first();
        await bookSelect.focus(); await page.keyboard.press('Enter');
        await until(async () => (await json('/api/narration/narration-a')).voiceId === 'moss-nano:Bella', 'keyboard book selection');
        assert.equal((await json('/api/voices')).current, 'moss-nano:Adam');
        await page.keyboard.press('Escape');
        await page.locator('#narration-fallback').selectOption('instant');
        await until(async () => (await json('/api/narration/narration-a')).fallbackPolicy === 'instant', 'fallback choice saved');
        await post('/api/narration/narration-e', { voiceId: 'moss-nano:Bella', fallbackPolicy: 'instant' });
        await page.goto(`${origin}/#/player/narration-e`);
        await page.locator('#play-pause-btn').click();
        await until(async () => (await page.locator('#player-voice-cache').innerText()).includes('Bella selected for this book'), 'actual fallback narrator visible');
        assert(!(await page.locator('#player-voice-name').innerText()).includes('Bella'));
        await page.screenshot({ path: path.join(output, 'fallback-320.png'), fullPage: true });
        await page.locator('#play-pause-btn').click();
        await page.route('**/api/premium-prep/narration-e/status?*', route => route.abort());
        await until(async () => (await page.locator('#hq-voice-prep').innerText()).includes('Reconnecting'), 'stale preparation state');
        await page.screenshot({ path: path.join(output, 'reconnecting-320.png'), fullPage: true });
      } finally { await context.tracing.stop({ path: path.join(output, 'workflow.trace.zip') }); await browser.close(); }
    });
    await check('a disabled provider keeps its saved narrator and paused preparation panel', async () => {
      await start(false);
      assert.equal((await status('narration-d')).status, 'userPaused');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', extraHTTPHeaders: { Authorization: 'Bearer narration-e2e-token' } });
        await page.goto(`${origin}/#/player/narration-d`);
        await page.locator('#hq-voice-prep').waitFor({ state: 'visible' });
        await until(async () => (await page.locator('#hq-voice-prep').innerText()).includes('Preparation paused'), 'disabled provider retains paused panel');
        assert((await page.locator('#hq-voice-prep').innerText()).includes('Nathan'));
        await page.screenshot({ path: path.join(output, 'disabled-provider-390.png'), fullPage: true });
      } finally { await browser.close(); }
    });
  } finally {
    await stop(); hold = false; for (const release of held) release(); await new Promise(resolve => service.close(resolve));
    await fs.writeFile(path.join(output, 'http-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    await fs.writeFile(path.join(output, 'server.log'), log);
    if (results.every(r => r.passed)) await fs.rm(data, { recursive: true, force: true });
    else console.error(`Failure fixture retained: ${data}`);
  }
  if (results.some(r => !r.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
