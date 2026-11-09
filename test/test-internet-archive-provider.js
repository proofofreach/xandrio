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
assertEqual(__test.safeHash('in.ernet.dli.2015.12345'), 'ia-in_ernet_dli_2015_12345',
  'an identifier that fits keeps its existing book id');
const longA = __test.safeHash(`${'a'.repeat(130)}-one`);
const longB = __test.safeHash(`${'a'.repeat(130)}-two`);
assert(longA !== longB && longA.length <= 128 && longB.length <= 128,
  'identifiers longer than the id allows get distinct, bounded ids');
assertEqual(__test.formatBytes(1536), '1.5 KB', 'formatBytes formats small files');

const { bookId, download } = require('../lib/search-providers/internet-archive');
assertEqual(bookId({ iaIdentifier: 'moby_dick' }), 'ia-moby_dick', 'bookId derives the id from the item identifier');
assertEqual(bookId({ downloadUrl: 'https://archive.org/download/moby_dick/m.epub' }), 'ia-moby_dick',
  'bookId derives the id from the download URL item');
assertEqual(bookId({ iaIdentifier: 'moby_dick', downloadUrl: 'https://archive.org/download/other/o.epub' }), null,
  'bookId refuses an identifier and URL that name different items');

download({ downloadUrl: 'https://archive.org/details/moby_dick' }, '/nonexistent/x.epub').then(
  () => assert(false, 'refuses a download URL that names no item'),
  error => assert(/names no single item/.test(error.message), 'refuses a download URL that names no item')
).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
