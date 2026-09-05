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

// The reorder buttons render with one attribute per line, so read them as
// structured data rather than trying to spell that layout in a regex.
function moveButtons(markup) {
  return [...markup.matchAll(/<button([^>]*data-move-queue-book[^>]*)>/g)]
    .map(match => match[1])
    .map(attributes => ({
      bookId: /data-move-queue-book="([^"]+)"/.exec(attributes)?.[1],
      direction: /data-move-direction="([^"]+)"/.exec(attributes)?.[1],
      disabled: /\bdisabled\b/.test(attributes)
    }));
}

function fakeActivityList() {
  const element = fakeElement();
  let markup = '';
  let markupWrites = 0;
  let rows = [];
  Object.defineProperty(element, 'innerHTML', {
    configurable: true,
    get() { return markup; },
    set(value) {
      markup = String(value);
      markupWrites += 1;
      rows = [];
      const rowPattern = /<article[^>]*data-audio-activity-id="([^"]+)"[^>]*data-audio-activity-kind="([^"]+)"/g;
      for (const match of markup.matchAll(rowPattern)) {
        const label = { textContent: '' };
        const progress = fakeElement();
        const fill = { style: {} };
        rows.push({
          dataset: {
            audioActivityId: match[1],
            audioActivityKind: match[2],
            state: ''
          },
          querySelector(selector) {
            if (selector === '[data-audio-activity-label]') return label;
            if (selector === '[data-audio-activity-progress]') return progress;
            if (selector === '[data-audio-activity-progress-fill]') return fill;
            return null;
          }
        });
      }
    }
  });
  element.querySelectorAll = selector =>
    selector === '[data-audio-activity-id]' ? rows : [];
  return {
    element,
    get markupWrites() { return markupWrites; },
    get rows() { return rows; }
  };
}

(async () => {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  let queueStatusElement = fakeElement({ hidden: true });
  const activityList = fakeActivityList();
  const elements = {
    'audio-activity-count': fakeElement(),
    'audio-activity-announcement': fakeElement(),
    'audio-activity-sheet': fakeElement({ classes: ['voice-sheet'] }),
    'audio-activity-summary': fakeElement(),
    'audio-activity-list': activityList.element,
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
  const sentRequests = [];
  let apiSendResult = async () => ({});
  global.__queueTestApiSend = (...args) => {
    sentRequests.push(args);
    return apiSendResult(...args);
  };
  global.__queueTestToasts = [];
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
      "import { apiGet, apiSend } from '../api.js';",
      'const apiGet = globalThis.__queueTestApiGet;'
        + ' const apiSend = (...args) => globalThis.__queueTestApiSend(...args);'
    )
    .replace(
      "import { escapeHTML, coverImageHTML } from '../util/format.js';",
      "const escapeHTML = value => String(value ?? ''); const coverImageHTML = () => '<img class=\"audio-activity-cover\">';"
    )
    .replace(
      "import { registerSheet } from '../ui/sheets.js';",
      'const registerSheet = globalThis.__queueTestRegisterSheet;'
    )
    .replace(
      "import { showToast } from '../ui/toast.js';",
      'const showToast = (...args) => globalThis.__queueTestToasts.push(args);'
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
          { chapterIndex: 3, title: 'Believe You Can Succeed', active: 1, queued: 0 },
          { chapterIndex: 4, title: 'Cure Yourself of Excusitis', active: 0, queued: 2 }
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
    assert.match(
      elements['audio-activity-list'].innerHTML,
      /Preparing chapters ahead · Believe You Can Succeed · 1 next/
    );
  });

  await test('labels mixed playback work as the current chapter using its title', async () => {
    apiStatus = {
      active: 1,
      queued: 1,
      books: [{
        id: 'book-current',
        title: 'Thinking Clearly',
        author: 'A. Reader',
        active: 1,
        queued: 1,
        origins: { 'playback-current': 1, 'playback-lookahead': 1 },
        chapters: [
          { chapterIndex: 6, title: '1. Begin Here', active: 1, queued: 0 },
          { chapterIndex: 7, title: '2. Continue', active: 0, queued: 1 }
        ]
      }]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');
    assert.match(
      elements['audio-activity-list'].innerHTML,
      /Preparing current chapter · 1\. Begin Here · 1 next/
    );
    assert.doesNotMatch(elements['audio-activity-list'].innerHTML, /Chapter 7/);
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

  await test('updates download progress without recreating the activity cover', async () => {
    document.dispatchEvent({
      type: 'xandrio:downloadactivity',
      detail: {
        downloads: [{
          id: 'stable-cover',
          title: 'The Stable Cover',
          author: 'A. Reader',
          percent: 1,
          phase: 'Preparing audio'
        }]
      }
    });
    const writesAfterFirstRender = activityList.markupWrites;

    document.dispatchEvent({
      type: 'xandrio:downloadactivity',
      detail: {
        downloads: [{
          id: 'stable-cover',
          title: 'The Stable Cover',
          author: 'A. Reader',
          percent: 2,
          phase: 'Preparing audio'
        }]
      }
    });

    assert.strictEqual(
      activityList.markupWrites,
      writesAfterFirstRender,
      'progress updates must patch the existing row instead of replacing its cover'
    );
    assert.strictEqual(
      activityList.rows[0]?.querySelector('[data-audio-activity-label]')?.textContent,
      'Preparing audio · 2%'
    );
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

  await test('queued titles carry reorder controls, bounded at both ends', async () => {
    document.dispatchEvent({ type: 'xandrio:downloadactivity', detail: { downloads: [] } });
    document.dispatchEvent({ type: 'xandrio:preparationactivity', detail: { preparations: [] } });
    apiStatus = {
      active: 1,
      queued: 2,
      books: [
        { id: 'book-first', title: 'First', author: 'A', active: 1, queued: 0, chapters: [] },
        { id: 'book-middle', title: 'Middle', author: 'A', active: 0, queued: 1, chapters: [] },
        { id: 'book-last', title: 'Last', author: 'A', active: 0, queued: 1, chapters: [] }
      ]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');

    // The ends cannot travel further, and say so rather than failing on click.
    assert.deepStrictEqual(moveButtons(elements['audio-activity-list'].innerHTML), [
      { bookId: 'book-first', direction: 'up', disabled: true },
      { bookId: 'book-first', direction: 'down', disabled: false },
      { bookId: 'book-middle', direction: 'up', disabled: false },
      { bookId: 'book-middle', direction: 'down', disabled: false },
      { bookId: 'book-last', direction: 'up', disabled: false },
      { bookId: 'book-last', direction: 'down', disabled: true }
    ]);
  });

  await test('a lone title is offered no reorder controls at all', async () => {
    apiStatus = {
      active: 1,
      queued: 0,
      books: [{ id: 'book-only', title: 'Only', author: 'A', active: 1, queued: 0, chapters: [] }]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');
    assert.doesNotMatch(elements['audio-activity-list'].innerHTML, /data-move-queue-book/);
  });

  await test('moving a title reorders on screen before the server answers', async () => {
    apiStatus = {
      active: 0,
      queued: 2,
      books: [
        { id: 'book-one', title: 'One', author: 'A', active: 0, queued: 1, chapters: [] },
        { id: 'book-two', title: 'Two', author: 'A', active: 0, queued: 1, chapters: [] }
      ]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');
    sentRequests.length = 0;
    let resolveSend;
    apiSendResult = () => new Promise(resolve => { resolveSend = resolve; });

    elements['audio-activity-list'].dispatch('click', {
      closest: selector => (selector === '[data-move-queue-book]'
        ? { dataset: { moveQueueBook: 'book-two', moveDirection: 'up' }, disabled: false }
        : null)
    });

    const rowOrder = [...elements['audio-activity-list'].innerHTML.matchAll(
      /data-audio-activity-id="([^"]+)"/g
    )].map(match => match[1]);
    assert.deepStrictEqual(rowOrder, ['book-two', 'book-one'], 'the row moves immediately');
    assert.deepStrictEqual(sentRequests[0], [
      'POST',
      '/api/queue/order',
      { bookId: 'book-two', direction: 'up' }
    ]);
    assert.match(
      elements['audio-activity-announcement'].textContent,
      /Two moved to position 1 of 2\./,
      'the move is announced for screen readers'
    );
    resolveSend?.({});
    apiSendResult = async () => ({});
  });

  await test('a refused move snaps the list back to what the server has', async () => {
    apiStatus = {
      active: 0,
      queued: 2,
      books: [
        { id: 'book-one', title: 'One', author: 'A', active: 0, queued: 1, chapters: [] },
        { id: 'book-two', title: 'Two', author: 'A', active: 0, queued: 1, chapters: [] }
      ]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');
    global.__queueTestToasts.length = 0;
    apiSendResult = async () => {
      throw Object.assign(new Error('This title cannot move any further'), { status: 409 });
    };

    elements['audio-activity-list'].dispatch('click', {
      closest: selector => (selector === '[data-move-queue-book]'
        ? { dataset: { moveQueueBook: 'book-two', moveDirection: 'up' }, disabled: false }
        : null)
    });
    await settle();
    await settle();

    const rowOrder = [...elements['audio-activity-list'].innerHTML.matchAll(
      /data-audio-activity-id="([^"]+)"/g
    )].map(match => match[1]);
    assert.deepStrictEqual(rowOrder, ['book-one', 'book-two'], 'the optimistic move is undone');
    assert.strictEqual(
      global.__queueTestToasts.length,
      0,
      'an already-at-the-end move is not worth a toast'
    );
    apiSendResult = async () => ({});
  });

  await test('keeps the last known activity visible when a status poll fails', async () => {
    apiStatus = {
      active: 1,
      queued: 0,
      books: [{ id: 'book-stale', title: 'Still Preparing', author: 'A', active: 1, queued: 0, chapters: [] }]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');
    apiStatus = Promise.reject(new Error('offline'));
    await [...timers.values()][0]();
    await settle();

    assert.strictEqual(queueStatusElement.hidden, false);
    assert.strictEqual(elements['audio-activity-sheet'].classList.contains('active'), true);
    assert.doesNotMatch(elements['audio-activity-announcement'].textContent, /complete/i);
    apiStatus = { active: 0, queued: 0, books: [] };
  });

  await test('keeps failed warmup visible and retries its reported chapter', async () => {
    apiStatus = {
      active: 0,
      queued: 0,
      books: [{
        id: 'book-failed',
        title: 'Needs Audio',
        author: 'A',
        failed: true,
        retryChapterIndex: 3,
        error: 'Voice engine unavailable',
        active: 0,
        queued: 0,
        chapters: []
      }]
    };
    await [...timers.values()][0]();
    await settle();
    queueStatusElement.dispatch('click');
    sentRequests.length = 0;
    global.__queueTestToasts.length = 0;

    assert.strictEqual(queueStatusElement.hidden, false);
    assert.match(queueStatusElement.getAttribute('aria-label'), /needs audio retry/);
    assert.match(elements['audio-activity-list'].innerHTML, /Audio preparation failed/);
    assert.match(elements['audio-activity-list'].innerHTML, /Retry audio preparation/);
    assert.match(elements['audio-activity-announcement'].textContent, /failed for 1 book/i);

    elements['audio-activity-list'].dispatch('click', {
      closest: selector => (selector === '[data-retry-audio-book]'
        ? { dataset: { retryAudioBook: 'book-failed', retryAudioChapter: '3' }, disabled: false }
        : null)
    });
    await settle();

    assert.deepStrictEqual(sentRequests[0], [
      'POST',
      '/api/chunks/book-failed/3/prepare-chapter-audio',
      { purpose: 'import-warmup' }
    ]);
    assert.strictEqual(global.__queueTestToasts.length, 0);
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
