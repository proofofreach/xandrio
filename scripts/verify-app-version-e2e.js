'use strict';
// Failure cases: stale shell must not claim current; offline and failed checks
// must clear prior success; retry must recover; controls must fit small screens.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('../test/fixtures/scenarios/lib/environment');
(async () => {
  const output = path.resolve(__dirname, '../output/app-version');
  await fs.mkdir(output, { recursive: true });
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['empty'] });
  const browser = await chromium.launch();
  const report = [];
  try {
    const live = await fetch(`${environment.origin}/api/deployment`).then(r => r.json());
    assert.match(live.appBuild, /^xandrio-v\d+$/);
    for (const width of [320, 390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      await page.goto(`${environment.origin}/#/settings`);
      await page.waitForFunction(() => document.querySelector('#app-version-status')?.textContent === 'Up to date');
      const loaded = await page.locator('#app-version').textContent();
      assert.equal(loaded, `Version ${live.appBuild.replace('xandrio-v', '')}`);
      let mode = 'update';
      await page.route('**/api/deployment', route => mode === 'failure' ? route.abort() : route.fulfill({ json: { appBuild: mode === 'update' ? 'xandrio-v99999' : live.appBuild } }));
      await page.locator('#app-version-check').click();
      await page.waitForFunction(() => document.querySelector('#app-version-status').textContent === 'Version 99999 available');
      assert.equal(await page.locator('#app-version').textContent(), loaded);
      assert(await page.locator('#app-version-reload').isVisible());
      await page.screenshot({ path: path.join(output, `${width}-update.png`), fullPage: true });
      const box = await page.locator('#app-version-check').boundingBox();
      assert(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
      mode = 'failure'; await page.locator('#app-version-check').click();
      await page.waitForFunction(() => document.querySelector('#app-version-status').textContent.includes('Could not check'));
      assert(!(await page.locator('#app-version-reload').isVisible()));
      await context.setOffline(true); await page.locator('#app-version-check').click();
      await page.waitForFunction(() => document.querySelector('#app-version-status').textContent.includes('Offline'));
      await context.setOffline(false); mode = 'current';
      await page.locator('#app-version-check').click();
      await page.waitForFunction(() => document.querySelector('#app-version-status').textContent === 'Up to date');
      await page.screenshot({ path: path.join(output, `${width}-current.png`), fullPage: true });
      report.push({ width, loaded, passed: true });
      await context.tracing.stop({ path: path.join(output, `${width}.trace.zip`) });
      await context.close();
      console.log(`PASS version and update states at ${width}px`);
    }
  } finally {
    await browser.close(); await environment.close();
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
