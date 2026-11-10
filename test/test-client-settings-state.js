// Client-side settings state: resets and account separation.
const assert = require('assert');
const { loadClientModule, memoryStorage } = require('./fixtures/client-module-loader');

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

const API_STUB = `
  export const apiGet = (...args) => globalThis.__api.get(...args);
  export const apiSend = (...args) => globalThis.__api.send(...args);
  export const getCurrentUserId = () => globalThis.__api.userId;
  export const getOfflineStorageScopeId = () => globalThis.__api.userId;
  export const canClaimLegacyOfflineStorage = () => globalThis.__api.settled !== false;
  export const getCurrentUser = () => ({ id: globalThis.__api.userId });
`;
const TOAST_STUB = 'export const showToast = () => {}; export const announceToScreenReader = () => {};';

function installBrowser(entries = []) {
  global.localStorage = memoryStorage(entries);
  global.__defaultSpeed = null;
  const sent = [];
  global.__api = {
    userId: 'user_a',
    remote: {},
    sent,
    async get() { return { settings: { ...global.__api.remote } }; },
    async send(method, url, body) { sent.push({ method, url, body }); return { success: true }; }
  };
  global.document = { dispatchEvent() {}, addEventListener() {} };
  global.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  const windowListeners = new Map();
  global.addEventListener = (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(listener);
  };
  // api.js setCurrentUser: listeners run while the old identity is active.
  global.__switchAccount = toScope => {
    const fromScope = global.__api.userId;
    for (const listener of windowListeners.get('xandrio:authscopechange') || []) {
      listener({ detail: { fromScope, toScope, waitUntil() {} } });
    }
    global.__api.userId = toScope;
  };
  return global.localStorage;
}

function loadSettings() {
  return loadClientModule('js/client-settings.js', {
    './api.js': API_STUB,
    './ui/toast.js': TOAST_STUB
  });
}

function loadPlaybackSpeedModule() {
  return loadClientModule('js/views/playback-speed.js', {
    '../api.js': API_STUB,
    '../ui/toast.js': TOAST_STUB,
    '../client-settings.js': `
      export const getDefaultSpeed = () => globalThis.__defaultSpeed ?? null;
      export const getSkipInterval = () => 15;
      export const setClientSetting = () => {};`,
    '../ui/sheets.js': 'export const registerSheet = () => ({ open() {}, close() {}, dismiss() {} });',
    '../ui/keys.js': 'export const onActivate = () => () => {};',
    '../features/listening-queue.js': 'export const getBookSpeedSetting = () => null;'
  });
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  console.log('\n━━━ Client settings state ━━━');

  await test('null resets any client setting locally and on the server', async () => {
    installBrowser();
    const settings = await loadSettings();
    settings.setClientSetting('skipIntervalSeconds', 30);
    settings.setClientSetting('skipIntervalSeconds', null);
    await flush();
    assert.strictEqual(settings.getSkipInterval(), 15);
    assert.deepStrictEqual(global.__api.sent.map(call => call.body.settings), [
      { skipIntervalSeconds: 30 },
      { skipIntervalSeconds: null }
    ]);
    settings.setClientSetting('defaultSpeed', 1.5);
    settings.setClientSetting('defaultSpeed', null);
    await flush();
    assert.strictEqual(settings.getDefaultSpeed(), null);
    assert.deepStrictEqual(global.__api.sent.at(-1).body.settings, { defaultSpeed: null });
  });

  await test('a Settings default speed outranks the device\'s last chosen speed', async () => {
    const storage = installBrowser([['xandrio_playback_speed:user_a', '1.5']]);
    global.__defaultSpeed = null;
    const speed = await loadPlaybackSpeedModule();
    assert.strictEqual(speed.getGlobalPlaybackSpeed(), 1.5);
    speed.useDefaultPlaybackSpeed();
    assert.strictEqual(speed.getGlobalPlaybackSpeed(), 1);
    global.__defaultSpeed = 1.25;
    assert.strictEqual(speed.getGlobalPlaybackSpeed(), 1.25);
    assert.strictEqual(storage.getItem('xandrio_playback_speed:user_a'), null);
    const settingsView = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'views', 'settings.js'), 'utf8');
    assert.match(settingsView, /setClientSetting\('defaultSpeed'[^\n]*\n\s*useDefaultPlaybackSpeed\(\);/);
  });

  await test('one account\'s local settings never reach the next account on the device', async () => {
    const storage = installBrowser();
    const settings = await loadSettings();
    settings.setClientSetting('skipIntervalSeconds', 30);
    settings.setClientSetting('progressDisplayMode', 'elapsed');
    await flush();
    global.__switchAccount('user_b');
    assert.strictEqual(settings.getSkipInterval(), 15, 'the new account starts from its own copy');
    global.__api.remote = { shelfRowDensity: 'comfortable' };
    await settings.loadClientSettings({ force: true });
    assert.strictEqual(settings.getSkipInterval(), 15, 'its profile merges onto its own copy');
    assert.strictEqual(settings.getProgressDisplayMode(), 'remaining');
    assert.strictEqual(settings.getShelfRowDensity(), 'comfortable');
    assert.strictEqual(JSON.parse(storage.getItem('xandrio_client_settings:user_a')).skipIntervalSeconds, 30);
    assert.strictEqual(JSON.parse(storage.getItem('xandrio_client_settings:user_b')).skipIntervalSeconds, undefined);
    assert.strictEqual(storage.getItem('xandrio_client_settings'), null);
    global.__switchAccount('user_a');
    assert.strictEqual(settings.getSkipInterval(), 30, 'the first account keeps its choices');
  });

  await test('an unscoped copy moves only to the one account that can have written it', async () => {
    const legacy = JSON.stringify({ _v: 2, skipIntervalSeconds: 30 });
    let storage = installBrowser([['xandrio_client_settings', legacy], ['xandrio_playback_speed', '1.5']]);
    let settings = await loadSettings();
    assert.strictEqual(settings.getSkipInterval(), 30);
    assert.strictEqual(storage.getItem('xandrio_client_settings'), null);
    assert.strictEqual(JSON.parse(storage.getItem('xandrio_client_settings:user_a')).skipIntervalSeconds, 30);
    let speed = await loadPlaybackSpeedModule();
    assert.strictEqual(speed.getGlobalPlaybackSpeed(), 1.5);
    assert.strictEqual(storage.getItem('xandrio_playback_speed'), null);

    // Another account has used this device, so the owner is unknowable.
    storage = installBrowser([
      ['xandrio_client_settings', legacy],
      ['xandrio_playback_speed', '1.5'],
      ['xandrio_offline_books:user_b', '[]']
    ]);
    settings = await loadSettings();
    assert.strictEqual(settings.getSkipInterval(), 15);
    assert.strictEqual(storage.getItem('xandrio_client_settings'), null, 'the unattributed copy is dropped');
    speed = await loadPlaybackSpeedModule();
    assert.strictEqual(speed.getGlobalPlaybackSpeed(), 1);
    assert.strictEqual(storage.getItem('xandrio_playback_speed'), null);

    // Before the account is settled the copy is neither used nor dropped.
    storage = installBrowser([['xandrio_client_settings', legacy]]);
    global.__api.settled = false;
    settings = await loadSettings();
    assert.strictEqual(settings.getSkipInterval(), 15);
    assert.strictEqual(storage.getItem('xandrio_client_settings'), legacy);
    delete global.__api.settled;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
