const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

class OnlineEvents {
  constructor() {
    this.listeners = new Set();
  }

  addEventListener(type, listener, options) {
    assert.strictEqual(type, 'online');
    this.listeners.add({ listener, once: options?.once === true });
  }

  removeEventListener(type, listener) {
    assert.strictEqual(type, 'online');
    for (const entry of this.listeners) {
      if (entry.listener === listener) this.listeners.delete(entry);
    }
  }

  emitOnline() {
    for (const entry of [...this.listeners]) {
      if (entry.once) this.listeners.delete(entry);
      entry.listener();
    }
  }
}

function loadRetryOwnerFactory() {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = appSource.indexOf('function createOnlineRetryOwner(eventTarget) {');
  const end = appSource.indexOf('\n\nasync function loadChapter', start);
  assert.ok(start >= 0 && end > start, 'app.js must define the online retry owner helper');
  return vm.runInNewContext(
    `${appSource.slice(start, end)}\n({ createOnlineRetryOwner });`
  ).createOnlineRetryOwner;
}

const createOnlineRetryOwner = loadRetryOwnerFactory();

test('repeated offline attempts retain exactly one pending online listener', () => {
  const events = new OnlineEvents();
  const owner = createOnlineRetryOwner(events);

  owner.register({ bookId: 'book-a', chapterIndex: 3, onRetry() {} });
  owner.register({ bookId: 'book-a', chapterIndex: 3, onRetry() {} });

  assert.strictEqual(events.listeners.size, 1);
});

test('connectivity reloads exactly the current retry target once', () => {
  const events = new OnlineEvents();
  const owner = createOnlineRetryOwner(events);
  const state = { bookId: 'book-a', chapterIndex: 3 };
  const loads = [];

  owner.register({
    ...state,
    onRetry: target => {
      if (state.bookId === target.bookId && state.chapterIndex === target.chapterIndex) {
        loads.push(target);
      }
    }
  });
  events.emitOnline();
  events.emitOnline();

  assert.deepStrictEqual(JSON.parse(JSON.stringify(loads)), [{ bookId: 'book-a', chapterIndex: 3 }]);
  assert.strictEqual(events.listeners.size, 0);
});

test('clearing after navigation prevents stale retries', () => {
  const events = new OnlineEvents();
  const owner = createOnlineRetryOwner(events);
  let loadAttempts = 0;

  owner.register({ bookId: 'book-a', chapterIndex: 3, onRetry: () => { loadAttempts += 1; } });
  owner.clear();
  events.emitOnline();

  assert.strictEqual(loadAttempts, 0);
  assert.strictEqual(events.listeners.size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
