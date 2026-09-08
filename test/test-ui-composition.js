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
        const resumeCard = page.locator('.rail-card').first();
        await resumeCard.waitFor();
        const cover = await resumeCard.locator('.rail-cover-wrap').boundingBox();
        const play = await resumeCard.locator('.rail-play-action').boundingBox();
        const dismiss = await resumeCard.locator('.rail-dismiss').boundingBox();
        assert(play.y >= cover.y && play.y + play.height <= cover.y + cover.height + 1,
          'resume action stays beside the cover instead of falling into an extra grid row');
        assert(dismiss.width >= 44 && dismiss.height >= 44, 'compact resume card retains its dismiss touch target');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await resumeCard.focus();
        await page.keyboard.press('Enter');
        await page.waitForURL('**/#/player/scn-meridian');
        await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none' && document.getElementById('book-title')?.textContent === 'The Meridian Line');
        passed++;
        await page.goto(`${environment.origin}/#/settings`);
        await page.locator('#settings-group-0 details.settings-section > summary').click();
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
        await page.locator('#settings-group-0 details.settings-section > summary').click();
        assert.equal(await automatic.isChecked(), true);
        assert.equal(await page.locator('#auto-sleep-start').inputValue(), '22:30');
        assert.equal(await page.locator('#auto-sleep-duration').inputValue(), '45');
        await automatic.uncheck();
        passed++;
        if (width >= 760) {
          await page.locator('[data-settings-group="settings-group-1"]').click();
          assert.equal(new URL(page.url()).hash, '#/settings');
          assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-group-title-1');
        } else {
          assert.equal(await page.locator('.settings-index').isVisible(), false, 'mobile settings omit duplicate jump navigation');
        }
        assert.equal(await page.locator('#settings-playback-summary').textContent(), 'Auto sleep off');
        assert.equal(await page.locator('#settings-language-summary').textContent(), 'English');
        const voiceSection = page.locator('#settings-group-1 details.settings-section');
        await voiceSection.locator('summary').first().click();
        const firstVoice = page.locator('#voice-list .voice-card').first();
        assert.equal(await firstVoice.getAttribute('aria-selected'), 'true', 'the selected voice is first');
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
          await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        }
        await page.locator('#chapter-sheet-btn').click();
        assert(await page.locator('#chapter-sheet').isVisible());
        await page.keyboard.press('Escape');
        const layout = await page.evaluate(() => {
          const status = document.querySelector('.player-status-area');
          document.getElementById('playback-resume-prompt').hidden = false;
          const chapter = document.getElementById('chapter-sheet-btn').getBoundingClientRect();
          const resume = document.getElementById('playback-resume-prompt').getBoundingClientRect();
          const progress = document.querySelector('.player-progress').getBoundingClientRect();
          return { status: !!status, ordered: resume.top >= chapter.bottom && resume.bottom <= progress.top + 1,
            overflow: document.documentElement.scrollWidth > innerWidth, duplicate: !!document.getElementById('utility-chapters-btn') };
        });
        assert(layout.status && layout.ordered, 'recovery remains between chapter and timeline');
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
      for (const [total, expected] of [[59, '<1'], [180, '3'], [3660, '1h 1m']]) {
        seconds = total;
        if (page.url() === `${environment.origin}/#/stats`) await page.reload();
        else await page.goto(`${environment.origin}/#/stats`);
        await page.waitForFunction(value => document.querySelector('.stat-tile-value')?.textContent === value, expected);
        assert.equal(await page.locator('[data-book-id="sample"]').count(), 1, 'history never repeats an in-progress book');
        assert.equal(await page.locator('.stat-tile-label').first().textContent(), total < 3600 ? 'minutes listened' : 'listened');
        passed++;
      }
      await page.route('**/api/search', route => route.fulfill({ json: { works: [] } }));
      await page.goto(`${environment.origin}/#/search`);
      await page.waitForFunction(() => document.getElementById('search-filter-summary')?.textContent.includes('Gutenberg'));
      assert.equal(await page.locator('.search-header h2').textContent(), 'Add a book');
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
