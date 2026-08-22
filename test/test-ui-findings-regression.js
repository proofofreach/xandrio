#!/usr/bin/env node
const assert = require('node:assert');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

async function main() {
  const environment = await startScenarioEnvironment({
    proxyPort: 0,
    datasets: ['full'],
    defaultDataset: 'full'
  });
  const browser = await chromium.launch({ headless: true });
  let passed = 0;

  async function context(width, height, scenario, mobile = false) {
    return browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      serviceWorkers: 'block',
      extraHTTPHeaders: { 'X-Xandrio-Scenario': scenario }
    });
  }

  try {
    {
      const browserContext = await context(390, 844, 'library:full', true);
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/library`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#library-list .book-item:not(.skeleton)');

      const collapsed = await page.locator('#library-search-bar').evaluate(element => ({
        inert: element.hasAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden')
      }));
      assert.deepStrictEqual(collapsed, { inert: true, ariaHidden: 'true' });
      passed++;

      await page.locator('#library-search-toggle').click();
      assert.strictEqual(await page.evaluate(() => document.activeElement?.id), 'library-search');
      assert.strictEqual(await page.locator('#library-search-bar').getAttribute('inert'), null);
      await page.locator('#library-search-close').click();
      assert.strictEqual(await page.evaluate(() => document.activeElement?.id), 'library-search-toggle');
      passed++;

      const dismiss = await page.locator('.rail-dismiss').first().boundingBox();
      assert(dismiss && dismiss.width >= 44 && dismiss.height >= 44, `rail dismiss is ${JSON.stringify(dismiss)}`);
      const deleteStops = await page.locator('.delete-btn-reveal').evaluateAll(buttons => buttons.map(button => ({
        tabIndex: button.tabIndex,
        ariaHidden: button.getAttribute('aria-hidden')
      })));
      assert(deleteStops.length > 0 && deleteStops.every(item => item.tabIndex === -1 && item.ariaHidden === 'true'));
      assert.strictEqual(await page.locator('#library-panel').getAttribute('tabindex'), null);
      passed++;
      await browserContext.close();
    }

    {
      const browserContext = await context(1280, 800, 'library:full');
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/library`, { waitUntil: 'networkidle' });
      const contextRail = await page.locator('.library-context-rail').boundingBox();
      const controls = await page.locator('.library-controls').boundingBox();
      const firstBook = await page.locator('#library-list .book-item:not(.skeleton)').first().boundingBox();
      assert(contextRail && controls && firstBook);
      assert(firstBook.y < contextRail.y + contextRail.height - 40,
        `library shelf still starts below its context rail: ${JSON.stringify({ contextRail, controls, firstBook })}`);
      const labels = await page.locator('.header-action-label').evaluateAll(elements => elements.map(element => ({
        text: element.textContent.trim(),
        visible: element.getBoundingClientRect().width > 0
      })));
      assert(labels.length >= 3 && labels.every(label => label.visible));
      passed++;
      await browserContext.close();
    }

    {
      const browserContext = await context(390, 844, 'search:full', true);
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/search`, { waitUntil: 'networkidle' });
      await page.locator('#search-input').fill('boundaries');
      const clear = await page.locator('#search-clear-btn').boundingBox();
      assert(clear && clear.width >= 44 && clear.height >= 44, `search clear is ${JSON.stringify(clear)}`);
      passed++;
      await browserContext.close();
    }

    {
      const browserContext = await context(1280, 800, 'settings:full');
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/settings`, { waitUntil: 'networkidle' });
      const hint = await page.locator('.settings-label-hint').first().evaluate(element => ({
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        color: getComputedStyle(element).color,
        secondary: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim()
      }));
      assert(hint.fontSize >= 12, `settings helper text is ${hint.fontSize}px`);
      assert(hint.color, 'settings helper text has a computed color');
      passed++;

      const voiceSummary = page.locator('.settings-section-header').filter({ hasText: /^\s*Voice\s*$/ });
      await voiceSummary.click();
      await page.waitForSelector('#voice-list .voice-card');
      const voiceGrid = await page.locator('#voice-list .voice-section').first().evaluate(element =>
        getComputedStyle(element).gridTemplateColumns
      );
      assert(voiceGrid.split(' ').length >= 2, `voice section is not a two-column desktop grid: ${voiceGrid}`);
      const cloneBadge = page.locator('.clone-voice-badge').first();
      if (await cloneBadge.count()) {
        assert(!(await cloneBadge.textContent()).includes('✨'));
        assert.strictEqual(await cloneBadge.locator('svg').count(), 1);
      }
      passed++;
      await browserContext.close();
    }

    const imageContext = await context(390, 844, 'player:full', true);
    const imagePage = await imageContext.newPage();
    const imageSources = await (async () => {
      const page = imagePage;
      await page.goto(`${environment.origin}/#/player/scn-meridian`, { waitUntil: 'domcontentloaded' });
      return page.locator('#player-ambient-img, #book-cover, #mini-player-cover').evaluateAll(images =>
        images.map(image => image.getAttribute('src'))
      );
    })();
    assert(imageSources.every(Boolean), `empty image source remains: ${JSON.stringify(imageSources)}`);
    passed++;
    await imageContext.close();
  } finally {
    await browser.close();
    await environment.close();
  }

  console.log(`UI findings regression: ${passed} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
