#!/usr/bin/env node
const assert = require('node:assert/strict');
const { resolveRuntimeRevision, readStampedRevision } = require('../lib/runtime-revision');

let passed = 0;
let failed = 0;

function check(name, callback) {
  try {
    callback();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const stamp = value => () => `${value}\n`;
const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

check('a release directory names the revision it contains', () => {
  assert.equal(resolveRuntimeRevision({ root: '/opt/xandrio/current', env: {}, readFile: stamp(SHA) }), SHA);
});

check('the supervised environment wins when it is set', () => {
  // The local service has no release directory and passes the revision in.
  assert.equal(
    resolveRuntimeRevision({ root: '/x', env: { XANDRIO_RUNTIME_REVISION: OTHER }, readFile: stamp(SHA) }),
    OTHER
  );
});

check('an unstamped, unsupervised process reports null rather than guessing', () => {
  assert.equal(resolveRuntimeRevision({ root: '/x', env: {}, readFile: missing }), null);
  assert.equal(resolveRuntimeRevision({ root: null, env: {} }), null);
});

check('a blank environment value does not mask the stamp', () => {
  assert.equal(
    resolveRuntimeRevision({ root: '/x', env: { XANDRIO_RUNTIME_REVISION: '   ' }, readFile: stamp(SHA) }),
    SHA
  );
});

check('only a full revision is reported', () => {
  // A truncated or decorated value would be indistinguishable from a real
  // revision downstream, where the deploy compares it for equality.
  assert.equal(readStampedRevision('/x', stamp('abc123')), null);
  assert.equal(readStampedRevision('/x', stamp('not-a-revision')), null);
  assert.equal(readStampedRevision('/x', stamp(`${SHA} dirty`)), null);
  assert.equal(readStampedRevision('/x', stamp(SHA.toUpperCase())), null);
});

check('surrounding whitespace in the stamp is tolerated', () => {
  assert.equal(readStampedRevision('/x', () => `  ${SHA}  \r\n`), SHA);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
