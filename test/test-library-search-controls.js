#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const SCREENSHOT_DIR = '/tmp/alexandrio-ui-fixes';
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1280, height: 800, mobile: false }
];

function offlineEntry(bookId, state, chapterEntries) {
  const chapters = 3;
  return {
    manifestVersion: 3,
    mode: 'full',
    bookId,
    state,
    chapters,
    chapterEntries,
    titleData: {
      book: { id: bookId, title: `Offline fixture ${bookId}` },
      chapters: Array.from({ length: chapters }, (_, index) => ({
        index,
        title: `Chapter ${index + 1}`
      }))
    }
  };
}

async function visibleBookCount(page) {
  return page.locator('#library-list .book-item:not(.skeleton):not(.hidden)').count();
}

async function verifyViewport(browser, environment, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Xandrio-Scenario': 'library:full' }
  });
  const page = await context.newPage();

  try {
    await page.goto(`${environment.origin}/#/library`, { waitUntil: 'networkidle' });
    await page.locator('#library-list .book-item:not(.skeleton)').first().waitFor({ state: 'visible' });

    const initialCount = await visibleBookCount(page);
    assert(initialCount > 1, `${viewport.name}: expected fixture books`);

    await page.locator('#library-search-toggle').click();
    await page.locator('#library-search').fill('no title or author has this text');
    assert.strictEqual(await visibleBookCount(page), 0, `${viewport.name}: unmatched cards stay visible`);
    const emptyState = page.locator('[data-library-filter-empty]');
    await emptyState.waitFor({ state: 'visible' });
    assert.match(await emptyState.textContent(), /No matching books/);

    await emptyState.locator('[data-clear-library-filter]').click();
    assert.strictEqual(await page.locator('#library-search').inputValue(), '');
    assert.strictEqual(
      await visibleBookCount(page),
      initialCount,
      `${viewport.name}: clearing the no-match state did not restore the cards`
    );

    await page.evaluate(manifest => {
      localStorage.setItem('xandrio_offline_books:default', JSON.stringify(manifest));
      document.dispatchEvent(new CustomEvent('xandrio:offlinechange'));
    }, {
      'scn-meridian': offlineEntry('scn-meridian', 'ready', [{ url: 'one' }, { url: 'two' }, { url: 'three' }]),
      'scn-fieldnotes': offlineEntry('scn-fieldnotes', 'incomplete', [{ url: 'one' }, null, null])
    });

    const readyCard = page.locator('.book-item[data-book-id="scn-meridian"]');
    const partialCard = page.locator('.book-item[data-book-id="scn-fieldnotes"]');
    assert.strictEqual(await readyCard.getAttribute('data-downloaded'), '1');
    assert.match(await readyCard.locator('[data-offline-status]').innerText(), /^Downloaded$/);
    assert.strictEqual(await partialCard.getAttribute('data-downloaded'), '0');
    assert.match(await partialCard.locator('[data-offline-status]').innerText(), /Partial 1\/3.*Continue/);

    await page.locator('[data-library-tab="downloaded"]').click();
    assert.strictEqual(await readyCard.isVisible(), true, `${viewport.name}: ready download missing from Downloaded`);
    assert.strictEqual(await partialCard.isVisible(), false, `${viewport.name}: incomplete download shown as Downloaded`);
    await page.locator('[data-library-tab="all"]').click();
    assert.strictEqual(await visibleBookCount(page), initialCount, `${viewport.name}: Shared Library did not restore all cards`);
    await page.waitForTimeout(400);

    if (viewport.mobile) {
      await page.locator('#view-toggle-btn').click();
      assert.strictEqual(await readyCard.locator('[data-offline-status]').isVisible(), true);
      assert.strictEqual(await partialCard.locator('[data-offline-status]').isVisible(), true);
      assert.match(await partialCard.locator('[data-offline-status]').innerText(), /Partial 1\/3.*Continue/);
      await page.waitForTimeout(400);
    }

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `library-search-controls-${viewport.name}.png`),
      fullPage: true
    });

    await page.route('**/api/book/scn-fieldnotes', route => route.abort());
    const routeBeforeDownload = page.url();
    await partialCard.locator('[data-offline-status] [data-download-book]').click();
    await page.waitForTimeout(250);
    assert.strictEqual(page.url(), routeBeforeDownload, `${viewport.name}: download action opened the book`);
    assert.strictEqual(await page.locator('#player-view.active').count(), 0, `${viewport.name}: download action opened the player`);
  } finally {
    await context.close();
  }
}

async function main() {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const environment = await startScenarioEnvironment({
    proxyPort: 0,
    datasets: ['full'],
    defaultDataset: 'full'
  });
  const browser = await chromium.launch({ headless: true });

  try {
    for (const viewport of VIEWPORTS) {
      await verifyViewport(browser, environment, viewport);
    }
    console.log('Library search controls: 12 passed, 0 failed across mobile and desktop');
  } finally {
    await browser.close();
    await environment.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
