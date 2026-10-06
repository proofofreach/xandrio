// Failure-first browser/HTTP coverage: repeated Enter duplicates searches;
// changed input, cleared input and changed language leave obsolete requests open.
// Rendered inspection also found hidden import status styled as visible text.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const browserName = process.env.SEARCH_REQUEST_BROWSER || 'chromium';
const phase = process.env.SEARCH_REQUEST_PHASE || `search-${browserName}`;
const output = path.join(root, 'output/server-performance/browser');
const sources = [{ id: 'gutenberg', label: 'Gutenberg', configured: true, enabled: true, searchAvailable: true }];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function payload(title) {
  const edition = { hash: `hash-${title}`, title, author: 'Fixture Author', source: 'gutenberg', format: 'EPUB' };
  return { works: [{ id: `work-${title}`, title, author: edition.author, sources: ['gutenberg'], bestEdition: edition, editions: [edition] }], sourceStatus: { gutenberg: { ok: true, count: 1 } } };
}
(async () => {
  await fs.mkdir(output, { recursive: true });
  const app = express(); app.use(express.json());
  let server, browser, context, requests = [], failNext = false;
  const results = [];
  app.get('/api/auth/status', (_req, res) => res.json({ authenticationRequired: false, authenticated: true }));
  app.get('/api/search/sources', (_req, res) => res.json({ sources }));
  app.post('/api/search', (req, res) => {
    const item = { query: req.body.query, language: req.body.language, closed: false, completed: false, startedAt: performance.now() };
    requests.push(item);
    res.on('close', () => { item.closed = true; item.closedAfterMs = performance.now() - item.startedAt; });
    item.release = () => { if (!res.destroyed && !res.writableEnded) { item.completed = true; res.json(payload(item.query)); } };
    if (failNext) { failNext = false; item.completed = true; return res.status(503).json({ error: 'Fixture search unavailable' }); }
    if (!item.query.startsWith('held')) item.release();
  });
  app.get('/api/settings/client', (_req, res) => res.json({ settings: { defaultSearchSources: ['gutenberg'] } }));
  app.get('/api/legal/operator-policy', (_req, res) => res.json({ version: 1, acknowledged: true, unverifiedSourcesEnabled: false }));
  app.get('/api/library', (_req, res) => res.json({ books: [] }));
  app.get('/api/listening-queue', (_req, res) => res.json({ queue: { bookIds: [], bookSettings: {} }, books: [] }));
  app.all('/api/*path', (_req, res) => res.json({}));
  const fixtureLimit = rateLimit({ windowMs: 60_000, limit: 1000 });
  if (process.env.SEARCH_REQUEST_SOURCE_FILE) app.get('/js/views/search.js', fixtureLimit, (_req, res) => res.sendFile(path.resolve(process.env.SEARCH_REQUEST_SOURCE_FILE)));
  app.use(fixtureLimit, express.static(path.join(root, 'public')));
  async function until(predicate, description) {
    const deadline = Date.now() + 2500;
    while (!predicate() && Date.now() < deadline) await pause(20);
    assert(predicate(), description);
  }
  const evidence = () => requests.map(({ release, ...item }) => item);
  try {
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await (browserName === 'webkit' ? webkit : chromium).launch();
    async function check(name, run) {
      requests = []; failNext = false;
      context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const page = await context.newPage(); page.setDefaultTimeout(6000);
      try {
        await page.goto(`${origin}/#/search`);
        await page.locator('[data-search-source="gutenberg"][aria-pressed="true"]').waitFor({ state: 'attached' });
        await page.waitForLoadState('networkidle');
        await run(page);
        results.push({ name, passed: true, requests: evidence() }); console.log(`PASS ${name}`);
      } catch (error) {
        results.push({ name, passed: false, error: error.message, requests: evidence() }); console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        requests.forEach(item => item.release());
        await context.tracing.stop({ path: path.join(output, `${phase}-${results.length}.zip`) });
        await context.close(); context = null;
      }
    }
    async function submit(page, query) {
      await page.locator('#search-input').fill(query); await page.locator('#search-input').press('Enter');
      await until(() => requests.some(item => item.query === query), 'search reaches HTTP server');
    }
    await check('repeated Enter shares one active search', async page => {
      await submit(page, 'held-repeat');
      await page.locator('#search-input').press('Enter'); await page.locator('#search-input').press('Enter');
      await pause(250);
      assert.equal(requests.length, 1, 'one query must produce one HTTP request while pending');
      requests[0].release(); await page.locator('.result-card-title').filter({ hasText: 'held-repeat' }).waitFor();
    });
    await check('editing a query cancels its obsolete HTTP request', async page => {
      await submit(page, 'held-old'); await page.locator('#search-input').fill('new query');
      await until(() => requests[0].closed && !requests[0].completed, 'editing closes the obsolete request before it finishes');
      assert.equal(await page.locator('.is-searching').count(), 0, 'source loading state clears with cancelled work');
      await page.locator('#search-input').press('Enter'); await page.locator('.result-card-title').filter({ hasText: 'new query' }).waitFor();
      assert.equal(requests.length, 2);
    });
    await check('clearing the query cancels work and restores controls', async page => {
      await submit(page, 'held-clear'); await page.locator('#search-clear-btn').click();
      await until(() => requests[0].closed && !requests[0].completed, 'clearing closes the obsolete request');
      assert.equal(await page.locator('#search-btn').isEnabled(), true);
      assert.equal(await page.locator('.is-searching').count(), 0);
      assert.equal(await page.locator('#search-results .result-card').count(), 0);
      assert.equal(new URL(page.url()).searchParams.has('q'), false);
    });
    await check('changing language cancels the old search and applies the new language', async page => {
      await submit(page, 'held-language'); await page.locator('#search-filter-toggle').click();
      await page.locator('#language-filter').selectOption('fr');
      await until(() => requests[0].closed && !requests[0].completed, 'language change closes the obsolete request');
      await page.locator('#search-input').fill('French book'); await page.locator('#search-input').press('Enter');
      await page.locator('.result-card-title').filter({ hasText: 'French book' }).waitFor();
      assert.equal(requests.at(-1).language, 'fr');
    });
    await check('late old responses cannot replace current results', async page => {
      await submit(page, 'held-stale'); await submit(page, 'Current book');
      await page.locator('.result-card-title').filter({ hasText: 'Current book' }).waitFor();
      requests[0].release(); await pause(100);
      assert.deepEqual(await page.locator('.result-card-title').allTextContents(), ['Current book']);
      if (process.env.SEARCH_REQUEST_SCREENSHOTS === '1') {
        await page.screenshot({ path: path.join(output, `${phase}-desktop.png`), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: path.join(output, `${phase}-phone.png`), fullPage: true });
      }
    });
    await check('a failed search can be retried', async page => {
      failNext = true; await submit(page, 'Retry book');
      await page.locator('[data-search-retry]').click(); await page.locator('.result-card-title').filter({ hasText: 'Retry book' }).waitFor();
      assert.equal(requests.length, 2);
    });
    await check('idle results do not announce an import that never started', async page => {
      await submit(page, 'Available book'); await page.locator('.result-card-title').waitFor();
      assert.equal(await page.locator('[data-result-import-status]').isVisible(), false);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator('[data-result-import-status]').isVisible(), false);
    });
  } finally {
    requests.forEach(item => item.release()); await context?.close(); await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify({ browser: browserName, phase, results }, null, 2) + '\n');
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
