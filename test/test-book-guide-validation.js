'use strict';

const assert = require('node:assert');
const {
  createBookGuideAnchor,
  createBookGuideSourceSnapshot,
  publicSourceIdentity
} = require('../lib/book-guide-source');
const { validateBookGuideArtifact } = require('../lib/book-guide-validation');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function fixture() {
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';
  const snapshot = createBookGuideSourceSnapshot({
    bookId: 'book_1', book: { language: 'en' }, chapters: [{ title: 'One', text }]
  });
  const anchor = createBookGuideAnchor(snapshot, { chapterIndex: 0, start: 0, end: text.length });
  const artifact = {
    schemaVersion: 1,
    status: 'ready',
    bookId: 'book_1',
    source: publicSourceIdentity(snapshot),
    models: {
      generator: { name: 'model:1', digest: `sha256:${'a'.repeat(64)}` },
      verifier: { name: 'model:1', digest: `sha256:${'a'.repeat(64)}` }
    },
    guide: {
      orientation: { thesis: { text: 'A concise paraphrased thesis.', anchorIds: [anchor.id] } },
      coreIdeas: [{ title: 'Idea', claim: 'A paraphrase.', howItWorks: 'A mechanism.', anchorIds: [anchor.id] }],
      chapterMap: [{ chapterIndex: 0, status: 'mapped', anchorIds: [anchor.id] }],
      review: { questions: [] },
      keyPassages: [{ text: 'one two three four five six', anchorId: anchor.id }]
    },
    anchors: { [anchor.id]: anchor },
    verification: {
      allClaimsChecked: true,
      claimCount: 4,
      materialItemCount: 4,
      checkedItemCount: 4,
      unsupportedCount: 0
    }
  };
  return { artifact, snapshot };
}

async function run() {
  await test('accepts a grounded artifact with bounded excerpts', () => {
    const { artifact, snapshot } = fixture();
    assert.strictEqual(validateBookGuideArtifact(artifact, { snapshot }), true);
  });

  await test('rejects a stored excerpt longer than eighteen words', () => {
    const { artifact, snapshot } = fixture();
    artifact.guide.keyPassages[0].text = snapshot.text;
    assert.throws(() => validateBookGuideArtifact(artifact, { snapshot }), error => error.code === 'BOOK_GUIDE_QUOTE_LIMIT');
  });

  await test('rejects twelve consecutive source words outside excerpt fields', () => {
    const { artifact, snapshot } = fixture();
    artifact.guide.orientation.thesis.text = snapshot.text.split(' ').slice(0, 12).join(' ');
    assert.throws(() => validateBookGuideArtifact(artifact, { snapshot }), error =>
      error.code === 'BOOK_GUIDE_QUOTE_LIMIT' && error.guidePath === 'orientation.thesis.text');
  });

  await test('rejects unknown guide anchors', () => {
    const { artifact, snapshot } = fixture();
    artifact.guide.coreIdeas[0].anchorIds = ['a_missing'];
    assert.throws(() => validateBookGuideArtifact(artifact, { snapshot }), /Invalid anchorIds/);
  });

  await test('rejects a mismatched source fingerprint', () => {
    const { artifact, snapshot } = fixture();
    artifact.source.fingerprint = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => validateBookGuideArtifact(artifact, { snapshot }), error => error.code === 'BOOK_GUIDE_SOURCE_CHANGED');
  });

  await test('rejects an incomplete semantic verification record', () => {
    const { artifact, snapshot } = fixture();
    artifact.verification.materialItemCount = 5;
    assert.throws(() => validateBookGuideArtifact(artifact, { snapshot }), /semantic verification record/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
