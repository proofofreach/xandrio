const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

(async () => {
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full' });
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  try {
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage();
        await page.goto(`${environment.origin}/#/library`);
        if (width < 760) {
          const resumeCard = page.locator('.rail-card').first();
          await resumeCard.waitFor();
          const card = await resumeCard.boundingBox();
          const cover = await resumeCard.locator('.rail-cover-wrap').boundingBox();
          const meta = await resumeCard.locator('.rail-meta').boundingBox();
          assert(card.height >= 44 && card.height <= 80, 'Continue cards stay compact one-tap targets');
          assert(cover.y >= card.y && cover.y + cover.height <= card.y + card.height + 1, 'cover stays inside the compact card');
          assert(meta.y >= card.y && meta.y + meta.height <= card.y + card.height, 'resume point stays beside the cover');
          assert.match(await resumeCard.locator('.rail-meta').textContent(), /^(Ch \d+|Section \d+|[^·]+)( · .+)?$/, 'resume point names the chapter');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await resumeCard.focus();
          await page.keyboard.press('Enter');
        } else {
          // Desktop: the table sorted by Last played is the switcher.
          const row = page.locator('.book-item[data-book-id="scn-meridian"] .book-card-open');
          await row.waitFor();
          assert.equal(await page.locator('#continue-rail').isVisible(), false);
          const height = (await page.locator('.book-item[data-book-id="scn-meridian"] .book-item-inner').boundingBox()).height;
          assert(Math.abs(height - 60) <= 1, `desktop table rows are 60px (got ${height})`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await row.focus();
          await page.keyboard.press('Enter');
        }
        await page.waitForURL('**/#/player/scn-meridian');
        await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none' && document.getElementById('book-title')?.textContent === 'The Meridian Line');
        passed++;
        await page.goto(`${environment.origin}/#/settings/sleep`);
        const automatic = page.locator('#auto-sleep-enabled');
        assert.equal(await automatic.isChecked(), false);
        assert.equal(await page.locator('#auto-sleep-start').isDisabled(), true);
        await automatic.check();
        await page.locator('#auto-sleep-start').fill('22:30');
        await page.locator('#auto-sleep-end').fill('07:30');
        await page.locator('#auto-sleep-duration').selectOption('45');
        assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('xandrio_auto_sleep_schedule'))),
          { enabled: true, start: '22:30', end: '07:30', minutes: 45, mode: 'time' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.AUTO_SLEEP_SHOTS) await page.screenshot({ path: `${process.env.AUTO_SLEEP_SHOTS}/settings-${width}.png`, fullPage: true });
        await page.reload();
        await page.waitForURL('**/#/settings/sleep');
        await page.waitForFunction(() => document.getElementById('auto-sleep-enabled')?.checked === true);
        assert.equal(await page.locator('#auto-sleep-start').inputValue(), '22:30');
        assert.equal(await page.locator('#auto-sleep-duration').inputValue(), '45');
        await automatic.uncheck();
        passed++;
        if (width >= 760) {
          await page.locator('[data-settings-link="voice"]').click();
          await page.waitForURL('**/#/settings/voice');
          await page.waitForFunction(() => document.activeElement?.id === 'settings-pane-title-voice');
          assert.equal(await page.locator('#settings-hub').isVisible(), true);
        } else {
          await page.locator('.settings-pane:not([hidden]) .settings-pane-back').click();
          await page.waitForURL('**/#/settings');
          await page.locator('#settings-hub').waitFor({ state: 'visible' });
          assert.equal(await page.locator('[data-settings-pane="voice"]').isVisible(), false);
        }
        assert.equal(await page.locator('#settings-playback-summary').textContent(), '1.0× · Skip 15 s');
        assert.equal(await page.locator('#settings-sleep-summary').textContent(), 'Off');
        assert.equal(await page.locator('#settings-language-summary').textContent(), 'English');
        if (width < 760) await page.locator('[data-settings-link="voice"]').click();
        await page.waitForURL('**/#/settings/voice');
        const firstVoice = page.locator('[data-settings-pane="voice"]:not([hidden]) #voice-list .voice-card').first();
        await firstVoice.waitFor();
        assert.equal(await firstVoice.locator('[data-voice-action="select"]').getAttribute('aria-pressed'), 'true', 'the selected voice is first');
        for (const button of [firstVoice.locator('.voice-save-btn'), firstVoice.locator('.voice-play-btn')]) {
          const target = await button.boundingBox();
          assert(target.width >= 44 && target.height >= 44, 'voice actions have full touch targets');
        }
        const create = page.locator('#voice-list .voice-create');
        await create.waitFor();
        assert.equal(await create.getAttribute('open'), null);
        await create.locator('summary').click();
        assert(await create.locator('input[name="audio"]').isVisible());
        assert(await create.locator('input[name="authorityConfirmed"]').isVisible());
        passed++;
        await page.goto(`${environment.origin}/#/player/scn-meridian`);
        await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none' && document.getElementById('book-title')?.textContent === 'The Meridian Line');
        for (const id of ['prev-chapter-btn', 'next-chapter-btn']) {
          const target = await page.locator(`#${id}`).boundingBox();
          assert(target.width >= 44 && target.height >= 44, 'chapter actions have full touch targets');
        }
        if (width === 390) {
          await page.evaluate(() => { document.documentElement.style.zoom = '1.4'; });
          const play = await page.locator('#play-pause-btn').boundingBox();
          assert(play.y >= 0 && play.y + play.height <= 844, 'Play stays visible at enlarged text scale');
          const transport = await page.locator('.pl-transport > button').evaluateAll(buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return { id: button.id, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
          }));
          assert(transport.every(button => button.left >= 0 && button.right <= 390 && button.width >= 44 && button.height >= 44),
            `all transport targets remain visible and usable with enlarged text: ${JSON.stringify(transport)}`);
          await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        }
        await page.locator('#chapter-sheet-btn').click();
        assert(await page.locator('#chapter-sheet').isVisible());
        await page.keyboard.press('Escape');
        const layout = await page.evaluate(() => {
          const status = document.getElementById('player-narration');
          document.getElementById('playback-resume-prompt').hidden = false;
          const author = document.getElementById('book-author-header').getBoundingClientRect();
          const chapter = document.getElementById('chapter-sheet-btn').getBoundingClientRect();
          const resume = document.getElementById('playback-resume-prompt').getBoundingClientRect();
          const progress = document.querySelector('.pl-scrub').getBoundingClientRect();
          return { status: !!status, ordered: resume.top >= author.bottom && resume.bottom <= chapter.top + 1 && chapter.bottom <= progress.top + 1,
            overflow: document.documentElement.scrollWidth > innerWidth, duplicate: !!document.getElementById('utility-chapters-btn') };
        });
        assert(layout.status && layout.ordered, 'recovery sits in the narration area, above the chapter row and timeline');
        assert.equal(layout.overflow, false, 'player does not overflow the viewport');
        assert.equal(layout.duplicate, false);
        passed++;
      } finally { await context.close(); }
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const entry = { id: 'sample', title: 'A listening history', chapterIndex: 0, chapterCount: 2, percent: 25 };
      let seconds = 59;
      await page.route('**/api/stats', route => route.fulfill({ json: {
        totalSecondsListened: seconds, booksFinishedCount: 0, booksInProgressCount: 1,
        recent: [entry], inProgress: [entry]
      } }));
      for (const [total, expected] of [[59, '< 1m'], [180, '3m'], [3660, '1h 01m']]) {
        seconds = total;
        if (page.url() === `${environment.origin}/#/stats`) await page.reload();
        else await page.goto(`${environment.origin}/#/stats`);
        await page.waitForFunction(value => document.querySelector('.stat-tile-value')?.textContent === value, expected);
        assert.equal(await page.locator('[data-book-id="sample"]').count(), 1, 'history never repeats an in-progress book');
        assert.equal(await page.locator('.stat-tile-label').first().textContent(), 'listened');
        passed++;
      }
      await page.route('**/api/search', route => route.fulfill({ json: { works: [] } }));
      await page.goto(`${environment.origin}/#/search`);
      await page.waitForFunction(() => document.getElementById('search-filter-summary')?.textContent.includes('Gutenberg'));
      assert.equal(await page.locator('.search-header h2').textContent(), 'Find');
      await page.locator('#search-input').fill('No matching title');
      await page.locator('#search-btn').click();
      await page.locator('[data-search-edit]').waitFor();
      const beforeSources = new URL(page.url()).searchParams.get('sources');
      await page.locator('[data-search-edit]').click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'search-input');
      await page.locator('[data-search-filters]').click();
      assert(await page.locator('#search-filter-panel').isVisible());
      assert.equal(new URL(page.url()).searchParams.get('sources'), beforeSources, 'recovery does not change source selection');
      await page.locator('#language-filter').selectOption('fr');
      assert.match(await page.locator('#search-filter-summary').textContent(), /Français/);
      passed++;
      await page.goto(`${environment.origin}/#/guide/scn-fieldnotes`);
      await page.waitForFunction(() => document.getElementById('guide-view')?.classList.contains('active') && document.getElementById('guide-title')?.textContent === 'Field Notes on Silence');
      await page.locator('[data-guide-listen]').waitFor();
      assert.equal(await page.locator('[data-guide-listen]').count(), 1);
      const narration = await page.locator('.guide-narration').boundingBox();
      assert(narration.height < 100, 'the initial guide audio action leaves room for reading');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      passed++;
    } finally { await context.close(); }
    console.log(`${passed} passed, 0 failed`);
  } finally { await browser.close(); await environment.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
