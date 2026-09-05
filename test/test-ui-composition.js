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
        await page.goto(`${environment.origin}/#/settings`);
        await page.locator('[data-settings-group="settings-group-1"]').click();
        assert.equal(new URL(page.url()).hash, '#/settings');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-group-title-1');
        const voiceSection = page.locator('#settings-group-1 details.settings-section');
        await voiceSection.locator('summary').first().click();
        const create = page.locator('#voice-list .voice-create');
        await create.waitFor();
        assert.equal(await create.getAttribute('open'), null);
        await create.locator('summary').click();
        assert(await create.locator('input[name="audio"]').isVisible());
        assert(await create.locator('input[name="authorityConfirmed"]').isVisible());
        passed++;
        await page.goto(`${environment.origin}/#/player/scn-meridian`);
        await page.waitForFunction(() => document.getElementById('audio-loading')?.style.display === 'none' && document.getElementById('book-title')?.textContent === 'The Meridian Line');
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
    console.log(`${passed} passed, 0 failed`);
  } finally { await browser.close(); await environment.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
