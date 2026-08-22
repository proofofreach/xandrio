const assert = require('assert');
const { chromium } = require('playwright');
const { startScenarioEnvironment } = require('./fixtures/scenarios/lib/environment');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function loginContext(browser) {
  return browser.newContext({
    serviceWorkers: 'block',
    extraHTTPHeaders: { 'X-Xandrio-Scenario': 'login:full' }
  });
}

async function openLoginGate(page, origin) {
  await page.goto(`${origin}/#/library`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-view.active').waitFor({ state: 'visible', timeout: 15000 });
}

async function main() {
  const environment = await startScenarioEnvironment();
  const browser = await chromium.launch({ headless: true });
  try {
    await test('initial offline login boot gives accessible guidance and does not submit credentials', async () => {
      const context = await loginContext(browser);
      try {
        await context.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'onLine', {
            configurable: true,
            get: () => false
          });
        });
        const page = await context.newPage();
        let signInRequests = 0;
        page.on('request', request => {
          if (new URL(request.url()).pathname === '/api/auth/login') signInRequests += 1;
        });
        await openLoginGate(page, environment.origin);

        const offlineStatus = page.locator('#login-offline-status');
        await offlineStatus.waitFor({ state: 'visible' });
        assert.match(await offlineStatus.textContent(), /offline.*Reconnect to sign in/i);
        assert.strictEqual(await offlineStatus.getAttribute('role'), 'status');
        assert.strictEqual(await offlineStatus.getAttribute('aria-live'), 'polite');
        await expectDisabledReconnect(page);

        await page.locator('#login-username').fill('reader');
        await page.locator('#login-password').fill('not-the-right-password');
        await page.locator('#login-password').press('Enter');
        await page.waitForTimeout(250);
        assert.strictEqual(signInRequests, 0, 'offline sign-in must not issue an auth request');
      } finally {
        await context.close();
      }
    });

    await test('login gate responds to offline and online transitions', async () => {
      const context = await loginContext(browser);
      try {
        const page = await context.newPage();
        await openLoginGate(page, environment.origin);
        await page.locator('#login-offline-status').waitFor({ state: 'hidden' });
        assert.strictEqual(await page.locator('#login-submit').isDisabled(), false);

        await context.setOffline(true);
        await page.locator('#login-offline-status').waitFor({ state: 'visible' });
        await expectDisabledReconnect(page);

        await context.setOffline(false);
        await page.locator('#login-offline-status').waitFor({ state: 'hidden' });
        assert.strictEqual(await page.locator('#login-submit').isDisabled(), false);
        assert.strictEqual(await page.locator('#login-submit').textContent(), 'Sign In');
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    await environment.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function expectDisabledReconnect(page) {
  const submit = page.locator('#login-submit');
  assert.strictEqual(await submit.isDisabled(), true);
  assert.strictEqual(await submit.textContent(), 'Reconnect to sign in');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
