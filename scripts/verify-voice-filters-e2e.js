// Failure cases: hidden/misnamed model options; models disappearing after another
// filter; non-English voices in the default browse list; silent filter resets;
// lost preferences, keyboard focus, or current narrator; narrow-screen overflow.
// Runs the real application/catalog. Speech health is the only service fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/voice-filters');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await fs.mkdir(output, { recursive: true });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'xandrio-voice-filters-'));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ voice: 'kokoro:am_onyx',
    operatorPolicy: { version: 1, acknowledgedAt: new Date().toISOString(), unverifiedSourcesEnabled: false } }));
  const speech = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
  speech.listen(0, '127.0.0.1'); await once(speech, 'listening');
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const token = 'voice-filter-fixture';
  const engine = `http://127.0.0.1:${speech.address().port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, CACHE_DIR: path.join(data, 'cache'),
    XANDRIO_TOKEN: token, XANDRIO_VOICE_PROVIDERS: 'edge,kokoro,moss-nano', MOSS_NANO_ENABLED: 'true',
    MOSS_NANO_AUTO_START: 'false', MOSS_NANO_TTS_URL: engine, KOKORO_AUTO_START: 'false',
    KOKORO_TTS_URL: engine, CHATTERBOX_AUTO_START: 'false', XANDRIO_RATE_LIMIT_DISABLED: 'true'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', browser, context;
  const report = { passed: false, checks: [], screenshots: [] };
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  const catalog = async () => (await fetch(`${origin}/api/voices`, { headers: { Authorization: `Bearer ${token}` } })).json();
  try {
    let available;
    for (let i = 0; i < 100; i++) { try { available = await catalog(); break; } catch { await delay(100); } }
    assert(available?.voices?.length);
    browser = await chromium.launch();
    context = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const writes = []; page.on('request', req => { if (req.method() === 'POST' && /\/api\/(voice|narration)/.test(req.url())) writes.push(req.url()); });
    const filter = key => page.locator(`#voice-filter-bar [data-voice-filter="${key}"]`);
    const preset = key => page.locator(`#voice-filter-bar [data-voice-preset="${key}"]`);
    const ids = () => page.locator('#voice-list [data-voice-id]').evaluateAll(els => els.map(el => el.dataset.voiceId));
    const expectIds = async expected => assert.deepEqual((await ids()).sort(), [...new Set(['kokoro:am_onyx', ...expected])].sort());
    await page.goto(`${origin}/#/settings/voice`);
    await filter('provider').waitFor({ state: 'visible' });
    assert.equal(await filter('provider').getAttribute('aria-label'), 'Model filter');
    assert(await filter('language').isVisible());
    assert.equal(await preset('us-deep-male').getAttribute('aria-pressed'), 'true');
    const deep = available.voices.filter(v => v.language === 'English' && v.accent === 'US' && v.gender === 'Male' && v.depth === 'Deep');
    const nanoMale = available.voices.filter(v => v.providerId === 'moss-nano' && v.language === 'English' && v.gender === 'Male');
    assert.deepEqual(nanoMale.map(v => v.id).sort(), ['moss-nano:Adam', 'moss-nano:Nathan', 'moss-nano:Trump']);
    assert(deep.length >= 4); await expectIds([...deep, ...nanoMale].map(v => v.id));
    assert.deepEqual((await page.locator('[data-voice-candidates] [data-voice-id]').evaluateAll(els => els.map(el => el.dataset.voiceId))).sort(), nanoMale.map(v => v.id).sort());
    assert.match(await page.locator('[data-voice-candidates]').innerText(), /Accent and depth are not rated/);
    report.checks.push('US deep male matches plus all three separately labeled English male Nano candidates are visible, without other languages');
    for (const [model, label] of [['edge', 'Edge'], ['kokoro', 'Kokoro'], ['moss-nano', 'MOSS Nano']]) {
      assert.equal(await filter('provider').locator(`option[value="${model}"]`).textContent(), label);
    }
    await filter('provider').focus(); await filter('provider').selectOption('moss-nano');
    assert.equal(await filter('provider').evaluate(el => el === document.activeElement), true);
    assert.equal(await filter('provider').inputValue(), 'moss-nano');
    assert.equal(await filter('language').inputValue(), 'english');
    await expectIds(nanoMale.map(v => v.id));
    assert.equal(await page.locator('[data-voice-candidates] [data-voice-action="preview"]').count(), 3);
    await page.locator('.voice-settings-filters summary').click();
    await filter('gender').selectOption('female');
    assert.equal(await page.locator('[data-voice-candidates]').count(), 0);
    assert.match(await page.locator('#voice-list').innerText(), /No.*voices.*match/i);
    await page.locator('#voice-list [data-voice-action="browse-english"]').click();
    await expectIds(available.voices.filter(v => v.providerId === 'moss-nano' && v.language === 'English').map(v => v.id));
    assert.equal(await filter('provider').inputValue(), 'moss-nano');
    report.checks.push('Every model remains available; an empty combination is explicit and English recovery keeps the model');
    await page.reload(); await filter('provider').waitFor();
    assert.equal(await filter('provider').inputValue(), 'moss-nano');
    assert.equal(await filter('language').inputValue(), 'english');
    await filter('language').selectOption('chinese');
    await expectIds(available.voices.filter(v => v.providerId === 'moss-nano' && v.language === 'Chinese').map(v => v.id));
    await preset('all').click();
    assert.equal(await filter('provider').inputValue(), 'moss-nano');
    await expectIds(available.voices.filter(v => v.providerId === 'moss-nano').map(v => v.id));
    await filter('provider').selectOption('kokoro');
    await expectIds(available.voices.filter(v => v.provider === 'Kokoro').map(v => v.id));
    report.checks.push('Preferences survive reload; Chinese and all-language browsing work without changing the narrator');
    await preset('us-deep-male').focus(); await page.keyboard.press('Enter');
    assert.equal(await preset('us-deep-male').evaluate(el => el === document.activeElement), true);
    await filter('provider').selectOption('all');
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
      await page.setViewportSize(size);
      await filter('provider').scrollIntoViewIfNeeded();
      assert(await filter('language').isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const targets = await page.locator('#voice-filter-bar select:visible, #voice-filter-bar button:visible').evaluateAll(els => els.map(el => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), height: el.getBoundingClientRect().height })));
      assert(targets.every(t => t.height >= 44), JSON.stringify(targets));
      const file = `settings-${size.width}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file);
    }
    assert.equal((await catalog()).current, 'kokoro:am_onyx'); assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    report.checks.push('Desktop, 390px and 320px layouts, touch targets, keyboard focus, and unchanged narrator pass');
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    await context?.tracing.stop({ path: path.join(output, 'trace.zip') }); await browser?.close();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(output, 'server.log'), log);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await new Promise(resolve => speech.close(resolve)); await fs.rm(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
