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

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name)
  };
}

function fakeElement({ hidden = false, classes = [] } = {}) {
  const listeners = new Map();
  const attributes = new Map();
  return {
    hidden,
    dataset: {},
    innerHTML: '',
    textContent: '',
    title: '',
    classList: fakeClassList(classes),
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, target = this) {
      for (const listener of listeners.get(type) || []) listener({ target });
    }
  };
}

(async () => {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  let queueStatusElement = fakeElement({ hidden: true });
  const elements = {
    'audio-activity-count': fakeElement(),
    'audio-activity-announcement': fakeElement(),
    'audio-activity-sheet': fakeElement({ classes: ['voice-sheet'] }),
    'audio-activity-summary': fakeElement(),
    'audio-activity-list': fakeElement(),
    'audio-activity-backdrop': fakeElement(),
    'audio-activity-close': fakeElement()
  };

  global.document = {
    hidden: false,
    body: { classList: fakeClassList() },
    getElementById(id) {
      if (id === 'queue-status') return queueStatusElement;
      return elements[id] || null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
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

  let apiStatus = { active: 0, queued: 0, books: [] };
  global.__queueTestApiGet = async () => apiStatus;
  global.__queueTestRegisterSheet = (element, options = {}) => ({
    open() {
      options.onOpen?.();
      element.classList.add('active');
      element.setAttribute('aria-hidden', 'false');
    },
    close() {
      element.classList.remove('active');
      element.setAttribute('aria-hidden', 'true');
      options.onClose?.();
    }
  });

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'features', 'queue-status.js'),
    'utf8'
  )
    .replace(
      "import { apiGet } from '../api.js';",
      'const apiGet = globalThis.__queueTestApiGet;'
    )
    .replace(
      "import { escapeHTML, coverImageHTML } from '../util/format.js';",
      "const escapeHTML = value => String(value ?? ''); const coverImageHTML = () => '<img class=\"audio-activity-cover\">';"
    )
    .replace(
      "import { registerSheet } from '../ui/sheets.js';",
      'const registerSheet = globalThis.__queueTestRegisterSheet;'
    );
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { initQueueStatus, stopQueueStatus } = await import(moduleUrl);
  const settle = () => new Promise(resolve => setImmediate(resolve));

  await test('re-init replaces the existing timer and listener', async () => {
    initQueueStatus();
    initQueueStatus();
    await settle();
    assert.strictEqual(timers.size, 1);
    assert.strictEqual(listeners.get('visibilitychange')?.size, 1);
  });

  await test('shows a book-count activity button and renders details on demand', async () => {
    apiStatus = {
      active: 1,
      queued: 2,
      books: [{
        id: 'book-a',
        title: 'A Long Book',
        author: 'A. Reader',
        active: 1,
        queued: 2,
        origins: { 'playback-lookahead': 3 },
        chapters: [
          { chapterIndex: 3, active: 1, queued: 0 },
          { chapterIndex: 4, active: 0, queued: 2 }
        ]
      }]
    };
    await [...timers.values()][0]();
    await settle();

    assert.strictEqual(queueStatusElement.hidden, false);
    assert.strictEqual(elements['audio-activity-count'].textContent, '1');
    assert.match(queueStatusElement.getAttribute('aria-label'), /1 book is preparing audio/);

    queueStatusElement.dispatch('click');
    assert.strictEqual(elements['audio-activity-sheet'].classList.contains('active'), true);
    assert.match(elements['audio-activity-list'].innerHTML, /A Long Book/);
    assert.match(elements['audio-activity-list'].innerHTML, /Preparing chapters ahead · Chapter 4 · 1 next/);
  });

  await test('hides the activity affordance when user-relevant work completes', async () => {
    apiStatus = { active: 0, queued: 0, books: [] };
    await [...timers.values()][0]();
    await settle();

    assert.strictEqual(queueStatusElement.hidden, true);
    assert.strictEqual(elements['audio-activity-sheet'].classList.contains('active'), false);
    assert.strictEqual(elements['audio-activity-announcement'].textContent, 'Audio preparation complete.');
  });

  await test('automatically reveals browser download progress without chapter-piece counts', async () => {
    let cancelledBookId = null;
    document.addEventListener('xandrio:cancelofflinedownload', event => {
      cancelledBookId = event.detail.bookId;
    });
    document.dispatchEvent({
      type: 'xandrio:downloadactivity',
      detail: {
        downloads: [{
          id: 'book-download',
          title: 'The Download',
          author: 'A. Reader',
          percent: 42,
          phase: 'Downloading'
        }]
      }
    });
    await settle();
    assert.strictEqual(queueStatusElement.hidden, false);
    assert.strictEqual(elements['audio-activity-sheet'].classList.contains('active'), true);
    assert.match(elements['audio-activity-list'].innerHTML, /42%/);
    assert.doesNotMatch(elements['audio-activity-list'].innerHTML, /chapter/i);
    assert.match(elements['audio-activity-list'].innerHTML, /role="progressbar"/);
    assert.match(elements['audio-activity-list'].innerHTML, />Cancel</);
    elements['audio-activity-list'].dispatch('click', {
      closest: () => ({ dataset: { cancelOfflineBook: 'book-download' } })
    });
    assert.strictEqual(cancelledBookId, 'book-download');
  });

  await test('labels server preparation separately from device downloading', async () => {
    document.dispatchEvent({
      type: 'xandrio:downloadactivity',
      detail: { downloads: [] }
    });
    document.dispatchEvent({
      type: 'xandrio:preparationactivity',
      detail: {
        preparations: [{
          id: 'book-preparing',
          title: 'The Preparing Book',
          author: 'A. Reader',
          readyChapters: 4,
          totalChapters: 24,
          percent: 17
        }]
      }
    });
    await settle();
    queueStatusElement.dispatch('click');
    assert.match(elements['audio-activity-list'].innerHTML, /Preparing audio · 4\/24/);
    assert.doesNotMatch(elements['audio-activity-list'].innerHTML, /Downloading · 17%/);
  });

  await test('re-init without a status element still stops the old poller', () => {
    queueStatusElement = null;
    initQueueStatus();
    assert.strictEqual(timers.size, 0);
    assert.strictEqual(listeners.get('visibilitychange')?.size || 0, 0);
  });

  stopQueueStatus();
  delete global.__queueTestApiGet;
  delete global.__queueTestRegisterSheet;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
