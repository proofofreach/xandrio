const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

(async () => {
  const environment = await startScenarioEnvironment({ proxyPort: 0, datasets: ['full'] });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block', extraHTTPHeaders: { 'X-Xandrio-Scenario': 'library:full' } });
    await page.route('**/api/cover/**', route => route.fulfill({ status: 503, body: 'Busy' }));
    const response = await page.goto(`${environment.origin}/#/library`, { waitUntil: 'networkidle' });
    assert(response.headers()['content-security-policy'].includes("script-src 'self'"));
    const cover = page.locator('#library-list .book-item-cover').first();
    await cover.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const image = document.querySelector('#library-list .book-item-cover');
      return image?.src.startsWith('data:image/svg+xml,') && image.complete && image.naturalWidth > 0;
    }, null, { timeout: 5000 });
    console.log('1 passed: failed library covers show a valid placeholder under production CSP');

    let requests = 0;
    await page.route('**/api/cover/retry-test?xandrio-offline-scope=reader', route => {
      requests++;
      return requests === 1
        ? route.fulfill({ status: 503, body: 'Busy' })
        : route.fulfill({ status: 200, contentType: 'image/jpeg', path: 'test/fixtures/scenarios/covers/cover-meridian.jpg' });
    });
    await page.evaluate(async () => {
      const { coverImageHTML } = await import('/js/util/format.js');
      document.body.insertAdjacentHTML('afterbegin', coverImageHTML({ id: 'retry-test', title: "'Quoted", hasCover: true, coverUrl: '/api/cover/retry-test?xandrio-offline-scope=reader' }, 'test-retry-cover'));
    });
    await page.waitForFunction(() => {
      const image = document.querySelector('.test-retry-cover');
      return image?.src.includes('/api/cover/retry-test?xandrio-offline-scope=reader') && image.complete && image.naturalWidth > 0;
    }, null, { timeout: 5000 });
    assert.equal(requests, 2, 'A temporary failure retries once and preserves the offline cache URL');

    let missingRequests = 0;
    await page.route('**/api/cover/missing-test', route => {
      missingRequests++;
      return route.fulfill({ status: 404, body: 'Missing' });
    });
    await page.evaluate(async () => {
      const { coverImageHTML } = await import('/js/util/format.js');
      document.body.insertAdjacentHTML('afterbegin', coverImageHTML({ id: 'missing-test', title: "'Quoted", hasCover: true }, 'test-missing-cover'));
    });
    await page.waitForTimeout(2600);
    assert.equal(missingRequests, 2, 'Permanent failures do not create a retry loop');
    assert(await page.locator('.test-missing-cover').evaluate(image => image.src.startsWith('data:') && image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('img[onerror]').count(), 0, 'Shared covers do not need inline handlers');
    console.log('3 passed, 0 failed');
  } finally {
    await browser.close();
    await environment.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
