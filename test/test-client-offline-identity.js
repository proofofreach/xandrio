const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

function installBrowser(storage, fetchImpl) {
  global.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  global.document = {
    cookie: '',
    dispatchEvent() {}
  };
  global.CustomEvent = class CustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
  global.window = {
    location: { origin: 'https://reader.test' },
    fetch: fetchImpl
  };
  global.navigator = { userAgent: 'Test Browser' };
}

async function loadApi(instance) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'api.js'),
    'utf8'
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${instance}`;
  return import(moduleUrl);
}

(async () => {
  await test('offline storage follows the authenticated account across restart and clears on sign-out', async () => {
    const storage = new Map();
    const fetchImpl = async url => {
      if (String(url).endsWith('/api/auth/logout')) return Response.json({ success: true });
      throw new Error(`Unexpected fetch ${url}`);
    };
    installBrowser(storage, fetchImpl);
    const firstBoot = await loadApi('first');

    assert.strictEqual(firstBoot.canClaimLegacyOfflineStorage(), false);
    firstBoot.setCurrentUser({ id: 'account_a', username: 'alice' });
    assert.strictEqual(firstBoot.canClaimLegacyOfflineStorage(), true);
    assert.strictEqual(firstBoot.getOfflineStorageScopeId(), 'account_a');
    assert.strictEqual(storage.get('xandrio_offline_account_scope'), 'account_a');

    installBrowser(storage, fetchImpl);
    const offlineRestart = await loadApi('restart');
    assert.strictEqual(offlineRestart.getCurrentUser(), null);
    assert.strictEqual(offlineRestart.getOfflineStorageScopeId(), 'account_a');

    offlineRestart.setCurrentUser({ id: 'account_b', username: 'bob' });
    assert.strictEqual(offlineRestart.getOfflineStorageScopeId(), 'account_b');
    assert.strictEqual(storage.get('xandrio_offline_account_scope'), 'account_b');

    await offlineRestart.logout();
    assert.strictEqual(storage.has('xandrio_offline_account_scope'), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
