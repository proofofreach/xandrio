const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

async function main() {
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'], defaultDataset: 'full' });
  const browser = await chromium.launch({ headless: true });
  let passed = 0;
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, serviceWorkers: 'block', extraHTTPHeaders: { 'X-Xandrio-Scenario': 'player:full' } });
      try {
        const page = await context.newPage();
        await page.goto(`${environment.origin}/#/player/scn-meridian`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Number(document.getElementById('progress-slider')?.dataset.duration) > 0
          && document.getElementById('audio-loading')?.style.display === 'none');
        const timer = page.locator(viewport.width < 760 ? '#utility-timer-btn' : '#timer-btn-inline');
        await timer.click();
        assert.equal(await page.locator('#cancel-timer-btn').isVisible(), false);
        await page.locator('.timer-option[data-minutes="15"]').click();
        await page.waitForFunction(() => !document.getElementById('timer-modal').classList.contains('active'));
        const deadline = await page.evaluate(() => Number(localStorage.getItem('xandrio_sleep_timer_end')));
        await timer.click();
        assert.equal(await page.locator('#timer-modal').getAttribute('aria-hidden'), 'false');
        await page.locator('#extend-timer-btn').click();
        const extended = await page.evaluate(() => Number(localStorage.getItem('xandrio_sleep_timer_end')));
        assert(Math.abs(extended - deadline - 300000) < 1000);
        await page.locator('#cancel-timer-btn').click();
        await page.waitForFunction(() => !document.getElementById('timer-modal').classList.contains('active'));
        assert.equal(await page.evaluate(() => localStorage.getItem('xandrio_sleep_timer_end')), null);
        passed++;

        const slider = page.locator('#progress-slider');
        const box = await slider.boundingBox();
        assert(box.height >= 44, `seek target is ${box.height}px`);
        assert.equal(await slider.getAttribute('step'), 'any');
        await page.evaluate(async () => {
          const view = await import('/js/views/player-ui.js');
          view.paintChapterTimes({ currentTime: 1800, totalTime: 3600, progressPercent: 50 });
          document.getElementById('progress-slider').addEventListener('change', event => { window.seekValue = Number(event.target.value); }, { capture: true });
        });
        await slider.focus();
        await slider.press('ArrowRight');
        assert(Math.abs(await page.evaluate(() => window.seekValue) - (1805 / 3600 * 100)) < 0.0001, 'keyboard seeks five seconds, not one percent');
        passed++;

        await page.locator(viewport.width < 760 ? '#utility-speed-btn' : '#speed-sheet-btn').click();
        await page.locator('.speed-preset[data-speed="2"]').click();
        await page.locator('#close-speed-sheet-btn').click();
        await page.waitForFunction(() => !document.getElementById('speed-sheet').classList.contains('active'));
        const chapterTimes = await page.evaluate(async () => {
          const view = await import('/js/views/player-ui.js');
          localStorage.setItem('xandrio_time_display', 'remaining');
          view.paintChapterTimes({ currentTime: 120, totalTime: 3600, progressPercent: 120 / 36 });
          return {
            remaining: document.getElementById('chapter-progress-total').textContent,
            accessible: document.getElementById('progress-slider').getAttribute('aria-valuetext')
          };
        });
        assert.equal(chapterTimes.remaining, '-29:00 left');
        assert.match(chapterTimes.accessible, /2:00 of 60:00.*29:00 listening time left at 2x/);
        await page.locator('[data-progress-scope="book"]').click();
        const bookTimes = await page.evaluate(() => ({ duration: Number(document.getElementById('progress-slider').dataset.duration), value: Number(document.getElementById('progress-slider').value), text: document.getElementById('chapter-progress-total').textContent }));
        const expectedRemaining = Math.max(0, bookTimes.duration * (1 - bookTimes.value / 100)) / 2;
        assert.match(bookTimes.text, /left$/);
        const format = value => { const seconds = Math.round(value * 1e6) / 1e6; return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; };
        assert.equal(bookTimes.text, `-${format(expectedRemaining)} left`);
        assert.match(await slider.getAttribute('aria-valuetext'), /listening time left at 2x/);
        passed++;

        await page.evaluate(async () => (await import('/js/views/player-ui.js')).setPlaybackBuffering(true));
        assert.equal(await page.locator('#playback-buffering').isVisible(), true);
        await page.evaluate(async () => (await import('/js/views/player-ui.js')).setPlaybackBuffering(false));
        assert.equal(await page.locator('#playback-buffering').isVisible(), false);
        passed++;
        if (process.env.UI_REVIEW_SHOTS) await page.screenshot({ path: `${process.env.UI_REVIEW_SHOTS}/player-${viewport.width}.png`, fullPage: true });
      } finally { await context.close(); }
    }
    console.log(`${passed} passed, 0 failed`);
  } finally { await browser.close(); await environment.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
