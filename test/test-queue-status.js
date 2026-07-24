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
    console.error(`    ${error.message}`);
  }
}

(async () => {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  let queueStatusElement = { hidden: true, dataset: {}, innerHTML: '' };

  global.document = {
    hidden: false,
    getElementById(id) {
      return id === 'queue-status' ? queueStatusElement : null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    }
  };
  global.window = {
    setInterval(fn) {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    }
  };
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'),
    'utf8'
  );
  Function(lifecycleSource)();
  global.__queueTestApiGet = async () => ({ active: 0, queued: 0 });

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'features', 'queue-status.js'),
    'utf8'
  ).replace(
    "import { apiGet } from '../api.js';",
    'const apiGet = globalThis.__queueTestApiGet;'
  );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { initQueueStatus, stopQueueStatus } = await import(moduleUrl);

  await test('re-init replaces the existing timer and listener', () => {
    initQueueStatus();
    initQueueStatus();
    assert.strictEqual(timers.size, 1);
    assert.strictEqual(listeners.get('visibilitychange')?.size, 1);
  });

  await test('re-init without a status element still stops the old poller', () => {
    queueStatusElement = null;
    initQueueStatus();
    assert.strictEqual(timers.size, 0);
    assert.strictEqual(listeners.get('visibilitychange')?.size || 0, 0);
  });

  stopQueueStatus();
  delete global.__queueTestApiGet;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
