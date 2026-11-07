#!/usr/bin/env node
// Shell, library, Find and Settings review fixes (UI review 2026-11-05):
// transport shortcuts stay in the player context, the skip link and player
// focus, speed stated once in the desktop table, empty scopes drop the table
// header, Find shares one 760px column, Settings opens a page beside the hub,
// and a phone in landscape keeps the tab bar.
const assert = require('node:assert');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const BOOK = 'scn-meridian';

async function main() {
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full' });
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  const context = (width, height, scenario, mobile = false) => browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Xandrio-Scenario': scenario }
  });

  // Records whether the global shortcut handler claimed a key.
  const watchKeys = page => page.evaluate(() => {
    window.__claimed = [];
    window.addEventListener('keydown', event => window.__claimed.push(`${event.key}:${event.defaultPrevented}`));
  });
  const claimed = page => page.evaluate(() => window.__claimed.splice(0));

  try {
    {
      const browserContext = await context(1024, 768, 'library:full');
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/player/${BOOK}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.body.dataset.view === 'player');
      await watchKeys(page);

      // In the player, the arrows and Space drive playback.
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      assert.deepStrictEqual(await claimed(page), ['ArrowDown:true', 'ArrowUp:true']);
      passed++;

      // In the library, with the same book loaded, they stay native.
      await page.goto(`${environment.origin}/#/library`);
      await page.waitForSelector('#library-list .book-item:not(.skeleton)');
      await page.waitForFunction(() => document.getElementById('mini-player')?.style.display !== 'none');
      await page.locator('#library-list .book-item:not(.hidden) .book-card-open').first().focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowLeft');
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press(' ');
      assert.deepStrictEqual(await claimed(page), ['ArrowDown:false', 'ArrowLeft:false', ' :false']);
      passed++;

      // Focus inside the mini player is player context; / and ? stay global.
      await page.locator('#mini-player-open').focus();
      await page.keyboard.press('ArrowRight');
      await page.locator('#library-list .book-card-open').first().focus();
      await page.keyboard.press('?');
      assert.deepStrictEqual(await claimed(page), ['ArrowRight:true', '?:true']);
      await page.keyboard.press('Escape');
      passed++;

      // The overlay says where the transport keys work.
      const groups = await page.locator('#shortcut-overlay th').allTextContents();
      assert.deepStrictEqual(groups, ['In the player or mini player', 'Everywhere']);
      passed++;

      // Skip link: first tab stop while a mini player shows; it reaches it.
      // Restart sequential focus at the top of the document.
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.body.tabIndex = -1;
        document.body.focus();
        document.body.removeAttribute('tabindex');
      });
      await page.keyboard.press('Tab');
      assert.strictEqual(await page.evaluate(() => document.activeElement?.id), 'skip-to-player');
      await page.keyboard.press('Enter');
      assert.strictEqual(await page.evaluate(() => document.activeElement?.id), 'mini-player-open');
      passed++;

      // A player opened by the user takes focus at its title.
      await page.locator('#mini-player-open').click();
      await page.waitForFunction(() => document.body.dataset.view === 'player');
      await page.waitForFunction(() => document.getElementById('player-view')?.contains(document.activeElement));
      passed++;
      await browserContext.close();
    }

    {
      const browserContext = await context(1280, 800, 'library:full');
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/library`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#library-list .book-item:not(.skeleton)');
      const head = await page.locator('#library-table-time-head').textContent();
      assert.match(head, /^Time left at \d/);
      const speedNote = await page.locator('#library-speed-note').isVisible();
      assert.strictEqual(speedNote, false, 'the sort line does not repeat the header speed');
      const rowSpeeds = await page.locator('#library-list .book-col-time .book-col-muted').count();
      assert.strictEqual(rowSpeeds, 0, 'rows at the reference speed do not repeat it');
      passed++;

      // Empty scope: the empty card without the table header.
      await page.evaluate(() => document.getElementById('library-tab-downloaded')?.click());
      await page.waitForFunction(() => document.getElementById('library-view')?.dataset.libraryVisible === '0');
      assert.strictEqual(await page.locator('.library-table-head').isVisible(), false);
      passed++;

      // Find: the search row has the results' 760px measure and its full
      // placeholder fits; sources have one name each.
      await page.goto(`${environment.origin}/#/search`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#search-view.active #search-input');
      const find = await page.evaluate(() => {
        const input = document.getElementById('search-input');
        const box = document.querySelector('#search-view .search-box').getBoundingClientRect();
        const canvas = document.createElement('canvas').getContext('2d');
        const style = getComputedStyle(input);
        canvas.font = `${style.fontSize} ${style.fontFamily}`;
        const text = canvas.measureText(input.placeholder).width;
        const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { width: box.width, fits: text <= room };
      });
      assert(find.width > 600 && find.width <= 761, `search row is ${find.width}px`);
      assert(find.fits, 'the full placeholder fits');
      await page.locator('#search-filter-toggle').click();
      const names = await page.locator('.search-source-name').allTextContents();
      assert(names.every(name => !/^(Anna's|Z-Lib|Archive|Gutenberg|Standard)$/.test(name.trim())), `short source names: ${names}`);
      passed++;

      // Settings: the hub route opens Playback beside the hub; version lives
      // in the footer and the account block follows the sections.
      await page.goto(`${environment.origin}/#/settings`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-settings-pane="playback"]:not([hidden])');
      const order = await page.evaluate(() => {
        const hub = document.getElementById('settings-hub');
        const nav = hub.querySelector('.settings-menu');
        const identity = document.getElementById('settings-identity');
        const version = document.getElementById('app-version-check');
        return {
          versionInFooter: Boolean(version.closest('.settings-hub-footer')),
          identityAfterNav: Boolean(nav.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING)
        };
      });
      assert.deepStrictEqual(order, { versionInFooter: true, identityAfterNav: true });
      passed++;
      await browserContext.close();
    }

    {
      // A phone in landscape keeps the tab bar and the scope control.
      const browserContext = await context(915, 412, 'library:full', true);
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/library`, { waitUntil: 'networkidle' });
      const shell = await page.evaluate(() => ({
        tabbar: getComputedStyle(document.getElementById('app-tabbar')).display,
        sidebar: getComputedStyle(document.getElementById('app-sidebar')).display,
        tabs: getComputedStyle(document.getElementById('library-tabs')).display
      }));
      assert.notStrictEqual(shell.tabbar, 'none');
      assert.strictEqual(shell.sidebar, 'none');
      assert.notStrictEqual(shell.tabs, 'none');
      passed++;
      await browserContext.close();
    }
  } finally {
    await browser.close();
    await environment.close();
  }
  console.log(`Shell review fixes: ${passed} passed, 0 failed`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
