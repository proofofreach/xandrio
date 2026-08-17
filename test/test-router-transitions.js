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
// rejection, which reaches the page as an error even though the navigation
// itself succeeded — an intermittent browser-smoke failure.
test('both view-transition promises are handled', () => {
  assert.ok(router.includes('transition.ready.catch('), 'ready rejection is handled');
  assert.ok(router.includes('transition.finished.catch('), 'finished rejection is handled');
});

test('the transition marker is cleared after the transition settles', () => {
  assert.ok(router.includes('.finally(() => { delete html.dataset.vt; })'),
    'data-vt is removed once the transition settles');
});

test('unsupported browsers and reduced motion skip the transition', () => {
  assert.ok(router.includes('!document.startViewTransition || prefersReducedMotion()'),
    'transitions are opt-out under reduced motion and on unsupported browsers');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
