const {
  buildSourceProvenance,
  sourceProvenanceFromSelection
} = require('../lib/source-provenance');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

const selected = sourceProvenanceFromSelection({
  source: 'internetarchive',
  hash: 'fallback-hash',
  iaIdentifier: 'archive-item',
  url: 'https://archive.org/details/archive-item?token=secret#page=2',
  rights: 'Borrowing and access restrictions may apply',
  license: 'provider-reported'
});
assert(selected.itemId === 'archive-item', 'provider-native identifier is preferred over the normalized hash');
assert(selected.sourceUrl === 'https://archive.org/details/archive-item', 'selection provenance strips query credentials and fragments');
assert(selected.reportedRights === 'Borrowing and access restrictions may apply', 'provider-reported rights metadata is retained');
assert(selected.reportedLicense === 'provider-reported', 'provider-reported licence metadata is retained');

const record = buildSourceProvenance({
  provider: 'internetarchive',
  acquiredAt: '2026-07-12T00:00:00.000Z',
  details: selected
});
assert(record.provider === 'internetarchive' && record.rightsStatus === 'unverified',
  'stored provenance includes provider and normalized rights status');
assert(!JSON.stringify(record).includes('token=secret'), 'stored provenance never retains URL query secrets');

const zlibrary = sourceProvenanceFromSelection({ source: 'zlibrary', zlibId: '123', hash: 'opaque' });
assert(zlibrary.itemId === '123' && !zlibrary.sourceUrl, 'credentialed providers retain an item id without inventing a source URL');

const upload = buildSourceProvenance({
  provider: 'upload',
  acquiredAt: '2026-07-12T00:00:00.000Z',
  originalFilename: '../Personal Book.epub'
});
assert(upload.originalFilename === '../Personal Book.epub' && upload.rightsStatus === 'operator-supplied',
  'operator uploads retain the original filename and operator-supplied status');

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
