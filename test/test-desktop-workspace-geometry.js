#!/usr/bin/env node
/**
 * Desktop workspace regression: the wide Library, Search, and Stats surfaces
 * share the bounded shell while phone and tablet retain their stacked layout.
 */
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const output = path.resolve(__dirname, '../output/ui-rewrite-fixes/desktop-geometry');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const VIEWPORTS = [
  { name: 'wide-1440', width: 1440, height: 900, wide: true },
  { name: 'wide-1280', width: 1280, height: 800, wide: true },
  { name: 'tablet-1024', width: 1024, height: 800, wide: false },
  { name: 'phone-390', width: 390, height: 844, wide: false, mobile: true }
];
const CASES = [
  { view: 'library', state: 'full', primary: '#library-list .book-item:not(.skeleton)' },
  { view: 'library', state: 'empty', primary: '#library-list .empty-state-modern' },
  { view: 'search', state: 'full', search: 'boundaries', primary: '.search-results-list .result-card:not(.skeleton-result)' },
  { view: 'search', state: 'empty', search: 'zzznonexistentscenarioquery', primary: '#search-results .empty-state-modern' },
  { view: 'search', state: 'error', search: 'boundaries', error: true, primary: '#search-results .empty-state-modern' },
  { view: 'stats', state: 'full', primary: '.stats-workspace .stats-progress-row' },
  { view: 'stats', state: 'empty', primary: '#stats-body .empty-state-modern' },
  { view: 'stats', state: 'error', primary: '#stats-body .empty-state-modern' }
];

function route(view) {
  return `#/${view}`;
}

async function visibleBox(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 8000 });
  return locator.boundingBox();
}

async function prepareCase(page, testCase) {
  if (testCase.view !== 'search') return;
  await page.locator('#search-input').fill(testCase.search);
  await page.locator('#search-btn').click();
  await page.locator(testCase.primary).first().waitFor({ state: 'visible', timeout: 8000 });
}

async function run() {
  const environment = await startScenarioEnvironment({
    proxyPort: 0,
    datasets: ['full', 'empty'],
    defaultDataset: 'full'
  });
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  const results = [];
  await fs.mkdir(output, { recursive: true });
  try {
    for (const viewport of VIEWPORTS) {
      for (const testCase of CASES) {
        const label = `${viewport.name}-${testCase.view}-${testCase.state}`;
        console.log(`checking ${label}`);
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: Boolean(viewport.mobile),
          hasTouch: Boolean(viewport.mobile),
          serviceWorkers: 'block',
          extraHTTPHeaders: {
            'X-Xandrio-Scenario': `${testCase.view}:${testCase.error ? 'error' : testCase.state}`
          }
        });
        const page = await context.newPage();
        try {
          await page.goto(`${environment.origin}${route(testCase.view)}`, { waitUntil: 'domcontentloaded' });
          await prepareCase(page, testCase);
          const primary = await visibleBox(page, testCase.primary);
          const geometry = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            library: document.querySelector('.library-workspace') && getComputedStyle(document.querySelector('.library-workspace')).gridTemplateColumns,
            search: document.querySelector('.search-content-workspace') && getComputedStyle(document.querySelector('.search-content-workspace')).gridTemplateColumns,
            stats: document.querySelector('.stats-workspace') && getComputedStyle(document.querySelector('.stats-workspace')).gridTemplateColumns,
            shell: document.querySelector('#library-view.active, #search-view.active, #stats-view.active')?.getBoundingClientRect().width
          }));
          assert(geometry.scrollWidth <= geometry.innerWidth, `${viewport.name} ${testCase.view}:${testCase.state} has no horizontal overflow`);
          assert(primary && primary.x >= 0 && primary.x + primary.width <= viewport.width && primary.y < viewport.height,
            `${viewport.name} ${testCase.view}:${testCase.state} keeps primary evidence in the viewport (${JSON.stringify(primary)})`);

          if (viewport.wide) {
            const available = viewport.width - 232;
            assert(geometry.shell > available * 0.85 && geometry.shell <= available + 1 && geometry.shell <= 1120,
              `${viewport.name} ${testCase.view}:${testCase.state} fills the bounded region beside the 232px sidebar (${geometry.shell}px)`);
            if (testCase.view === 'library' && testCase.state === 'full') {
              assert.notStrictEqual(geometry.library, 'none', 'wide library exposes the context and primary columns');
            }
            if (testCase.view === 'library' && testCase.state === 'empty') {
              const workspace = await visibleBox(page, '.library-workspace');
              // The first-run state is a centered column inside the full
              // primary region (no stranded rail beside it).
              const centerOffset = Math.abs((primary.x + primary.width / 2) - (workspace.x + workspace.width / 2));
              assert(centerOffset < 2 && primary.width <= workspace.width + 1,
                'wide empty library centers in the full primary region without a stranded rail');
            }
            if (testCase.view === 'search') {
              const support = await visibleBox(page, '.search-workspace');
              assert.notStrictEqual(geometry.search, 'none', 'wide search exposes the support and primary columns');
              assert(primary.x > support.x, 'wide search primary content starts beside its support column');
              if (testCase.state === 'full') {
                const results = await visibleBox(page, '.search-results-list');
                assert(Math.abs(primary.x - results.x) < 2 && Math.abs(primary.width - results.width) < 2,
                  'wide search result rows fill and align with their result column');
                assert(primary.width >= 440 && primary.height >= 80 && primary.height <= 220,
                  'wide search rows preserve a readable title and metadata region');
                const rows = await page.locator('.result-card:not(.skeleton-result)').evaluateAll(elements => elements.map(el => {
                  const row = el.getBoundingClientRect();
                  const button = el.querySelector('button.result-download-btn, button.result-add-btn, button');
                  const action = button?.getBoundingClientRect();
                  return { row: { x: row.x, width: row.width }, action: action && { x: action.x, right: action.right, width: action.width, height: action.height }, overflow: el.scrollWidth > el.clientWidth };
                }));
                assert(rows.length > 0 && rows.every(row => !row.overflow && Math.abs(row.row.x - primary.x) < 2 && Math.abs(row.row.width - primary.width) < 2),
                  'wide result rows align without internal overflow');
                assert(rows.every(row => row.action && row.action.width >= 44 && row.action.height >= 44 && row.action.right <= row.row.x + row.row.width + 1),
                  'wide result rows keep reachable 44px Add controls inside their bounds');
              }
            }
            if (testCase.view === 'stats' && testCase.state === 'full') {
              const contextRail = await visibleBox(page, '.stats-context-rail');
              assert.notStrictEqual(geometry.stats, 'none', 'wide stats exposes summary and primary columns');
              assert(primary.x > contextRail.x, 'wide stats in-progress list starts beside its summary context');
            }
            if (testCase.view === 'stats' && testCase.state !== 'full') {
              const body = await visibleBox(page, '#stats-body');
              assert(Math.abs(primary.x - body.x) < 1 && Math.abs(primary.width - body.width) < 1,
                'wide empty or error stats uses the coherent primary region');
            }
          } else {
            const grid = testCase.view === 'library' ? geometry.library : testCase.view === 'search' ? geometry.search : geometry.stats;
            assert(!grid || grid === 'none', `${viewport.name} ${testCase.view}:${testCase.state} preserves the stacked topology below 1200px`);
          }
          results.push({ label, passed: true, primary, geometry });
          await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
          passed++;
        } catch (error) {
          results.push({ label, passed: false, error: error.message, errors: await page.locator('body').innerText() });
          await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
          throw error;
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await environment.close();
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  }
  console.log(`desktop workspace geometry: ${passed} cases passed`);
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
