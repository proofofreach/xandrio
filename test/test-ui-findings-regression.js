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

      // Continue cards are whole 44px+ targets; removing one from Continue
      // moved into the book actions (press and hold the card).
      const card = await page.locator('.rail-card').first().boundingBox();
      assert(card && card.width >= 44 && card.height >= 44, `Continue card is ${JSON.stringify(card)}`);
      await page.locator('.rail-card').first().dispatchEvent('contextmenu');
      await page.locator('#book-actions-sheet.active').waitFor();
      assert(await page.getByRole('menuitem', { name: 'Remove from Continue', exact: true }).isVisible());
      const removeBox = await page.getByRole('menuitem', { name: 'Remove from Continue', exact: true }).boundingBox();
      assert(removeBox.height >= 44, `Remove from Continue is ${JSON.stringify(removeBox)}`);
      await page.keyboard.press('Escape');
      await page.locator('#book-actions-sheet:not(.active)').waitFor({ state: 'attached' });
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
      // Desktop: the table sorted by Last played is the switcher, so the
      // shelf starts right under the title row instead of below a rail.
      const controls = await page.locator('.library-controls').boundingBox();
      const firstBook = await page.locator('#library-list .book-item:not(.skeleton)').first().boundingBox();
      assert(controls && firstBook);
      assert(firstBook.y < 160, `library shelf starts too low on desktop: ${JSON.stringify({ controls, firstBook })}`);
      const actions = await page.locator('.library-header .header-actions > button').evaluateAll(buttons => buttons
        .filter(button => button.getBoundingClientRect().width > 0)
        .map(button => ({ name: button.getAttribute('aria-label') || button.textContent.trim(), width: button.getBoundingClientRect().width })));
      assert(actions.length >= 1 && actions.every(action => action.name && action.width >= 44), `header actions: ${JSON.stringify(actions)}`);
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
      await page.goto(`${environment.origin}/#/settings/playback`, { waitUntil: 'networkidle' });
      const hint = await page.locator('.settings-label-hint').first().evaluate(element => ({
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        color: getComputedStyle(element).color,
        secondary: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim()
      }));
      assert(hint.fontSize >= 12, `settings helper text is ${hint.fontSize}px`);
      assert(hint.color, 'settings helper text has a computed color');
      passed++;

      await page.goto(`${environment.origin}/#/settings/voice`, { waitUntil: 'networkidle' });
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
