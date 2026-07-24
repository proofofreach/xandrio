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

function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) || [])]) listener({ type });
    },
    count(type) { return listeners.get(type)?.size || 0; }
  };
}

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    runNext() {
      const [id, callback] = timers.entries().next().value || [];
      if (id === undefined) return;
      timers.delete(id);
      callback();
    }
  };
}

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'), 'utf8');
  Function(source)();
  const { DisposableScope, waitForMediaEvents } = global.XandrioLifecycle;

  await test('scope disposal is idempotent and removes every resource', () => {
    const target = fakeTarget();
    const clock = fakeClock();
    const scope = new DisposableScope();
    let calls = 0;
    scope.listen(target, 'change', () => { calls += 1; });
    scope.timeout(() => { calls += 10; }, 10, clock);
    scope.dispose();
    scope.dispose();
    target.emit('change');
    clock.runNext();
    assert.strictEqual(calls, 0);
    assert.strictEqual(target.count('change'), 0);
    assert.strictEqual(clock.timers.size, 0);
  });

  await test('media waits reject immediately on cancellation and leave no listeners', async () => {
    const target = fakeTarget();
    const clock = fakeClock();
    const wait = waitForMediaEvents(target, {
      resolveEvents: ['loadedmetadata'],
      rejectEvents: ['error'],
      timeoutMs: 10,
      clock
    });
    wait.cancel();
    await assert.rejects(wait.promise, error => error?.cancelled === true);
    assert.strictEqual(target.count('loadedmetadata'), 0);
    assert.strictEqual(target.count('error'), 0);
    assert.strictEqual(clock.timers.size, 0);
  });

  await test('media waits use the supplied fake clock for timeouts', async () => {
    const target = fakeTarget();
    const clock = fakeClock();
    const wait = waitForMediaEvents(target, {
      resolveEvents: ['canplay'],
      timeoutMs: 10,
      timeoutError: () => new Error('timed out'),
      clock
    });
    clock.runNext();
    await assert.rejects(wait.promise, /timed out/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
