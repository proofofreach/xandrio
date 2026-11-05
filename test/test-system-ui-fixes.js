#!/usr/bin/env node
// System-wide UI review fixes (UI review 2026-11-05): type follows the
// reader's text size and layouts survive 2x text, every select is a 44px
// control, the manifest splits any/maskable icons and has shortcuts, safe
// areas use the --safe-* tokens, closed sheets are inert, hover-only rules
// apply only where hover exists, and the player voice sheet's More filters
// is a native disclosure.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

const BOOK = 'scn-meridian';
const PUBLIC = path.join(__dirname, '..', 'public');
const cssFiles = fs.readdirSync(PUBLIC).filter(name => name.endsWith('.css'));
const readCss = name => fs.readFileSync(path.join(PUBLIC, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Leaf rules with their selector and enclosing at-rule preludes.
function leafRules(css) {
  const rules = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') { stack.push({ prelude: css.slice(start, i).trim(), open: i }); start = i + 1; }
    else if (c === '}') {
      const top = stack.pop();
      if (top && !top.prelude.startsWith('@') && !css.slice(top.open + 1, i).includes('{')) {
        rules.push({ selector: top.prelude, context: stack.map(s => s.prelude).join(' ') });
      }
      start = i + 1;
    } else if (c === ';') start = i + 1;
  }
  return rules;
}

function staticChecks() {
  let passed = 0;

  // Type tokens are type units, and the default unit is 1px of a 16px root.
  const style = readCss('style-v3.css');
  assert.match(style, /--type-unit: calc\(1rem \/ 16\);/);
  assert.match(style, /--text-body: calc\(17 \* var\(--type-unit\)\);/);
  assert.match(style, /--text-footnote: calc\(13 \* var\(--type-unit\)\);/);
  assert.doesNotMatch(style, /--(text|leading)-[a-z0-9-]+:\s*\d+px/, 'no type token is fixed in px');
  // iOS Dynamic Type is scoped to touch WebKit: desktop Safari resolves
  // -apple-system-body to 13px.
  assert.match(style, /@supports \(font: -apple-system-body\) and \(-webkit-touch-callout: none\)/);
  for (const name of cssFiles) {
    assert.doesNotMatch(readCss(name), /font-size:\s*\d+(\.\d+)?px|font:[^;]*\b\d+px\s+var\(--font\)/, `${name} sizes text with tokens`);
  }
  passed++;

  // Safe areas use the tokens; env() appears only in their definitions.
  for (const name of cssFiles) {
    const raw = readCss(name).split('\n').filter(line => /env\(safe-area-inset/.test(line) && !/--safe-(top|bottom|left|right):/.test(line));
    assert.deepStrictEqual(raw, [], `${name} uses --safe-* instead of raw env()`);
  }
  passed++;

  // Hover-only rules sit inside @media (hover: hover). A rule may stay
  // outside only when it also styles a focus, active or open state.
  const STATE = /:focus|:active|\[aria-|\[open\]/;
  for (const name of cssFiles) {
    const loose = leafRules(readCss(name)).filter(rule => rule.selector.includes(':hover')
      && !/hover:\s*hover/.test(rule.context)
      && !STATE.test(rule.selector));
    assert.deepStrictEqual(loose.map(rule => rule.selector), [], `${name} wraps hover-only rules`);
  }
  passed++;

  // One select rule: a 44px target with body text that WebKit honours.
  assert.match(style, /select:not\(:where\(\.sr-only\)\) \{[^}]*appearance: none;[^}]*min-height: 44px;[^}]*font-size: var\(--text-body\);/);
  passed++;

  // Manifest: separate any and maskable icons that exist at their stated
  // size, colours that match the dark --bg and the theme-color meta, and
  // shortcuts to real hash routes. id, start_url and scope do not move.
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(manifest.id, '/');
  assert.strictEqual(manifest.start_url, '/?source=pwa');
  assert.strictEqual(manifest.scope, '/');
  assert.ok(manifest.icons.every(icon => icon.purpose === 'any' || icon.purpose === 'maskable'), 'no combined purpose');
  for (const purpose of ['any', 'maskable']) {
    const sizes = manifest.icons.filter(icon => icon.purpose === purpose).map(icon => icon.sizes).sort();
    assert.deepStrictEqual(sizes, ['192x192', '512x512'], `${purpose} icons at 192 and 512`);
  }
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(path.join(PUBLIC, icon.src));
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.strictEqual(`${w}x${h}`, icon.sizes, `${icon.src} is ${icon.sizes}`);
  }
  const darkBg = style.match(/--bg: (#[0-9A-Fa-f]{6});/)[1];
  assert.strictEqual(manifest.theme_color.toUpperCase(), darkBg.toUpperCase());
  assert.strictEqual(manifest.background_color.toUpperCase(), darkBg.toUpperCase());
  const index = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.ok(index.includes(`<meta name="theme-color" content="${darkBg}" media="(prefers-color-scheme: dark)">`));
  assert.deepStrictEqual(manifest.shortcuts.map(s => s.name), ['Continue listening', 'Find books']);
  assert.deepStrictEqual(manifest.shortcuts.map(s => s.url.split('#')[1]), ['/library', '/search']);
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  for (const icon of manifest.icons) assert.ok(sw.includes(`'${icon.src}'`), `${icon.src} is in the shell cache`);
  passed++;

  return passed;
}

async function main() {
  let passed = staticChecks();
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full' });
  const browsers = { chromium: await chromium.launch({ headless: true }), webkit: await webkit.launch({ headless: true }) };
  const context = (engine, width, height, mobile = false) => browsers[engine].newContext({
    viewport: { width, height },
    isMobile: mobile && engine === 'chromium',
    hasTouch: mobile,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Xandrio-Scenario': 'library:full' }
  });
  const fontSizes = page => page.evaluate(() => ({
    body: getComputedStyle(document.body).fontSize,
    footnote: getComputedStyle(document.querySelector('.app-tab') || document.body).fontSize
  }));
  const overflowX = page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

  try {
    // Default size renders the design scale in both engines.
    for (const engine of ['chromium', 'webkit']) {
      const browserContext = await context(engine, 390, 844, true);
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/library`);
      await page.waitForSelector('#library-list .book-item:not(.skeleton)');
      assert.deepStrictEqual(await fontSizes(page), { body: '17px', footnote: '13px' }, `${engine} default type`);
      await browserContext.close();
    }
    passed++;

    // The browser's own text size (Android, desktop) scales the type, rows
    // grow instead of overprinting, and nothing scrolls sideways.
    for (const width of [320, 390, 412]) {
      const browserContext = await context('chromium', width, 800, true);
      const page = await browserContext.newPage();
      const cdp = await browserContext.newCDPSession(page);
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
      await page.goto(`${environment.origin}/#/library`);
      await page.waitForSelector('#library-list .book-item:not(.skeleton)');
      assert.strictEqual((await fontSizes(page)).body, '34px', `${width}: body follows the browser text size`);
      const rows = await page.evaluate(() => [...document.querySelectorAll('#library-list .book-item:not(.hidden) .book-item-inner')]
        .slice(0, 5).map(row => ({ h: row.clientHeight, spill: row.scrollHeight - row.clientHeight })));
      assert.ok(rows.length > 0 && rows.every(row => row.h > 72 && row.spill <= 1), `${width}: rows grow with text ${JSON.stringify(rows)}`);
      assert.ok(await overflowX(page) <= 0, `${width}: library has no horizontal overflow`);
      await page.goto(`${environment.origin}/#/player/${BOOK}`);
      await page.waitForFunction(() => document.body.dataset.view === 'player');
      await page.waitForTimeout(500);
      assert.ok(await overflowX(page) <= 0, `${width}: player has no horizontal overflow`);
      const nav = await page.evaluate(() => {
        const title = document.querySelector('.pl-nav-title').getBoundingClientRect();
        const recent = document.getElementById('player-recent-btn').getBoundingClientRect();
        return title.width === 0 || title.right <= recent.left + 0.5;
      });
      assert.ok(nav, `${width}: the Now Playing title does not overlap Recent`);
      await browserContext.close();
    }
    passed++;

    // Every select is at least 44px tall in WebKit too.
    for (const engine of ['webkit', 'chromium']) {
      const browserContext = await context(engine, 390, 844, true);
      const page = await browserContext.newPage();
      for (const hash of ['#/settings/playback', '#/settings/voice']) {
        await page.goto(`${environment.origin}/${hash}`);
        await page.waitForFunction(() => [...document.querySelectorAll('#settings-view select:not(.sr-only)')].some(el => el.getClientRects().length));
        const heights = await page.evaluate(() => [...document.querySelectorAll('select:not(.sr-only)')]
          .filter(el => el.getClientRects().length).map(el => [el.id || el.name, Math.round(el.getBoundingClientRect().height), getComputedStyle(el).fontSize]));
        assert.ok(heights.length > 0, `${engine} ${hash} has selects`);
        for (const [id, height, size] of heights) {
          assert.ok(height >= 44, `${engine} ${hash} ${id} is ${height}px tall`);
          assert.strictEqual(size, '17px', `${engine} ${hash} ${id} uses body text`);
        }
      }
      await browserContext.close();
    }
    passed++;

    // Closed sheets are inert; opening, Escape, Back and drag-dismiss keep
    // working and focus returns to the trigger.
    {
      // Mouse input drives the pointer-based drag; emulated touch does not.
      const browserContext = await context('chromium', 390, 844);
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/player/${BOOK}`);
      await page.waitForFunction(() => document.body.dataset.view === 'player');
      const state = id => page.evaluate(id => {
        const el = document.getElementById(id);
        return { active: el.classList.contains('active'), inert: el.inert, hidden: el.getAttribute('aria-hidden'), focusInside: el.contains(document.activeElement) };
      }, id);
      for (const id of ['speed-sheet', 'timer-modal', 'chapter-sheet', 'player-more-sheet', 'voice-sheet', 'recent-sheet']) {
        assert.deepStrictEqual(await state(id), { active: false, inert: true, hidden: 'true', focusInside: false }, `${id} starts inert`);
      }
      const tabStops = await page.evaluate(() => {
        const sheets = [...document.querySelectorAll('.voice-sheet:not(.active)')];
        return sheets.some(sheet => [...sheet.querySelectorAll('button, a[href], input, select')].some(el => !el.closest('[inert]')));
      });
      assert.strictEqual(tabStops, false, 'no control in a closed sheet can take focus');

      await page.focus('#speed-sheet-btn');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('speed-sheet').classList.contains('active'));
      // Reduced motion makes the sheet visible a frame late; focus follows.
      await page.waitForFunction(() => document.getElementById('speed-sheet').contains(document.activeElement), null, { timeout: 2000 });
      assert.deepStrictEqual(await state('speed-sheet'), { active: true, inert: false, hidden: 'false', focusInside: true });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('speed-sheet').classList.contains('active'));
      assert.deepStrictEqual(await state('speed-sheet'), { active: false, inert: true, hidden: 'true', focusInside: false });
      assert.strictEqual(await page.evaluate(() => document.activeElement?.id), 'speed-sheet-btn', 'Escape returns focus to the trigger');

      await page.click('#timer-btn-inline');
      await page.waitForFunction(() => document.getElementById('timer-modal').classList.contains('active'));
      await page.goBack();
      await page.waitForFunction(() => !document.getElementById('timer-modal').classList.contains('active'));
      assert.strictEqual((await state('timer-modal')).inert, true, 'Back closes the sheet and makes it inert');
      assert.strictEqual(await page.evaluate(() => document.body.dataset.view), 'player', 'Back stays in the player');

      await page.click('#player-more-btn');
      await page.waitForFunction(() => document.getElementById('player-more-sheet').classList.contains('active'));
      await page.waitForTimeout(400);
      const handle = await page.locator('#player-more-sheet .voice-sheet-handle').boundingBox();
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step++) {
        await page.mouse.move(x, y + step * 25);
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForFunction(() => !document.getElementById('player-more-sheet').classList.contains('active'));
      assert.strictEqual((await state('player-more-sheet')).inert, true, 'drag-dismiss closes the sheet and makes it inert');

      // The reopened sheet is usable: its rows take clicks.
      await page.click('#player-more-btn');
      await page.waitForFunction(() => document.getElementById('player-more-sheet').classList.contains('active'));
      await page.click('#voice-btn');
      await page.waitForFunction(() => document.getElementById('voice-sheet').classList.contains('active'));
      assert.strictEqual((await state('voice-sheet')).inert, false);
      passed++;

      // More filters in the player voice sheet is a native disclosure with
      // the Settings chevron; the summary reports expanded state.
      await page.waitForSelector('#player-voice-filter-bar details.voice-more-disclosure > summary .voice-filters-chevron');
      const closed = await page.evaluate(() => document.querySelector('#player-voice-filter-bar details.voice-more-disclosure').open);
      await page.click('#player-voice-filter-bar details.voice-more-disclosure > summary');
      const after = await page.evaluate(() => {
        const details = document.querySelector('#player-voice-filter-bar details.voice-more-disclosure');
        const chevron = getComputedStyle(details.querySelector('.voice-filters-chevron')).transform;
        return { open: details.open, chevron, color: getComputedStyle(details.querySelector('summary')).color, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim() };
      });
      assert.strictEqual(closed, false);
      assert.strictEqual(after.open, true);
      assert.notStrictEqual(after.chevron, 'none', 'the chevron turns when open');
      // The browser's accessibility tree reports the summary as expanded.
      const cdp = await browserContext.newCDPSession(page);
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#player-voice-filter-bar details.voice-more-disclosure > summary' });
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const expanded = nodes[0].properties?.find(property => property.name === 'expanded')?.value?.value;
      assert.strictEqual(expanded, true, 'summary exposes expanded state');
      await page.click('#player-voice-filter-bar .voice-more-filters [data-facet-group="gender"][data-facet-value="male"]');
      assert.strictEqual(await page.evaluate(() => document.querySelector('#player-voice-filter-bar details.voice-more-disclosure').open), true, 'stays open after a filter change');
      assert.match(await page.locator('#player-voice-filter-bar .voice-filters-active').textContent(), /Male/);
      await page.click('#player-voice-filter-bar .voice-more-filters [data-facet-group="gender"][data-facet-value="all"]');
      passed++;
      await browserContext.close();
    }

    // Chromium parses the manifest without errors and sees both purposes.
    {
      const browserContext = await context('chromium', 1024, 768);
      const page = await browserContext.newPage();
      await page.goto(`${environment.origin}/#/library`);
      const cdp = await browserContext.newCDPSession(page);
      const { errors, data } = await cdp.send('Page.getAppManifest');
      assert.deepStrictEqual(errors.filter(error => error.critical), [], 'no critical manifest errors');
      assert.ok(data.includes('"maskable"') && data.includes('"shortcuts"'));
      passed++;
      await browserContext.close();
    }
  } finally {
    await browsers.chromium.close();
    await browsers.webkit.close();
    await environment.close();
  }
  console.log(`test-system-ui-fixes: ${passed} passed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
