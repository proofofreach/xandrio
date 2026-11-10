const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

const router = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'router.js'), 'utf8');

// A route change that interrupts an in-flight view transition rejects `ready`
// as well as `finished`. Leaving either without a handler raises an unhandled
// rejection that reaches the page as an error, even though the navigation
// itself succeeded. The behaviour is covered end-to-end by
// verifyInterruptedViewTransition in scripts/smoke-browser.js, which
// interrupts a real transition; this is the cheap guard in the fast suite.
test('both view-transition promises are handled', () => {
  assert.ok(router.includes('transition.ready.catch('), 'ready rejection is handled');
  assert.ok(router.includes('transition.finished.catch('), 'finished rejection is handled');
});

test('settings routes include a section and keep the view key stable', () => {
  assert.ok(router.includes('#\\/settings(?:\\/([a-z-]+))?'), 'settings hashes parse an optional section');
  assert.ok(router.includes('settings:${route.section || \'\'}'), 'section changes re-render settings');
  assert.ok(router.includes("view === 'settings' && param"), 'navigateTo can open a settings page');
});

// A malformed escape in a book link must not throw out of the router.
async function malformedDeepLinks() {
  const { loadClientModule } = require('./fixtures/client-module-loader');
  for (const hash of ['#/player/%E0%A4%A', '#/guide/%']) {
    const listeners = new Map();
    const rejections = [];
    const onRejection = error => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    const location = { hash, pathname: '/', search: '' };
    global.window = {
      location,
      history: { replaceState(_state, _title, url) { location.hash = url.slice(url.indexOf('#')); }, pushState() {}, back() {} },
      addEventListener(type, listener) { listeners.set(type, listener); },
      matchMedia: () => ({ matches: true })
    };
    global.document = { documentElement: { dataset: {} } };
    const shown = [];
    const opened = [];
    const router = await loadClientModule('js/router.js');
    try {
      router.initRouter({
        isBookOpen: () => false,
        openBook: async bookId => { opened.push(bookId); },
        showView: view => shown.push(view)
      });
      await new Promise(resolve => setImmediate(resolve));
      listeners.get('hashchange')();
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    test(`a malformed link (${hash}) falls back to the library`, () => {
      assert.deepStrictEqual(rejections, []);
      assert.deepStrictEqual(opened, []);
      assert.strictEqual(shown[0], 'library');
      assert.strictEqual(location.hash, '#/library');
    });
  }
}

malformedDeepLinks().catch(error => {
  failed += 1;
  console.log(`  ✗ malformed deep links: ${error.stack || error.message}`);
}).finally(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
