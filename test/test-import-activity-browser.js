#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const SCREENSHOT_DIR = '/tmp/alexandrio-import-activity';
const SOURCES = [{ id: 'gutenberg', label: 'Gutenberg', configured: true, enabled: true, searchAvailable: true }];

function searchPayload() {
  const edition = {
    hash: 'import-flow-book',
    title: 'The Patient Book',
    author: 'Test Author',
    source: 'gutenberg',
    format: 'EPUB'
  };
  return {
    works: [{
      id: 'work-import-flow',
      title: edition.title,
      author: edition.author,
      sources: ['gutenberg'],
      bestEdition: edition,
      editions: [edition]
    }],
    sourceStatus: { gutenberg: { configured: true, ok: true, count: 1 } }
  };
}

async function routeSearch(page) {
  await page.route('**/api/search', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/sources')) {
      return route.fulfill({ json: { sources: SOURCES } });
    }
    return route.fulfill({ json: searchPayload() });
  });
}

async function verifyDownloadLifecycle(browser, environment) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  let startRoute;
  let statusChecks = 0;
  let starts = 0;

  try {
    await routeSearch(page);
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [] } }));
    await page.route('**/api/download', route => { starts++; startRoute = route; });
    await page.route('**/api/download/job-download/status', route => {
      statusChecks++;
      if (statusChecks === 1) {
        return route.fulfill({ json: {
          jobId: 'job-download', status: 'running', label: 'Checking downloaded file…', detail: 'Validating the EPUB container.'
        } });
      }
      return route.fulfill({ json: {
        jobId: 'job-download', status: 'complete', label: 'Complete',
        result: { success: true, bookId: 'book-complete', title: 'The Patient Book' }
      } });
    });

    await page.goto(`${environment.origin}/?q=patient&sources=gutenberg#/search`, { waitUntil: 'domcontentloaded' });
    await page.locator('#search-results [data-work-add]').waitFor({ state: 'visible' });
    await page.locator('#search-results [data-work-add]').click();
    await page.waitForFunction(() => Boolean(document.querySelector('[data-import-job^="pending-"]')));

    const pending = page.locator('[data-import-job^="pending-"]');
    assert.equal(await pending.locator('[data-import-label]').textContent(), 'Connecting to source…',
      'a delayed POST must not invent a server-side import stage');
    await page.locator('#search-results [data-work-add]').evaluate(button => button.click());
    await page.waitForTimeout(150);
    assert.equal(starts, 1, 'repeat activation must not start another import');
    assert.equal(await page.locator('[data-import-job]').count(), 1);
    assert.equal(await pending.locator('[data-import-label]').textContent(), 'Connecting to source…',
      'the placeholder must remain stable until the POST responds');

    await startRoute.fulfill({ status: 202, json: { jobId: 'job-download' } });
    const attached = page.locator('[data-import-job="job-download"]');
    await attached.locator('[data-import-label]').filter({ hasText: 'Checking downloaded file…' }).waitFor();
    assert.equal(await attached.locator('[data-import-detail]').textContent(), 'Validating the EPUB container.',
      'the first visible step after 202 must come from the status endpoint');

    await page.locator('#back-to-library-btn').click();
    await page.waitForURL(/#\/library$/);
    await attached.locator('[data-import-label]').filter({ hasText: 'Added to library' }).waitFor({ timeout: 5000 });
    assert.match(page.url(), /#\/library$/, 'completion after leaving Search must preserve the Library route');
    assert.equal(await page.locator('#player-view.active').count(), 0,
      'completion after leaving Search must not open the player');
  } finally {
    await context.close();
  }
}

async function verifyReloadedActivity(browser, environment, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  });
  const page = await context.newPage();

  try {
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [
      {
        jobId: 'job-pending', title: 'Still Arriving.epub', status: 'running',
        label: 'Extracting chapters…', detail: 'Found 7 chapters.'
      },
      {
        jobId: 'job-alternative', title: 'Recovered Edition', status: 'complete',
        result: { success: true, bookId: 'book-alternative', usedAlternative: true }
      },
      {
        jobId: 'job-duplicate', title: 'Already Shelved', status: 'failed',
        error: { error: 'Book already exists in library', existingBookId: 'book-existing' }
      }
    ] } }));

    await page.goto(`${environment.origin}/#/library`, { waitUntil: 'domcontentloaded' });
    const pending = page.locator('[data-import-job="job-pending"]');
    const alternative = page.locator('[data-import-job="job-alternative"]');
    const duplicate = page.locator('[data-import-job="job-duplicate"]');
    await duplicate.waitFor({ state: 'visible' });

    assert.equal(await pending.locator('[data-import-label]').textContent(), 'Extracting chapters…');
    assert.equal(await pending.locator('[data-import-detail]').textContent(), 'Found 7 chapters.');
    assert.equal(await alternative.locator('[data-import-label]').textContent(), 'Added to library');
    assert.match(await alternative.locator('[data-import-detail]').textContent(), /different edition was imported/i,
      'usedAlternative must explain why the imported edition changed');
    assert.equal(await duplicate.locator('[data-import-label]').textContent(), 'Already in your library');
    await duplicate.getByRole('button', { name: 'Open book' }).waitFor({ state: 'visible' });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-import-job="job-pending"]').waitFor({ state: 'visible' });
    await page.locator('[data-import-job="job-alternative"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-import-job="job-pending"] [data-import-label]').textContent(), 'Extracting chapters…',
      'reload must reconstruct a pending import from GET /api/imports');
    assert.equal(await page.locator('[data-import-job="job-alternative"] [data-import-label]').textContent(), 'Added to library',
      'reload must reconstruct a completed import from GET /api/imports');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `import-activity-${viewport.name}.png`),
      fullPage: true
    });
  } finally {
    await context.close();
  }
}

async function verifyCancellation(browser, environment, viewport) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage();
  let job = { jobId: 'cancel-job', requestHash: 'import-flow-book', title: 'The Patient Book',
    status: 'running', label: 'Reading book metadata', canCancel: true };
  let cancelRoute;
  try {
    await routeSearch(page);
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [job] } }));
    await page.route('**/api/download/cancel-job/cancel', route => { cancelRoute = route; });
    await page.goto(`${environment.origin}/?q=patient&sources=gutenberg#/search`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[data-import-job="cancel-job"]');
    const add = page.locator('#search-results [data-work-add]');
    await card.waitFor();
    await add.waitFor();
    await page.evaluate(async () => {
      const { beginImport } = await import('/js/features/import-activity.js');
      const progress = beginImport({ title: 'The Patient Book', hash: 'import-flow-book' });
      progress.attach('cancel-job');
      progress.stop();
    });
    assert.equal(await page.locator('[data-import-job="cancel-job"]').count(), 1,
      'attaching a POST response after refresh must not duplicate the activity card');
    assert.equal(await add.isDisabled(), true, 'reload disables Add for an active import');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `import-cancel-${viewport.width}.png`), fullPage: true });
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await card.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    await cancelRoute.fulfill({ status: 503, json: { error: 'Could not cancel. Try again.' } });
    await card.locator('[data-import-detail]').filter({ hasText: 'Could not cancel. Try again.' }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
    cancelRoute = null;
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(100);
    job = { ...job, cancellationRequested: true, canCancel: false, label: 'Cancelling…' };
    await cancelRoute.fulfill({ json: job });
    await card.getByRole('button', { name: 'Cancelling…' }).waitFor();
    job = { ...job, status: 'cancelled' };
    await card.locator('[data-import-label]').filter({ hasText: 'Import cancelled' }).waitFor({ timeout: 6000 });
    assert.equal(await add.isEnabled(), true, 'cancelled imports can be added again');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    assert.equal(await page.locator('[data-import-job="cancel-job"]').count(), 0);
  } finally { await context.close(); }
}

async function verifyCompletedImportActions(browser, environment, viewport) {
  const context = await browser.newContext({
    viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600,
    reducedMotion: 'reduce', serviceWorkers: 'block'
  });
  const page = await context.newPage();
  try {
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [{
      jobId: 'job-open', title: 'The Meridian Line', status: 'complete',
      result: { success: true, bookId: 'scn-meridian' }
    }] } }));
    await page.goto(`${environment.origin}/#/library`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[data-import-job="job-open"]');
    await card.getByRole('button', { name: 'Open book' }).click();
    await page.waitForURL(/#\/player\/scn-meridian$/);
    await page.locator('#player-view.active').waitFor();
    assert.equal(await page.locator('#book-title').textContent(), 'The Meridian Line');
    assert.equal(await page.locator('#library-view').isVisible(), false,
      'Open book must show the player without the shelf');
    await card.waitFor({ state: 'detached', timeout: 2000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `import-open-${viewport.width}.png`), fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#player-view.active').waitFor();
    assert.equal(await card.count(), 0, 'an opened import must stay dismissed after reload');
  } finally { await context.close(); }
}

async function verifyOpenDuringNavigation(browser, environment) {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'no-preference' });
  const page = await context.newPage();
  try {
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [{
      jobId: 'job-navigation', title: 'The Meridian Line', status: 'complete',
      result: { success: true, bookId: 'scn-meridian' }
    }] } }));
    await page.goto(`${environment.origin}/#/search`, { waitUntil: 'domcontentloaded' });
    await page.locator('#search-view.active').waitFor();
    // Hold the outgoing animation's DOM update until the book has opened.
    await page.evaluate(() => {
      document.startViewTransition = update => {
        const finished = new Promise(resolve => {
          window.finishPreviousNavigation = async () => { await update(); resolve(); };
        });
        return { ready: Promise.resolve(), finished };
      };
    });
    await page.locator('#back-to-library-btn').click();
    await page.waitForURL(/#\/library$/);
    await page.locator('[data-import-job="job-navigation"] [data-import-open]').click();
    await page.locator('#player-view.active').waitFor();
    await page.evaluate(() => window.finishPreviousNavigation());
    assert.match(page.url(), /#\/player\/scn-meridian$/);
    assert.equal(await page.locator('#player-view.active').count(), 1,
      'an older shelf transition must not replace the book opened from the banner');
  } finally { await context.close(); }
}

async function verifyCompletedImportExpiry(browser, environment) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [{
      jobId: 'job-expire', title: 'The Meridian Line', status: 'complete',
      result: { success: true, bookId: 'scn-meridian' }
    }, {
      jobId: 'job-running', title: 'Still adding', status: 'running', canCancel: true
    }, {
      jobId: 'job-failed', title: 'Needs attention', status: 'failed', error: { error: 'Try again.' }
    }] } }));
    await page.goto(`${environment.origin}/#/library`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[data-import-job="job-expire"]');
    await card.waitFor();
    await card.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await page.locator('[data-import-job="job-running"]').isVisible(), true);
    assert.equal(await page.locator('[data-import-job="job-failed"]').isVisible(), true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#library-list .book-item:not(.skeleton)').first().waitFor();
    assert.equal(await card.count(), 0, 'polling and reload must not revive expired success banners');
  } finally { await context.close(); }
}

async function verifyOpenFailureAndRetry(browser, environment) {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  let bookRoute;
  try {
    await page.clock.install();
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [{
      jobId: 'job-retry', title: 'The Meridian Line', status: 'complete',
      result: { success: true, bookId: 'scn-meridian' }
    }] } }));
    await page.route('**/api/book/scn-meridian', route => { bookRoute = route; });
    await page.goto(`${environment.origin}/#/library`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[data-import-job="job-retry"]');
    await card.getByRole('button', { name: 'Open book' }).click();
    await page.clock.fastForward(7000);
    assert.equal(await card.isVisible(), true, 'an in-flight Open book must not expire');
    assert.equal(await card.getByRole('button', { name: 'Opening…' }).isDisabled(), true);
    await bookRoute.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    await card.locator('[data-import-detail]').filter({ hasText: 'Could not open this book. Try again.' }).waitFor();
    await page.clock.fastForward(7000);
    assert.equal(await card.isVisible(), true, 'a failed open must remain available for retry');
    assert.equal(await card.locator('[data-import-detail]').textContent(), 'Could not open this book. Try again.');
    await page.unroute('**/api/book/scn-meridian');
    await card.getByRole('button', { name: 'Open book' }).click();
    await page.locator('#player-view.active').waitFor();
    await card.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#import-activity').isVisible(), false);
  } finally { await context.close(); }
}

async function verifyUploadHandoff(browser, environment) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  let uploadRoute;

  try {
    await page.route('**/api/imports', route => route.fulfill({ json: { jobs: [] } }));
    await page.route('**/api/upload', async route => {
      uploadRoute = route;
      await route.continue();
    });

    await page.goto(`${environment.origin}/#/search`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__importLabels = [];
      new MutationObserver(() => {
        const label = document.querySelector('[data-import-label]')?.textContent;
        if (label && window.__importLabels.at(-1) !== label) window.__importLabels.push(label);
      }).observe(document.getElementById('import-activity'), { subtree: true, childList: true, characterData: true });
    });
    await page.locator('#file-input').setInputFiles({
      name: 'upload-handoff.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.alloc(1024 * 512, 'x')
    });
    await page.waitForFunction(() => Boolean(window.__importLabels?.includes('Processing book…')));

    assert.equal(await uploadRoute.request().headerValue('prefer'), 'respond-async',
      'upload must opt into the asynchronous server response');
    const labels = await page.evaluate(() => window.__importLabels);
    assert(labels.includes('Uploading file…'), `upload transfer status was not rendered: ${JSON.stringify(labels)}`);
    assert(labels.includes('Processing book…'), `post-transfer processing status was not rendered: ${JSON.stringify(labels)}`);
    assert(labels.indexOf('Uploading file…') < labels.indexOf('Processing book…'),
      'upload transfer status must precede processing status');

  } finally {
    await context.close();
  }
}

async function main() {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full' });
  const browser = await (process.env.IMPORT_TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });

  try {
    await verifyOpenDuringNavigation(browser, environment);
    await verifyCompletedImportActions(browser, environment, { width: 390, height: 844 });
    await verifyCompletedImportActions(browser, environment, { width: 1280, height: 800 });
    await verifyCompletedImportExpiry(browser, environment);
    await verifyOpenFailureAndRetry(browser, environment);
    await verifyDownloadLifecycle(browser, environment);
    await verifyReloadedActivity(browser, environment, { name: 'mobile', width: 390, height: 844, mobile: true });
    await verifyReloadedActivity(browser, environment, { name: 'desktop', width: 1280, height: 800, mobile: false });
    await verifyCancellation(browser, environment, { width: 390, height: 844 });
    await verifyCancellation(browser, environment, { width: 1280, height: 800 });
    await verifyUploadHandoff(browser, environment);
    console.log('11 passed, 0 failed');
  } finally {
    await browser.close();
    await environment.close();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
