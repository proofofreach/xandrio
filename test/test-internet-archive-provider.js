/**
 * Internet Archive provider tests.
 *
 * Run: node test/test-internet-archive-provider.js
 */

const { __test } = require('../lib/search-providers/internet-archive');

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

console.log('\n━━━ Internet Archive provider ━━━');

const chosenEpub = __test.chooseDownloadFile([
  { name: 'book_lcp.epub', format: 'LCP Encrypted EPUB', size: '10' },
  { name: 'book.pdf', format: 'Text PDF', size: '20' },
  { name: 'book.epub', format: 'EPUB', size: '30' }
]);
assertEqual(chosenEpub.format, 'EPUB', 'prefers unencrypted EPUB');
assertEqual(chosenEpub.file.name, 'book.epub', 'ignores encrypted EPUB');

const chosenPdf = __test.chooseDownloadFile([
  { name: 'book_lcp.epub', format: 'LCP Encrypted EPUB', size: '10' },
  { name: 'book.pdf', format: 'Text PDF', size: '20' }
]);
assertEqual(chosenPdf.format, 'PDF', 'falls back to text PDF');

const none = __test.chooseDownloadFile([
  { name: 'book_lcp.epub', format: 'LCP Encrypted EPUB', size: '10' },
  { name: 'book_lcpdf', format: 'LCP Encrypted PDF', size: '20' }
]);
assertEqual(none, null, 'rejects encrypted-only items');

assert(__test.safeHash('foo.bar/baz').startsWith('ia-foo_bar_baz'), 'safeHash removes unsafe identifier characters');
assertEqual(__test.formatBytes(1536), '1.5 KB', 'formatBytes formats small files');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
