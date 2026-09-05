#!/usr/bin/env node
const assert = require('node:assert');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const sources = [
  { id: 'gutenberg', label: 'Gutenberg', configured: true, enabled: true, searchAvailable: true },
  { id: 'opds', label: 'My catalog', configured: false, enabled: false, searchAvailable: false }
];

function work(title, editions = []) {
  const defaults = editions.length ? editions : [{
    hash: `hash-${title}`, title, author: 'Test Author', source: 'gutenberg', format: 'EPUB'
  }];
  return {
    id: `work-${title}`, title, author: 'Test Author', sources: ['gutenberg'],
    bestEdition: defaults[0], editions: defaults, editionCount: defaults.length, versionCount: defaults.length
  };
}

async function main() {
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full' });
  const browser = await chromium.launch({ headless: true });
  let heldRoute;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/api/search', async route => {
      if (new URL(route.request().url()).pathname.endsWith('/sources')) {
        return route.fulfill({ json: { sources } });
      }
      const { query } = route.request().postDataJSON();
      if (query === 'policy') return route.fulfill({ status: 409, json: { code: 'NO_ENABLED_SOURCES', error: 'No enabled search sources are available on this instance.' } });
      if (query === 'stale') {
        heldRoute = route;
        return;
      }
      if (query === 'editions') {
        return route.fulfill({ json: { works: [work('Shared title', [
          { hash: 'one', title: 'Shared title', author: 'Test Author', source: 'gutenberg', format: 'EPUB', language: 'English', publisher: 'Example Press', _year: '2024' },
          { hash: 'two', title: 'Annotated Shared title', author: 'Test Author', source: 'gutenberg', format: 'PDF', language: 'French', publisher: 'Other Press', _year: '2022' }
        ])], sourceStatus: { gutenberg: { ok: true, count: 1 } } } });
      }
      return route.fulfill({ json: { works: [work(query)], sourceStatus: { gutenberg: { ok: true, count: 1 } } } });
    });

    await page.goto(`${environment.origin}/?q=normal&sources=opds#/search`, { waitUntil: 'domcontentloaded' });
    await page.locator('#search-results .result-card').waitFor();
    assert.deepStrictEqual(await page.locator('[data-search-source][aria-pressed="true"]').evaluateAll(items => items.map(item => item.dataset.searchSource)), ['gutenberg']);
    assert.equal(new URL(page.url()).searchParams.get('sources'), 'gutenberg');
    assert.match(await page.locator('#search-source-message').textContent(), /unavailable here/i);

    await page.locator('#search-input').fill('stale');
    await page.locator('#search-btn').click();
    await page.waitForFunction(() => document.querySelector('.skeleton-result'));
    await page.locator('#search-input').fill('draft');
    await heldRoute.fulfill({ json: { works: [work('stale')], sourceStatus: { gutenberg: { ok: true, count: 1 } } } });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#search-results .result-card').count(), 0, 'a changed draft must discard the stale response');
    assert.equal(new URL(page.url()).searchParams.get('q'), 'draft');

    await page.locator('#search-input').fill('editions');
    await page.locator('#search-btn').click();
    const edition = page.locator('[data-edition-choice="1"]');
    await page.locator('.edition-disclosure summary').click();
    await edition.waitFor();
    assert.match(await edition.getAttribute('aria-label'), /Annotated Shared title, VERSION 2, PDF, French, Other Press, 2022/i);
    assert.match(await edition.textContent(), /Annotated Shared title.*French.*Other Press.*2022/s);
    await page.locator('#search-input').fill('policy');
    await page.locator('#search-btn').click();
    await page.locator('[data-search-action="settings"]').waitFor();
    assert.match(await page.locator('#search-results').textContent(), /No enabled search sources/);
    console.log('Search context regressions: 4 passed, 0 failed');
  } finally {
    await browser.close();
    await environment.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
