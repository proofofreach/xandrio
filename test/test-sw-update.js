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

class FakeWorker {
  constructor(state) {
    this.state = state;
    this.listeners = new Set();
    this.messages = [];
    this.reply = { activationRequested: true, reason: '' };
    this.activateOnRequest = true;
  }
  addEventListener(type, listener) {
    if (type === 'statechange') this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.delete(listener);
  }
  setState(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
  postMessage(message, ports) {
    this.messages.push(message);
    queueMicrotask(() => {
      ports[0].postMessage(this.reply);
      if (this.reply.activationRequested && this.activateOnRequest) {
        queueMicrotask(() => {
          this.setState('activated');
          this.onActivated?.();
        });
      }
    });
  }
}

class FakeChannel {
  constructor() {
    const port1 = { onmessage: null };
    this.port1 = port1;
    this.port2 = { postMessage: data => queueMicrotask(() => port1.onmessage?.({ data })) };
  }
}

function fakeServiceWorker({ waiting = null, installing = null, updateError = null, controlled = true, onUpdate = null } = {}) {
  const listeners = new Set();
  const registration = {
    waiting,
    installing,
    updates: 0,
    async update() {
      this.updates += 1;
      if (updateError) throw updateError;
      onUpdate?.(this);
    }
  };
  const serviceWorker = {
    controller: controlled ? { scriptURL: '/sw.js?v=old' } : null,
    registration,
    addEventListener(type, listener) {
      if (type === 'controllerchange') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
    async getRegistration() {
      return registration;
    },
    changeController() {
      this.controller = { scriptURL: '/sw.js?v=new' };
      for (const listener of [...listeners]) listener();
    }
  };
  for (const worker of [waiting, installing].filter(Boolean)) {
    worker.onActivated = () => { if (controlled) serviceWorker.changeController(); };
  }
  return serviceWorker;
}

const timers = {
  setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 30)),
  clearTimeout: handle => clearTimeout(handle)
};

(async () => {
  const { applyAppUpdate, UPDATE_MESSAGES } = await import(
    path.join(__dirname, '..', 'public', 'js', 'sw-update.mjs')
  );

  await test('a waiting worker is activated through the existing channel and the page reloads once', async () => {
    const waiting = new FakeWorker('installed');
    const serviceWorker = fakeServiceWorker({ waiting });
    const statuses = [];
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel,
      onStatus: text => statuses.push(text), reload: () => { reloads += 1; }
    });
    assert.deepStrictEqual(result, { ok: true, reason: '' });
    assert.deepStrictEqual(waiting.messages, [{ type: 'XANDRIO_ACTIVATE_WAITING' }]);
    assert.strictEqual(serviceWorker.registration.updates, 0, 'an installed update is not downloaded again');
    assert.strictEqual(reloads, 1);
    assert.deepStrictEqual(statuses, [UPDATE_MESSAGES.checking, UPDATE_MESSAGES.activating, UPDATE_MESSAGES.reloading]);
  });

  await test('a fresh update is fetched, installed, activated, and only then reloaded', async () => {
    const installing = new FakeWorker('installing');
    const serviceWorker = fakeServiceWorker({
      onUpdate(registration) {
        registration.installing = installing;
        setTimeout(() => {
          registration.installing = null;
          registration.waiting = installing;
          installing.setState('installed');
        }, 5);
      }
    });
    installing.onActivated = () => serviceWorker.changeController();
    const statuses = [];
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel,
      onStatus: text => statuses.push(text), reload: () => { reloads += 1; }
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(serviceWorker.registration.updates, 1);
    assert.strictEqual(reloads, 1);
    assert.deepStrictEqual(statuses, [
      UPDATE_MESSAGES.checking, UPDATE_MESSAGES.installing, UPDATE_MESSAGES.activating, UPDATE_MESSAGES.reloading
    ]);
  });

  await test('another open window blocks activation with a plain instruction and no reload', async () => {
    const waiting = new FakeWorker('installed');
    waiting.reply = { activationRequested: false, reason: 'other-clients' };
    const serviceWorker = fakeServiceWorker({ waiting });
    const statuses = [];
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel,
      onStatus: text => statuses.push(text), reload: () => { reloads += 1; }
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'otherWindows' });
    assert.strictEqual(reloads, 0);
    assert.strictEqual(statuses.at(-1), UPDATE_MESSAGES.otherWindows);
  });

  await test('a failed update download reports the connection and does not reload', async () => {
    const serviceWorker = fakeServiceWorker({ updateError: new TypeError('offline') });
    const statuses = [];
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel,
      onStatus: text => statuses.push(text), reload: () => { reloads += 1; }
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'offline' });
    assert.strictEqual(reloads, 0);
    assert.strictEqual(statuses.at(-1), UPDATE_MESSAGES.offline);
  });

  await test('a worker that never takes control times out instead of reloading into the old build', async () => {
    const waiting = new FakeWorker('installed');
    waiting.activateOnRequest = false;
    const serviceWorker = fakeServiceWorker({ waiting });
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel,
      reload: () => { reloads += 1; }, controllerTimeoutMs: 20
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'timeout' });
    assert.strictEqual(reloads, 0);
  });

  await test('an install that fails is reported and the current build keeps running', async () => {
    const installing = new FakeWorker('installing');
    const serviceWorker = fakeServiceWorker({ installing });
    setTimeout(() => installing.setState('redundant'), 5);
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel, reload: () => { reloads += 1; }
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'failed' });
    assert.strictEqual(reloads, 0);
  });

  await test('an uncontrolled page reloads once the new worker is activated', async () => {
    const waiting = new FakeWorker('installed');
    const serviceWorker = fakeServiceWorker({ waiting, controlled: false });
    let reloads = 0;
    const result = await applyAppUpdate({
      serviceWorker, timers, MessageChannelImpl: FakeChannel, reload: () => { reloads += 1; }
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(waiting.state, 'activated');
    assert.strictEqual(reloads, 1);
  });

  await test('the Settings update button runs the handoff instead of a plain reload', async () => {
    const settings = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'settings.js'), 'utf8');
    assert.match(settings, /import \{ applyAppUpdate \} from '\.\.\/sw-update\.mjs';/);
    assert.doesNotMatch(settings, /versionReload\?\.addEventListener\('click', \(\) => location\.reload\(\)\)/);
    assert.match(settings, /versionReload\?\.addEventListener\('click', async \(\) => \{[\s\S]*?applyAppUpdate\(/);
    const worker = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    assert.match(worker, /event\.data\?\.type === 'XANDRIO_ACTIVATE_WAITING'/);
    assert.match(worker, /'\/js\/sw-update\.mjs'/);
    // Readiness pushes reach open pages so a waiting download resumes at once.
    assert.match(worker, /postMessage\(\{ type: 'XANDRIO_OFFLINE_AUDIO_READY', bookId \}\)/);
  });

  await test('importing the update module never activates a worker by itself', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sw-update.mjs'), 'utf8');
    const topLevel = source.split('\n').filter(line => /^[a-zA-Z]/.test(line));
    assert(topLevel.every(line => /^(const|export|function|async function)\b/.test(line)), 'no top-level side effects');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
