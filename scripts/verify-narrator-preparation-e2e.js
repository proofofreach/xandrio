'use strict';
// E2E fail-first coverage: authored identifiers and preparation coverage count
// different quantities. API fixtures represent one premium polling snapshot;
// the complete app, loaded narrator and all rendering remain real.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { startScenarioEnvironment } = require('../test/fixtures/scenarios/lib/environment');
const output = path.resolve(__dirname, '../output/ui-rewrite-fixes/narrator-preparation');
const baseline = process.argv.includes('--baseline');
(async () => {
  await fs.mkdir(output, { recursive: true });
  let environment;
  const report = { passed: false, checks: [] };
  try {
    environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'] });
    for (const name of (baseline ? ['chromium'] : ['chromium', 'webkit'])) {
      const browser = await ({ chromium, webkit }[name]).launch();
      try {
        for (const viewport of (baseline ? [{ name: 'phone', width: 390, height: 844 }] : [{ name: 'phone', width: 390, height: 844 }, { name: 'pane', width: 1440, height: 900 }])) {
          const label = `${name}-${viewport.name}`;
          const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block' });
          await context.route('**/*', route => new URL(route.request().url()).origin === environment.origin ? route.continue() : route.abort());
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          const page = await context.newPage();
          await page.route('**/api/voices', route => route.fulfill({ json: { current: 'premium:ryan', voices: [{ id: 'premium:ryan', name: 'Ryan', tier: 'premium', provider: 'chatterbox', language: 'en' }, { id: 'edge:andrew', name: 'Andrew', provider: 'edge', language: 'en' }] } }));
          await page.route('**/api/narration/scn-meridian', route => route.fulfill({ json: { voiceId: 'premium:ryan', premiumActive: true, inherited: false, fallbackPolicy: 'instant' } }));
          await page.route('**/api/premium-prep/scn-meridian/status?*', route => route.fulfill({ json: { status: 'generating', chapters: [true, true, true, true, true], firstUnreadyChapter: null, totalChapters: 5, readyChapters: 5, readyAudioSeconds: 120, chapterIndex: 2, offsetSeconds: 0, instantVoice: 'edge:andrew', enabled: true } }));
          await page.route('**/api/position/scn-meridian', route => route.fulfill({ json: { position: null } }));
          await page.route('**/api/book/scn-meridian', async route => {
            const response = await route.fetch(); const data = await response.json();
            data.chapters = data.chapters.slice(0, 3).map((chapter, index) => ({ ...chapter, title: `Chapter ${[2, 7, 9][index]}`, type: 'chapter', empty: false }));
            data.chapters.unshift({ ...data.chapters[0], title: 'Copyright', type: 'copyright' }, { ...data.chapters[0], title: 'Acknowledgements', type: 'frontmatter' });
            await route.fulfill({ response, json: data });
          });
          await page.route('**/api/chunks/scn-meridian/*/*', route => route.fulfill({ json: { servedTier: 'instant', voiceId: 'edge:andrew', status: 'ready', targetStatus: 'ready', ready: true, totalChunks: 1, readyChunks: 1 } }));
          try {
            await page.goto(`${environment.origin}/#/player/scn-meridian`);
            await page.waitForFunction(() => document.getElementById('hq-voice-prep')?.dataset.state === 'generating' && document.getElementById('player-voice-name')?.textContent === 'Andrew');
            const evidence = await page.evaluate(() => ({ heading: document.getElementById('hq-prep-heading').innerText, text: document.getElementById('player-view').innerText, label: document.getElementById('player-voice-status').getAttribute('aria-label') }));
            assert.match(evidence.heading, /3 of 3 chapters/); assert(!/3 of 9 chapters/.test(evidence.heading));
            assert.match(evidence.text, /Chapter (?:2|7|9) of 9/);
            assert.match(evidence.label, /Andrew.*Ryan selected/);
            report.checks.push({ label, passed: true, evidence }); console.log(`PASS ${label}`);
          } catch (error) { report.checks.push({ label, passed: false, error: error.message }); console.log(`FAIL ${label}: ${error.message}`); }
          finally { await page.screenshot({ path: path.join(output, `${label}${baseline ? '-before' : ''}.png`), fullPage: true }); await context.tracing.stop({ path: path.join(output, `${label}${baseline ? '-before' : ''}.trace.zip`) }); await context.close(); }
        }
      } finally { await browser.close(); }
    }
  } catch (error) { report.error = error.stack; }
  finally { await environment?.close(); report.passed = !report.error && report.checks.every(check => check.passed); await fs.writeFile(path.join(output, `${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1; }
})();
