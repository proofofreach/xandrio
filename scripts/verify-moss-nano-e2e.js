// Failure cases: wrong engine dispatch; hidden/misclassified voices; stale previews;
// overlapping local inference; disabled engine leaks; lost selection after restart;
// instant tier falsely reported without a language-compatible fallback.
// This exercises the real HTTP application. Only the external speech service is a fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/moss-nano');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

(async () => {
  await fs.mkdir(output, { recursive: true });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-nano-e2e-'));
  const bookId = 'nano-fixture';
  await fs.mkdir(path.join(data, 'cache'));
  const bookPath = path.join(data, 'cache', `${bookId}.xbook.json`);
  const chapters = ['First', 'Second', 'Third'].map((name, index) => ({
    title: `${name} chapter`, type: 'chapter', id: `chapter-${index}`,
    text: `${name} chapter. The rain stopped before dawn. Elena opened the window and listened to the quiet street. A bird sang in the garden.`,
    estimatedDuration: 12
  }));
  await fs.writeFile(bookPath, JSON.stringify({ _xbookVersion: 2, metadata: { title: 'Nano preparation', language: 'en' }, chapters }));
  await fs.writeFile(path.join(data, 'books.json'), JSON.stringify({ [bookId]: {
    id: bookId, title: 'Nano preparation', author: 'Fixture', path: bookPath, language: 'en', chapterCount: 3
  } }));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
    voice: 'kokoro:af_heart', operatorPolicy: { version: 1, acknowledgedAt: new Date().toISOString(), unverifiedSourcesEnabled: false }
  }));
  const wav = await fs.readFile(path.join(root, 'tts-benchmark-samples/kokoro-af-heart.wav'));
  const calls = [];
  let active = 0, peak = 0, online = true, serviceStatus = null, child, log = '', holdSecond = false;
  const held = new Set();
  const service = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(online ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: online, device: 'cpu', ...(serviceStatus ? { status: serviceStatus } : {}) }));
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    calls.push(payload); active++; peak = Math.max(peak, active);
    if (holdSecond && payload.voice === 'Nathan' && payload.text.includes('Second chapter')) {
      await new Promise(resolve => {
        const release = () => { held.delete(release); resolve(); };
        held.add(release); res.once('close', release);
      });
    }
    await delay(250); active--;
    res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav);
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  const engineUrl = `http://127.0.0.1:${service.address().port}`;
  let origin;
  async function stop(abrupt = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit'); child.kill(abrupt ? 'SIGKILL' : 'SIGTERM');
    await Promise.race([stopped, delay(3000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await stopped; }
  }
  async function start(enabled, providers = 'kokoro,moss-nano') {
    await stop();
    const portProbe = http.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
    const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, CACHE_DIR: path.join(data, 'cache'),
      XANDRIO_TOKEN: 'nano-e2e-token', XANDRIO_VOICE_PROVIDERS: providers,
      MOSS_NANO_ENABLED: String(enabled), MOSS_NANO_AUTO_START: 'false', MOSS_NANO_TTS_URL: engineUrl,
      KOKORO_AUTO_START: 'false', CHATTERBOX_AUTO_START: 'false', KOKORO_TTS_URL: engineUrl,
      CHATTERBOX_TTS_URL: engineUrl, XANDRIO_RATE_LIMIT_DISABLED: 'true'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
    for (let i = 0; i < 100; i++) {
      try { if ((await request('/api/voices')).ok) return; } catch {}
      if (child.exitCode !== null) throw new Error(`App exited: ${log.slice(-3000)}`);
      await delay(100);
    }
    throw new Error('App did not start');
  }
  function request(route, options = {}) {
    return fetch(origin + route, { ...options, headers: { Authorization: 'Bearer nano-e2e-token',
      'Content-Type': 'application/json', ...(options.headers || {}) }, signal: options.signal || AbortSignal.timeout(15000) });
  }
  async function check(name, fn) {
    try { const evidence = await fn(); results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  async function until(probe, label) {
    for (let i = 0; i < 160; i++) { const result = await probe(); if (result) return result; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  }
  const prepStatus = async () => (await request(`/api/premium-prep/${bookId}/status`)).json();
  try {
    await start(true);
    await check('18 built-in voices are prepared, local, and identifiable', async () => {
      const catalog = await (await request('/api/voices')).json();
      const voices = catalog.voices.filter(v => v.providerId === 'moss-nano');
      assert.equal(voices.length, 18);
      assert(voices.every(v => v.tier === 'premium' && v.local && v.id.startsWith('moss-nano:')));
      assert.deepEqual([...new Set(voices.map(v => v.languageCode))].sort(), ['en', 'ja', 'zh']);
      return voices.map(v => v.id);
    });
    await check('preview uses Nano, deduplicates, and caches', async () => {
      const before = calls.length;
      const responses = await Promise.all([request('/api/voice-sample/moss-nano%3ANathan'), request('/api/voice-sample/moss-nano%3ANathan')]);
      for (const response of responses) { assert.equal(response.status, 200); assert((await response.arrayBuffer()).byteLength > 1000); }
      assert.equal(calls.length - before, 1); assert.equal(calls.at(-1).voice, 'Nathan');
      assert.equal((await request('/api/voice-sample/moss-nano%3ANathan')).status, 200);
      assert.equal(calls.length - before, 1);
    });
    await check('Nano and Kokoro previews share the admission slot', async () => {
      peak = 0;
      const responses = await Promise.all([request('/api/voice-sample/moss-nano%3ABella'), request('/api/voice-sample/kokoro%3Aaf_heart')]);
      for (const response of responses) { assert.equal(response.status, 200); await response.arrayBuffer(); }
      assert.equal(peak, 1); return { peakConcurrentInference: peak };
    });
    await check('selection persists across app restart', async () => {
      assert.equal((await request('/api/voice', { method: 'POST', body: JSON.stringify({ voiceId: 'moss-nano:Nathan' }) })).status, 200);
      await start(true);
      assert.equal((await (await request('/api/voices')).json()).current, 'moss-nano:Nathan');
    });
    await check('idle preparation, fallback, and disable/re-enable preserve completed chapters', async () => {
      holdSecond = true;
      assert.equal((await request(`/api/narration/${bookId}`, { method: 'POST', body: JSON.stringify({ fallbackPolicy: 'instant' }) })).status, 200);
      assert.equal((await request(`/api/premium-prep/${bookId}/start`, { method: 'POST', body: '{}' })).status, 200);
      await until(async () => (await prepStatus()).readyChapters >= 1, 'first prepared chapter');
      await until(() => held.size > 0, 'second chapter in flight before repositioning');
      const manifest = await (await request(`/api/chunks/${bookId}/2/chapter-audio-status`)).json();
      assert.equal(manifest.servedTier, 'instant');
      const catalog = await (await request('/api/voices')).json();
      const variant = catalog.voices.find(v => v.id === 'moss-nano:Nathan').variantKey;
      const segment = '_tts' + createHash('sha1').update(variant).digest('hex').slice(0, 10);
      const cache = path.join(data, 'cache');
      const names = (await fs.readdir(cache)).filter(name => name.includes(segment) && /_ch0\.mp3$/.test(name));
      assert.equal(names.length, 1);
      const completed = path.join(cache, names[0]);
      const before = await fs.stat(completed);
      // Crash while chapter two is held so shutdown cannot advance chapter three.
      await stop(true);
      await start(false);
      const disabled = await (await request('/api/voices')).json();
      assert.equal(disabled.unavailableCurrent.id, 'moss-nano:Nathan');
      assert(!disabled.current.startsWith('moss-nano:'));
      const count = calls.filter(call => call.voice === 'Nathan').length;
      await delay(350);
      assert.equal(calls.filter(call => call.voice === 'Nathan').length, count);
      const cleanReport = execFileSync(process.execPath, ['scripts/clean-tts-orphans.js'], { cwd: root,
        env: { ...process.env, CACHE_DIR: cache, XANDRIO_URL: origin, XANDRIO_TOKEN: 'nano-e2e-token' }, encoding: 'utf8' });
      assert(!cleanReport.includes(segment), cleanReport);
      assert.equal((await fs.stat(completed)).mtimeMs, before.mtimeMs);
      for (const release of held) release();
      online = false; serviceStatus = 'models-uninstalled';
      const beforeMissingRestart = calls.filter(call => call.voice === 'Nathan').length;
      await start(true);
      await delay(500);
      assert.equal(calls.filter(call => call.voice === 'Nathan').length, beforeMissingRestart, 'missing-model recovery must not enter shared inference slot');
      assert.equal((await fs.stat(completed)).mtimeMs, before.mtimeMs);
      await stop();
      online = true; serviceStatus = null;
      const resumedCalls = calls.length;
      await start(true);
      await until(() => held.size > 0, 'resumed second chapter');
      const foreground = request('/api/voice-sample/moss-nano%3AAdam');
      await delay(100);
      holdSecond = false; for (const release of held) release();
      const preview = await foreground;
      assert.equal(preview.status, 200); await preview.arrayBuffer();
      await until(async () => (await prepStatus()).readyChapters === 3, 'resumed preparation').catch(async error => {
        throw new Error(error.message + ': ' + JSON.stringify(await prepStatus()));
      });
      assert.equal((await fs.stat(completed)).mtimeMs, before.mtimeMs);
      const resumed = calls.slice(resumedCalls);
      const previewIndex = resumed.findIndex(call => call.voice === 'Adam');
      const laterChapterIndex = resumed.findIndex(call => call.text.includes('Third chapter'));
      assert(previewIndex >= 0 && laterChapterIndex > previewIndex, 'foreground preview precedes next background chapter');
      const prepared = await (await request(`/api/chunks/${bookId}/0/manifest`)).json();
      assert.equal(prepared.servedTier, 'premium');
      const audio = await request(`/api/audio/${bookId}/0?tier=premium`, { headers: { Range: 'bytes=0-99' } });
      assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 100);
      return { preservedChapter: names[0], readyChapters: 3, rangeStatus: audio.status };
    });
    await check('non-English Nano without a compatible instant voice stays truthfully premium', async () => {
      assert.equal((await request('/api/voice', { method: 'POST', body: JSON.stringify({ voiceId: 'moss-nano:Soyo' }) })).status, 200);
      assert.equal((await request(`/api/narration/${bookId}`, { method: 'POST', body: JSON.stringify({ voiceId: 'moss-nano:Soyo' }) })).status, 200);
      assert.equal((await prepStatus()).instantVoice, null);
      const manifest = await (await request(`/api/chunks/${bookId}/0/manifest?tier=instant`)).json();
      assert.equal(manifest.servedTier, 'premium');
    });
    await check('both voice pickers support Nano at desktop and phone sizes', async () => {
      const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
      const context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { Authorization: 'Bearer nano-e2e-token' } });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      try {
        const page = await context.newPage();
        online = false; await request('/api/engines/status?refresh=1');
        await page.goto(`${origin}/#/settings/voice`);
        await page.locator('#voice-filter-bar [data-voice-preset="all"]').click();
        await page.locator('#voice-filter-bar [data-voice-filter="provider"]').selectOption('moss-nano');
        // The selected voice is pinned above the filtered list.
        assert.equal(await page.locator('#voice-list [data-voice-id^="moss-nano:"]').count(), 18);
        const nathan = page.locator('#voice-list [data-voice-id="moss-nano:Nathan"]');
        assert.equal(await nathan.locator('[data-voice-action="preview"]').count(), 0);
        online = true;
        await nathan.locator('[data-voice-action="preview"]').waitFor({ state: 'visible', timeout: 15000 });
        await nathan.locator('[data-voice-action="select"]').click();
        await until(async () => (await (await request('/api/voices')).json()).current === 'moss-nano:Nathan', 'browser voice selection');
        await page.screenshot({ path: path.join(output, 'settings-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${origin}/#/player/${bookId}`);
        await page.locator('#player-voice-status').click();
        await page.locator('[data-voice-more-toggle]').click();
        await page.locator('[data-facet-group="engine"][data-facet-value="moss-nano"]').click();
        assert.equal(await page.locator('#player-voice-list [data-voice-id^="moss-nano:"]').count(), 17);
        await page.screenshot({ path: path.join(output, 'picker-phone.png'), fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        return { desktopVoices: 18, phoneWidth: 390, horizontalOverflow: false };
      } finally { await context.tracing.stop({ path: path.join(output, 'pickers.trace.zip') }); await browser.close(); }
    });
    await check('offline engine status is truthful', async () => {
      online = false;
      const state = await (await request('/api/engines/status?refresh=1')).json();
      assert.equal(state.engines['moss-nano'].up, false); online = true;
    });
    await check('missing models cannot replace the voice and preserve an existing preference', async () => {
      online = false; serviceStatus = 'models-uninstalled';
      await request('/api/engines/status?refresh=1');
      const catalog = await (await request('/api/voices')).json();
      assert.equal(catalog.unavailableCurrent.id, 'moss-nano:Nathan');
      assert(!catalog.current.startsWith('moss-nano:'));
      assert.equal((await request('/api/voice', { method: 'POST', body: JSON.stringify({ voiceId: 'moss-nano:Soyo' }) })).status, 503);
      assert.equal(JSON.parse(await fs.readFile(path.join(data, 'settings.json'))).voice, 'moss-nano:Nathan');
      online = true; serviceStatus = null;
      await request('/api/engines/status?refresh=1');
      assert.equal((await (await request('/api/voices')).json()).current, 'moss-nano:Nathan');
    });
    await check('Nano-only allowlist has no false instant fallback', async () => {
      await start(true, 'moss-nano');
      const catalog = await (await request('/api/voices')).json();
      assert.equal(catalog.voices.length, 18);
      assert.equal((await prepStatus()).instantVoice, null);
      const manifest = await (await request(`/api/chunks/${bookId}/2/manifest?tier=instant`)).json();
      assert.equal(manifest.servedTier, 'premium');
    });
    await check('disabled provider cannot be selected or previewed', async () => {
      await start(false);
      assert(!(await (await request('/api/voices')).json()).voices.some(v => v.providerId === 'moss-nano'));
      assert.equal((await request('/api/voice', { method: 'POST', body: JSON.stringify({ voiceId: 'moss-nano:Nathan' }) })).status, 400);
      assert.equal((await request('/api/voice-sample/moss-nano%3ANathan')).status, 404);
    });
  } finally {
    for (const release of held) release();
    await stop(); service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
    await fs.writeFile(path.join(output, 'http-report.json'), JSON.stringify({ results, calls }, null, 2));
    await fs.writeFile(path.join(output, 'app.log'), log);
    if (process.env.KEEP_NANO_E2E_DATA === '1') console.log('Fixture retained:', data);
    else await fs.rm(data, { recursive: true, force: true });
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
