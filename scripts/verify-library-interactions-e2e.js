'use strict';

// Failure cases recorded before implementation: a slow refresh replaces newer
// results or clears their loading state; empty/error results leave stale tab
// hints; deleting a resumed book removes only its rail card; menu arrow keys
// fail to move focus and an action leaves focus inside a hidden menu.
// Uses the real library module, document, styles, and confirmation sheet with
// local HTTP fixtures. No providers, narration engines, or user data are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const browserName = process.env.LIBRARY_E2E_BROWSER || 'chromium';
const phase = process.env.LIBRARY_E2E_PHASE || `after-${browserName}`;
const output = path.join(root, 'output/general-reliability/library', phase);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const book = id => ({ id, title: id === 'a' ? 'A Long Walk Through the Library and Beyond' : `Book ${id.toUpperCase()}`, author: 'Library fixture', chapterCount: 3, totalDuration: 300, addedAt: '2026-10-01' });

(async () => {
  await fs.mkdir(output, { recursive: true });
  let browser, context, server;
  let books = [book('a'), book('b')], shelf = ['a'], positions = {}, plans = [];
  const report = { browser: browserName, phase, passed: false, checks: [], screenshots: [] };
  const requests = [];
  const app = express();
  app.use(express.json());
  app.get('/api/library', async (_req, res) => {
    const plan = plans.shift();
    requests.push({ path: '/api/library', planned: Boolean(plan) });
    plan?.hit.resolve();
    if (plan) await plan.release.promise;
    if (res.destroyed) return;
    res.status(plan?.status || 200).json(plan?.data || { books, shelf });
  });
  app.get('/api/positions', (_req, res) => res.json({ positions }));
  app.delete('/api/book/:id', (req, res) => {
    books = books.filter(candidate => candidate.id !== req.params.id);
    shelf = shelf.filter(id => id !== req.params.id);
    res.json({ success: true });
  });
  app.all('/api/*path', (_req, res) => res.json({}));
  const html = (await fs.readFile(path.join(root, 'public/index.html'), 'utf8'))
    .replace(/<script type="module" src="app\.js[^>]*><\/script>/, `<script type="module">
      import { initLibrary, loadLibrary } from '/js/views/library.js';
      document.querySelector('#login-view').remove();
      window.loadLibrary = loadLibrary;
      window.queue = [];
      initLibrary({ openBook: async () => true, addToListeningQueue: id => window.queue.push(id) });
      window.initialLoad = loadLibrary();
    </script>`);
  const fixtureLimit = rateLimit({ windowMs: 60_000, limit: 1000 });
  app.get('/', fixtureLimit, (_req, res) => res.type('html').send(html));
  app.use(fixtureLimit, express.static(path.join(root, 'public')));
  const gate = (data, status = 200) => { const item = { data, status, hit: deferred(), release: deferred() }; plans.push(item); return item; };
  try {
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await (browserName === 'webkit' ? webkit : chromium).launch();
    context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    async function check(name, fn) {
      books = [book('a'), book('b')]; shelf = ['a']; positions = {}; plans = [];
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(() => window.initialLoad);
      try { const evidence = await fn(page); assert.deepEqual(errors, []); report.checks.push({ name, passed: true, evidence }); }
      catch (error) { report.checks.push({ name, passed: false, error: error.message, errors }); }
      finally { plans.forEach(plan => plan.release.resolve()); await page.close(); }
    }
    await check('newer refresh wins over a late older response', async page => {
      const old = gate({ books: [book('old')], shelf: ['old'] });
      await page.evaluate(() => { window.oldLoad = window.loadLibrary(); }); await old.hit.promise;
      const fresh = gate({ books: [book('new')], shelf: ['new'] });
      await page.evaluate(() => { window.newLoad = window.loadLibrary(); }); await fresh.hit.promise;
      fresh.release.resolve(); await page.evaluate(() => window.newLoad);
      old.release.resolve(); await page.evaluate(() => window.oldLoad);
      const ids = await page.locator('#library-list .book-item').evaluateAll(items => items.map(item => item.dataset.bookId));
      assert.deepEqual(ids, ['new']); return { visibleBooks: ids };
    });
    await check('older completion keeps the current refresh busy', async page => {
      const old = gate({ books: [book('old')], shelf: ['old'] });
      await page.evaluate(() => { window.oldLoad = window.loadLibrary(); }); await old.hit.promise;
      const fresh = gate({ books: [book('new')], shelf: ['new'] });
      await page.evaluate(() => { window.newLoad = window.loadLibrary(); }); await fresh.hit.promise;
      old.release.resolve(); await page.evaluate(() => window.oldLoad);
      const busy = await page.locator('#library-list').getAttribute('aria-busy');
      fresh.release.resolve(); await page.evaluate(() => window.newLoad);
      assert.equal(busy, 'true'); return { busyUntilLatestCompletes: busy };
    });
    await check('empty and failed loads do not claim an empty downloaded shelf', async page => {
      await page.locator('[data-library-tab="downloaded"]').click();
      assert(await page.locator('#downloaded-empty-hint').isVisible());
      books = []; await page.evaluate(() => window.loadLibrary());
      const emptyHint = await page.locator('#downloaded-empty-hint').isVisible();
      const fail = gate({ error: 'Fixture outage' }, 503); fail.release.resolve();
      await page.evaluate(() => window.loadLibrary());
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('xandrio:offlinechange')));
      const errorHint = await page.locator('#downloaded-empty-hint').isVisible();
      assert.equal(emptyHint, false); assert.equal(errorHint, false);
      await page.locator('[data-retry-library]').click(); await page.waitForFunction(() => document.querySelector('#library-list').getAttribute('aria-busy') === 'false');
      return { emptyHint, errorHint, retryWorks: true };
    });
    await check('delete removes both the resumed book and its shelf row', async page => {
      positions = { a: { chapterIndex: 1, updatedAt: '2026-10-03' } };
      await page.locator('[data-library-tab="shelf"]').click();
      await page.evaluate(() => window.loadLibrary());
      assert.equal(await page.locator('.rail-card[data-book-id="a"]').count(), 1);
      await page.locator('.book-item[data-book-id="a"] [data-book-menu-toggle]').click();
      await page.locator('.book-overflow-menu [data-delete-book-id="a"]').click();
      await page.locator('[data-confirm-ok]').click();
      await page.waitForTimeout(500);
      const rows = await page.locator('.book-item[data-book-id="a"]').count();
      const rail = await page.locator('.rail-card[data-book-id="a"]').count();
      assert.equal(rows, 0); assert.equal(rail, 0);
      assert(await page.locator('#shelf-empty-hint').isVisible());
      return { remainingDeletedBookRows: rows, remainingRailCards: rail };
    });
    await check('menu keyboard navigation and action focus work', async page => {
      await page.locator('[data-library-tab="all"]').click();
      const trigger = page.locator('.book-item[data-book-id="a"] [data-book-menu-toggle]');
      await trigger.focus(); await page.keyboard.press('Enter');
      const menu = page.locator('.book-item[data-book-id="a"] .book-overflow-menu');
      const items = menu.locator('[role="menuitem"]:not(:disabled)');
      await page.keyboard.press('ArrowDown');
      const arrowMoved = await items.nth(1).evaluate(el => el === document.activeElement);
      await page.keyboard.press('End');
      const endMoved = await items.last().evaluate(el => el === document.activeElement);
      await page.keyboard.press('ArrowDown');
      const wrapped = await items.first().evaluate(el => el === document.activeElement);
      await page.keyboard.press('Escape');
      assert(await trigger.evaluate(el => el === document.activeElement));
      await trigger.press('Enter');
      await menu.locator('[data-queue-add]').focus();
      await page.keyboard.press('Enter');
      const actionRestoredFocus = await trigger.evaluate(el => el === document.activeElement);
      await trigger.press('ArrowUp');
      const opensLast = await items.last().evaluate(el => el === document.activeElement);
      await page.keyboard.press('Tab');
      const tabCloses = await menu.isHidden();
      await trigger.focus(); await trigger.press('Enter');
      await page.keyboard.press('Shift+Tab');
      const reverseTabCloses = await menu.isHidden();
      assert.deepEqual({ arrowMoved, endMoved, actionRestoredFocus, wrapped, opensLast, tabCloses, reverseTabCloses },
        { arrowMoved: true, endMoved: true, actionRestoredFocus: true, wrapped: true, opensLast: true, tabCloses: true, reverseTabCloses: true });
      return { arrowMoved, endMoved, actionRestoredFocus, wrapped, opensLast, tabCloses, reverseTabCloses };
    });
    await check('desktop and phone library layout and menus remain usable', async page => {
      await page.locator('[data-library-tab="all"]').click();
      const sizes = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
      const geometry = [];
      for (const size of sizes) {
        await page.setViewportSize(size);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const trigger = page.locator('.book-item[data-book-id="a"] [data-book-menu-toggle]');
        const menu = page.locator('.book-item[data-book-id="a"] .book-overflow-menu');
        if (await menu.isHidden()) await trigger.click();
        const rect = await menu.boundingBox();
        if (!rect) {
          const state = await page.evaluate(() => ({
            books: [...document.querySelectorAll('#library-list .book-item')].map(el => el.dataset.bookId),
            menuHidden: document.querySelector('.book-item[data-book-id="a"] .book-overflow-menu')?.hidden,
            active: document.activeElement?.tagName,
            trigger: (() => { const el = document.querySelector('.book-item[data-book-id="a"] [data-book-menu-toggle]'); const rect = el.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { rect: rect.toJSON(), hit: hit?.outerHTML?.slice(0, 150) }; })()
          }));
          throw new Error(`Menu has no box at ${size.width}px: ${JSON.stringify(state)}`);
        }
        const targets = await menu.locator('button').evaluateAll(items => items.map(item => item.getBoundingClientRect().height));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        const name = `library-${size.width}.png`;
        await page.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name);
        geometry.push({ width: size.width, overflow, menu: rect });
        assert.equal(overflow, false); assert(rect.x >= 0 && rect.x + rect.width <= size.width);
        assert(targets.every(height => height >= 45), 'Every menu action has a 45px touch target');
        assert(await menu.locator('button').last().evaluate(el => {
          const box = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }), 'Last menu action is not clipped or covered');
        await page.keyboard.press('Escape');
        assert(await menu.isHidden(), 'Escape closes the menu');
      }
      return geometry;
    });
    report.passed = report.checks.every(check => check.passed);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await context?.tracing.stop({ path: path.join(output, 'trace.zip') });
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, requests }, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
