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

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    dataset: {},
    hidden: false,
    textContent: '',
    listeners,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    count(type) { return listeners.get(type)?.size || 0; },
    emit(type) { for (const listener of [...(listeners.get(type) || [])]) listener({}); }
  };
}

(async () => {
  await test('sleep timer distinguishes lock-screen reliable and best-effort modes', () => {
    const indexSource = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'index.html'),
      'utf8'
    );
    assert.match(indexSource, /End of chapter remains reliable when your screen is locked/i);
    assert.match(indexSource, /Minute timers are best effort if iOS suspends Xandrio/i);
  });

  const values = new Map();
  global.__sleepSheetOpens = 0;
  global.__sleepTimerValues = values;
  const timerButton = element();
  const closeButton = element();
  const cancelButton = element();
  const extendButton = element();
  const option = element();
  option.dataset.minutes = '15';
  const chapterOption = element();
  chapterOption.dataset.mode = 'chapter';
  const elements = new Map([
    ['timer-modal', element()],
    ['timer-btn-inline', timerButton],
    ['close-timer-modal-btn', closeButton],
    ['cancel-timer-btn', cancelButton],
    ['extend-timer-btn', extendButton],
    ['utility-timer-btn', element()],
    ['timer-countdown', element()]
  ]);
  global.document = {
    body: element(),
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll(selector) { return selector === '.timer-option' ? [option, chapterOption] : []; }
  };
  const timers = new Map();
  let nextTimer = 1;
  const originalTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setTimeout = callback => { const id = nextTimer++; timers.set(id, callback); return id; };
  global.clearTimeout = id => timers.delete(id);
  global.setInterval = callback => { const id = nextTimer++; timers.set(id, callback); return id; };
  global.clearInterval = id => timers.delete(id);

  try {
    const lifecycleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lifecycle.js'), 'utf8');
    Function(lifecycleSource)();
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'sleep-timer.js'), 'utf8')
      .replace("import { showToast } from '../ui/toast.js';", 'const showToast = () => {};')
      .replace("import { registerSheet } from '../ui/sheets.js';", 'const registerSheet = () => ({ open() { globalThis.__sleepSheetOpens++; }, close() {}, dismiss() {} });')
      .replace("import { readJSON, writeJSON, readText, writeText, removeStorage } from '../util/storage.js';", `
        const readJSON = (key, fallback) => globalThis.__sleepTimerValues.has(key) ? JSON.parse(globalThis.__sleepTimerValues.get(key)) : fallback;
        const writeJSON = (key, value) => globalThis.__sleepTimerValues.set(key, JSON.stringify(value));
        const readText = (key, fallback) => globalThis.__sleepTimerValues.has(key) ? globalThis.__sleepTimerValues.get(key) : fallback;
        const writeText = (key, value) => globalThis.__sleepTimerValues.set(key, String(value));
        const removeStorage = key => globalThis.__sleepTimerValues.delete(key);`)
      .replace("import { onActivate } from '../ui/keys.js';", `
        const onActivate = (el, handler) => {
          const listener = event => { if (event.key === 'Enter' || event.key === ' ') handler(event); };
          el?.addEventListener('keydown', listener);
          return () => el?.removeEventListener('keydown', listener);
        };`);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const { clearSleepTimer, initSleepTimer, restoreSleepTimer } = await import(moduleUrl);

    await test('re-init replaces sleep timer view listeners', () => {
      initSleepTimer({ getCurrentBook: () => null, getCurrentChapter: () => 0, getChunkPlayer: () => null, updatePlaybackUI() {}, savePosition() {} });
      initSleepTimer({ getCurrentBook: () => null, getCurrentChapter: () => 0, getChunkPlayer: () => null, updatePlaybackUI() {}, savePosition() {} });
      assert.strictEqual(timerButton.count('click'), 1);
      assert.strictEqual(timerButton.count('keydown'), 1);
      assert.strictEqual(option.count('click'), 1);
      assert.strictEqual(chapterOption.count('click'), 1);
      assert.strictEqual(extendButton.count('click'), 1);
    });

    await test('chapter target arm, restore, and cancel update the transport limit', async () => {
      const changes = [];
      const options = {
        getCurrentBook: () => ({ id: 'book-a' }),
        getCurrentChapter: () => 2,
        getChunkPlayer: () => null,
        updatePlaybackUI() {},
        savePosition() {},
        onChapterTargetChange(target, detail) {
          changes.push({ target, reason: detail.reason });
        }
      };
      initSleepTimer(options);
      chapterOption.emit('click');
      await Promise.resolve();
      assert.deepStrictEqual(changes.at(-1), {
        target: { bookId: 'book-a', chapterIndex: 2 },
        reason: 'armed'
      });
      assert.strictEqual(values.get('xandrio_sleep_timer_mode'), 'chapter');

      restoreSleepTimer();
      await Promise.resolve();
      assert.deepStrictEqual(changes.at(-1), {
        target: { bookId: 'book-a', chapterIndex: 2 },
        reason: 'restored'
      });

      cancelButton.emit('click');
      await Promise.resolve();
      assert.deepStrictEqual(changes.at(-1), {
        target: null,
        reason: 'cancelled'
      });
      assert.strictEqual(values.has('xandrio_sleep_timer_chapter_target'), false);
      clearSleepTimer();
    });

    await test('restoring twice leaves exactly one countdown and expiry', () => {
      values.set('xandrio_sleep_timer_mode', 'time');
      values.set('xandrio_sleep_timer_end', String(Date.now() + 60_000));
      restoreSleepTimer();
      restoreSleepTimer();
      assert.strictEqual(timers.size, 2);
    });

    await test('an armed timer can be reopened, extended, and explicitly cancelled', () => {
      clearSleepTimer();
      timerButton.emit('click');
      assert.strictEqual(cancelButton.hidden, true);
      assert.strictEqual(extendButton.hidden, true);
      option.emit('click');
      const originalEnd = Number(values.get('xandrio_sleep_timer_end'));
      const opens = global.__sleepSheetOpens;
      timerButton.emit('click');
      assert.strictEqual(global.__sleepSheetOpens, opens + 1);
      assert.strictEqual(Number(values.get('xandrio_sleep_timer_end')), originalEnd);
      assert.strictEqual(cancelButton.hidden, false);
      assert.strictEqual(extendButton.hidden, false);
      extendButton.emit('click');
      assert(Math.abs(Number(values.get('xandrio_sleep_timer_end')) - originalEnd - 300000) < 100);
      cancelButton.emit('click');
      assert.strictEqual(values.has('xandrio_sleep_timer_end'), false);
      assert.strictEqual(cancelButton.hidden, true);
    });
  } finally {
    global.setTimeout = originalTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalInterval;
    global.clearInterval = originalClearInterval;
    delete global.__sleepTimerValues;
    delete global.__sleepSheetOpens;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
