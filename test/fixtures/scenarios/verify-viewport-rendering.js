/**
 * Regression check for scripts/scenario-shots.js's viewport handling.
 *
 * `browser.newContext()` requires viewport dimensions nested under
 * `viewport: {width, height}` — passing top-level `width`/`height` keys is
 * silently ignored and the context falls back to Playwright's 1280x720
 * default. That bug meant every "mobile" scenario shot was actually a
 * desktop-width render (only distinguishable by devicePixelFactor), and the
 * harness never produced the 390x844 iPhone/PWA evidence it exists for.
 *
 * This does not boot the full five-dataset scenario environment — it only
 * needs a bare page to prove each entry in VIEWPORTS produces a context
 * whose layout viewport and rendered screenshot pixels match what was asked
 * for, independent of anything server/content-related.
 */
const assert = require('assert');
const { chromium } = require('playwright');
const { VIEWPORTS, expectedPixelSize, readPngDimensions } = require('../../../scripts/scenario-shots');

// A blank page has no <meta name="viewport"> tag, so Chromium's mobile
// emulation (isMobile: true) falls back to the legacy ~980px desktop-site
// layout width and rescales it, which perturbs the rendered pixel count by
// rounding. Every real Xandrio page declares
// `width=device-width, initial-scale=1.0` (public/index.html) — matching
// that here keeps this check honest about what the app itself renders.
const BLANK_PAGE_WITH_VIEWPORT_META =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body></body></html>';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, config] of Object.entries(VIEWPORTS)) {
      await test(`${name}: context.newPage() reports the requested layout viewport`, async () => {
        const context = await browser.newContext({ ...config, serviceWorkers: 'block' });
        try {
          const page = await context.newPage();
          assert.deepStrictEqual(page.viewportSize(), config.viewport);
        } finally {
          await context.close();
        }
      });

      await test(`${name}: rendered screenshot pixels match viewport x deviceScaleFactor`, async () => {
        const context = await browser.newContext({ ...config, serviceWorkers: 'block' });
        try {
          const page = await context.newPage();
          await page.setContent(BLANK_PAGE_WITH_VIEWPORT_META);
          const png = await page.screenshot({ fullPage: false });
          assert.deepStrictEqual(readPngDimensions(png), expectedPixelSize(name));
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`scenario viewport rendering tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
