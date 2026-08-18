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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
