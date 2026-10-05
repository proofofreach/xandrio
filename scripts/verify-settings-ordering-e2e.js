// Failure modes captured before implementation: concurrent saves persist an older
// choice, delayed profile loads overwrite edits, and a rejected save blocks retries.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const browserName = process.env.SETTINGS_ORDERING_BROWSER || 'chromium';
const phase = process.env.SETTINGS_ORDERING_PHASE || `settings-${browserName}`;
const output = path.join(root, 'output/general-reliability/settings');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
(async () => {
  await fs.mkdir(output, { recursive: true });
  let server, browser, context, holdSave, holdLoad, rejectNext = false;
  let values = {}, saves = [], completed = [];
  const results = [], releases = [];
  const app = express(); app.use(express.json());
  app.get('/api/auth/status', (_req, res) => res.json({ authenticationRequired: false, authenticated: true }));
  app.get('/api/settings/client', async (req, res) => {
    const id = req.get('X-Xandrio-User-Id') || 'default';
    const snapshot = { ...(values[id] || {}) };
    if (holdLoad && id === 'profile_b') { const item = holdLoad; holdLoad = null; item.hit.resolve(); await item.release.promise; }
    res.json({ settings: snapshot });
  });
  app.put('/api/settings/client', async (req, res) => {
    const id = req.get('X-Xandrio-User-Id') || 'default';
    const update = req.body.settings;
    saves.push({ id, update });
    if (holdSave) { const item = holdSave; holdSave = null; item.hit.resolve(); await item.release.promise; }
    if (rejectNext) { rejectNext = false; completed.push({ rejected: true }); return res.status(503).json({ error: 'Fixture save failed' }); }
    values[id] = { ...(values[id] || {}), ...update }; completed.push({ id, update });
    res.json({ settings: values[id] });
  });
  app.get('/api/sync/profile', (_req, res) => res.json({ profile: null }));
  app.post('/api/sync/profile', (_req, res) => res.json({ success: true, userId: 'profile_b', profile: { id: 'profile_b', name: 'Fixture', devices: [] } }));
  app.get('/api/legal/operator-policy', (_req, res) => res.json({ version: 1, acknowledged: true, unverifiedSourcesEnabled: false }));
  app.get('/api/library', (_req, res) => res.json({ books: [] }));
  app.get('/api/listening-queue', (_req, res) => res.json({ queue: { bookIds: [], bookSettings: {} }, books: [] }));
  app.all('/api/*path', (_req, res) => res.json({}));
  const fixtureLimit = rateLimit({ windowMs: 60_000, limit: 1000 });
  if (process.env.SETTINGS_ORDERING_SOURCE_FILE) {
    app.get('/js/client-settings.js', fixtureLimit, (_req, res) => res.sendFile(path.resolve(process.env.SETTINGS_ORDERING_SOURCE_FILE)));
  }
  app.use(fixtureLimit, express.static(path.join(root, 'public')));
  function gate() { const item = { hit: deferred(), release: deferred() }; releases.push(item.release); return item; }
  async function reached(item) { let timer; try { await Promise.race([item.hit.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request gate not reached')), 10000); })]); } finally { clearTimeout(timer); } }
  async function settled(count) { const deadline = Date.now() + 10000; while (completed.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(completed.length, count); }
  try {
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await (browserName === 'webkit' ? webkit : chromium).launch();
    async function check(name, fn) {
      values = { default: { skipIntervalSeconds: 15 }, profile_b: { skipIntervalSeconds: 15, smartRewindEnabled: false } }; saves = []; completed = []; holdSave = holdLoad = null; rejectNext = false;
      context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      try { const evidence = await fn(page, origin); results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
      catch (error) { results.push({ name, passed: false, error: error.message, values, saves, completed }); console.error(`FAIL ${name}: ${error.message}`); }
      finally {
        releases.forEach(item => item.resolve());
        await page.screenshot({ path: path.join(output, `${phase}-${results.length}.png`) });
        await context.tracing.stop({ path: path.join(output, `${phase}-${results.length}.zip`) }); await context.close(); context = null;
      }
    }
    async function open(page, origin, section = 'playback') { await page.goto(`${origin}/#/settings/${section}`); await page.locator(`[data-settings-pane="${section}"]`).waitFor({ state: 'visible' }); }
    const choice = value => `#skip-interval-control [data-skip-interval="${value}"]`;
    await check('rapid choices persist the latest value after reload', async (page, origin) => {
      await open(page, origin); const item = holdSave = gate();
      await page.locator(choice(30)).click(); await reached(item); await page.locator(choice(10)).click();
      await page.waitForTimeout(150); item.release.resolve(); await settled(2);
      await page.reload(); await page.locator(`${choice(10)}.active`).waitFor();
      assert.equal(values.default.skipIntervalSeconds, 10); return { values, saves, completed };
    });
    await check('delayed profile loading preserves a newer setting choice', async (page, origin) => {
      await open(page, origin, 'sync'); const item = holdLoad = gate();
      await page.locator('#sync-profile-input').fill('Fixture'); await page.locator('#sync-start-btn').click(); await reached(item);
      await page.evaluate(() => { location.hash = '#/settings/playback'; });
      await page.locator(choice(30)).click(); item.release.resolve(); await settled(1);
      await page.locator('#sync-start-btn').evaluate(button => new Promise(resolve => { const observer = new MutationObserver(() => { if (!button.disabled) { observer.disconnect(); resolve(); } }); if (!button.disabled) resolve(); else observer.observe(button, { attributes: true }); }));
      const state = await page.evaluate(async () => ({ settings: (await import('/js/client-settings.js')).getClientSettings(), controls: document.querySelector('#skip-interval-control').innerHTML }));
      assert.equal(await page.locator(`${choice(30)}.active`).count(), 1, JSON.stringify(state));
      assert.equal(await page.locator('#smart-rewind-control').isChecked(), false);
      assert.equal(values.profile_b.skipIntervalSeconds, 30); return { values, saves };
    });
    await check('a failed save does not block the next choice', async (page, origin) => {
      await open(page, origin); const item = holdSave = gate(); rejectNext = true;
      await page.locator(choice(30)).click(); await reached(item); await page.locator(choice(10)).click(); item.release.resolve(); await settled(2);
      await page.reload(); await page.locator(`${choice(10)}.active`).waitFor();
      assert.equal(values.default.skipIntervalSeconds, 10); return { values, saves, completed };
    });
    await check('queued choices cannot follow a sync-profile change', async (page, origin) => {
      await open(page, origin); const item = holdSave = gate();
      await page.locator(choice(30)).click(); await reached(item); await page.locator(choice(10)).click();
      await page.evaluate(() => { location.hash = '#/settings/sync'; });
      await page.locator('#sync-profile-input').fill('Fixture'); await page.locator('#sync-start-btn').click();
      await page.waitForFunction(() => localStorage.getItem('xandrio_sync_user_id') === 'profile_b');
      item.release.resolve(); await settled(1); await page.waitForLoadState('networkidle');
      assert.equal(saves.length, 1, JSON.stringify(saves));
      assert.equal(saves[0].id, 'default');
      assert.equal(values.profile_b.skipIntervalSeconds, 15);
      return { values, saves, completed };
    });
  } finally {
    releases.forEach(item => item.resolve()); await context?.close(); await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({ browser: browserName, phase, results }, null, 2) + '\n');
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
