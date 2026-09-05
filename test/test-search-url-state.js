#!/usr/bin/env node
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const SCREENSHOT_DIR = '/tmp/alexandrio-ui-fixes';
const RESULT_CARD = '#search-results .result-card:not(.skeleton-result)';
const SEARCH_A = { query: 'boundaries', language: 'en', sources: ['gutenberg'], sort: 'title' };
const SEARCH_B = { query: 'Lighthouses of the Northern Coast', language: 'en', sources: ['gutenberg'], sort: 'author' };

async function selectedSources(page) {
  return page.locator('[data-search-source][aria-pressed="true"]').evaluateAll(buttons =>
    buttons.map(button => button.dataset.searchSource).sort()
  );
}

async function assertSearchWorkspace(page, expected) {
  await page.locator(RESULT_CARD).first().waitFor({ state: 'visible' });
  const expectedTitle = expected === SEARCH_A ? 'A Treatise on Old Boundaries' : SEARCH_B.query;
  await page.locator(RESULT_CARD).filter({ hasText: expectedTitle }).first().waitFor({ state: 'visible' });
  assert.strictEqual(await page.locator('#search-input').inputValue(), expected.query);
  assert.strictEqual(await page.locator('#language-filter').inputValue(), expected.language);
  assert.strictEqual(await page.locator('#search-sort').inputValue(), expected.sort);
  assert.deepStrictEqual(await selectedSources(page), expected.sources);
  assert.deepStrictEqual(Object.fromEntries(new URL(page.url()).searchParams), {
    q: expected.query, language: expected.language, sources: expected.sources.join(','), sort: expected.sort
  });
}

async function main() {
  const environment = await startScenarioEnvironment({
    proxyPort: 0,
    datasets: ['full'],
    defaultDataset: 'full'
  });
  const browser = await chromium.launch({ headless: true });

  try {
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    let passed = 0;
    for (const viewport of [
      { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
      { name: 'desktop', width: 1280, height: 800 }
    ]) {
      const { name, width, height, ...contextOptions } = viewport;
      const context = await browser.newContext({
        ...contextOptions,
        viewport: { width, height },
        reducedMotion: 'reduce',
        serviceWorkers: 'block'
      });
      const page = await context.newPage();
      // Keep this UI-state regression independent of provider availability and ranking.
      await page.route('**/api/search', async route => {
        const { query, language, sources } = route.request().postDataJSON();
        assert.equal(language, 'en');
        assert.deepEqual(sources, ['gutenberg']);
        const books = require('./fixtures/scenarios/content/search-results.json').gutenberg;
        const works = books.filter(book => book.title.toLowerCase().includes(query.toLowerCase())).map(book => {
          const edition = { hash: `pg-${book.id}`, title: book.title, author: book.authors[0].name, source: 'gutenberg', format: 'EPUB' };
          return { id: `work-${book.id}`, title: edition.title, author: edition.author, sources: ['gutenberg'], bestEdition: edition, editions: [edition] };
        });
        await route.fulfill({ json: { works, sourceStatus: { gutenberg: { configured: true, ok: true, count: works.length } } } });
      });
      const state = new URLSearchParams({
        q: SEARCH_A.query,
        language: SEARCH_A.language,
        sources: SEARCH_A.sources.join(','),
        sort: SEARCH_A.sort
      }).toString();
      await page.goto(`${environment.origin}/?${state}#/search`, { waitUntil: 'domcontentloaded' });
      await assertSearchWorkspace(page, SEARCH_A);
      passed++;

      await page.locator('#back-to-library-btn').click();
      await page.waitForURL(/#\/library$/);
      await page.locator('#library-view.active').waitFor({ state: 'visible' });
      await page.waitForFunction(() => new URL(window.location.href).search === '');
      assert.strictEqual(new URL(page.url()).search, '', 'search state is removed outside the search route');

      await page.locator('#add-book-btn').click();
      await page.waitForURL(/#\/search$/);
      await page.locator('#search-view.active').waitFor({ state: 'visible' });
      await assertSearchWorkspace(page, SEARCH_A);
      passed++;

      await page.locator('#search-sort').selectOption(SEARCH_B.sort);
      await page.locator('#search-input').fill(SEARCH_B.query);
      await page.locator('#search-btn').click();
      await assertSearchWorkspace(page, SEARCH_B);
      passed++;

      await page.locator('#back-to-library-btn').click();
      await page.locator('#library-view.active').waitFor({ state: 'visible' });
      await page.goBack();
      await page.locator('#search-view.active').waitFor({ state: 'visible' });
      await assertSearchWorkspace(page, SEARCH_B);
      await page.goBack();
      await page.locator('#library-view.active').waitFor({ state: 'visible' });
      await page.goBack();
      await page.locator('#search-view.active').waitFor({ state: 'visible' });
      await assertSearchWorkspace(page, SEARCH_A);
      passed++;

      await page.reload({ waitUntil: 'domcontentloaded' });
      await assertSearchWorkspace(page, SEARCH_A);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `search-url-state-${name}.png`), fullPage: true });
      passed++;
      await context.close();
    }
    console.log(`Search URL state: ${passed} passed, 0 failed`);
  } finally {
    await browser.close();
    await environment.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
