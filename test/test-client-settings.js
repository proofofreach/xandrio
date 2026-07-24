/**
 * Client settings validation tests.
 *
 * Run: node test/test-client-settings.js
 */

const { sanitizeClientSettings } = require('../lib/routes/bookmarks-routes');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('\n━━━ Client settings ━━━');

assertEqual(
  sanitizeClientSettings({ defaultSearchSources: ['annas', 'internetarchive', 'annas', 'invalid'] }).defaultSearchSources,
  ['annas', 'internetarchive'],
  'search source defaults are whitelisted and deduplicated'
);
assertEqual(
  sanitizeClientSettings({ defaultSearchSources: [] }).defaultSearchSources,
  undefined,
  'empty search source defaults are rejected'
);
assertEqual(
  sanitizeClientSettings({ defaultSearchSources: 'annas' }).defaultSearchSources,
  undefined,
  'non-array search source defaults are rejected'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
