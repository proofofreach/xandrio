const assert = require('assert');
const {
  DEFAULT_ANNAS_ORIGIN,
  normalizeAnnasOrigin,
  validateAnnasOrigin
} = require('../lib/annas-origin');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

async function main() {
  await test('default and explicitly allowed public HTTPS origins remain configurable', () => {
    assert.strictEqual(DEFAULT_ANNAS_ORIGIN, 'https://annas-archive.gl');
    assert.strictEqual(normalizeAnnasOrigin('annas-archive.gl'), DEFAULT_ANNAS_ORIGIN);
    assert.strictEqual(normalizeAnnasOrigin('annas-archive.li'), DEFAULT_ANNAS_ORIGIN,
      'legacy .li settings migrate to the current built-in origin');
    assert.strictEqual(
      normalizeAnnasOrigin('https://mirror.example', { allowedOrigins: 'https://mirror.example' }),
      'https://mirror.example'
    );
  });

  await test('HTTP, credentialed, path-bearing, and unapproved origins are rejected', () => {
    for (const value of [
      'http://annas-archive.li',
      'https://user:pass@annas-archive.li',
      'https://annas-archive.li/search',
      'https://attacker.example'
    ]) assert.throws(() => normalizeAnnasOrigin(value));
  });

  await test('an allowed hostname resolving privately is rejected before browser use', async () => {
    await assert.rejects(
      validateAnnasOrigin('https://mirror.example', {
        allowedOrigins: 'https://mirror.example',
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }]
      }),
      /public addresses/
    );
  });

  console.log(`\nAnna origin tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
