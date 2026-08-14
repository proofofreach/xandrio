'use strict';

const assert = require('node:assert');
const {
  buildBookGuideNarration,
  narrationArtifactId,
  narrationBookPrefix,
  publicNarrationManifest
} = require('../lib/book-guide-narration');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error.message}`); }
}

const artifact = {
  createdAt: '2026-08-14T12:00:00.000Z',
  source: { fingerprint: 'sha256:source', chapterStructureKey: 'chapters' },
  recipe: { hash: 'sha256:recipe' },
  verification: { verifiedAt: '2026-08-14T11:59:00.000Z' },
  guide: {
    orientation: {
      thesis: 'Systems improve when feedback arrives quickly.',
      problem: 'How can teams learn faster?',
      takeaways: ['Shorten the feedback loop.'],
      bottomLine: 'Measure outcomes, then adapt.'
    },
    coreIdeas: [{
      title: 'Fast feedback',
      claim: 'Delay hides mistakes.',
      mechanism: 'Frequent checks expose drift.',
      support: 'The book compares weekly and yearly review cycles.',
      qualification: 'Checks must measure the right outcome.',
      implications: 'Review important work more often.'
    }],
    chapterMap: [
      { chapterIndex: 0, title: 'Signals', purpose: 'Defines useful feedback.', contributions: ['Separates signals from noise.'] },
      { chapterIndex: 1, title: 'Notes', skipped: true, skipReason: 'Back matter' }
    ],
    review: {
      questions: [{ question: 'Why does delay matter?', answer: 'It lets errors compound.' }],
      selfExplanationPrompts: ['Explain the feedback loop in your own words.']
    },
    keyPassages: [{ excerpt: 'A source quotation that must not be copied into narration.', note: 'This passage defines the central loop.' }]
  }
};

test('builds a guide-native audio playlist', () => {
  assert.deepStrictEqual(buildBookGuideNarration(artifact).map(item => item.id), [
    'overview', 'concept-1', 'chapter-1', 'active-review', 'key-passages'
  ]);
});

test('omits skipped structural chapters', () => {
  assert(!buildBookGuideNarration(artifact).some(item => item.id === 'chapter-2'));
});

test('narrates recall questions and answers with a pause instruction', () => {
  const review = buildBookGuideNarration(artifact).find(item => item.id === 'active-review');
  assert(review.text.includes('Pause after each question'));
  assert(review.text.includes('Question 1. Why does delay matter?'));
  assert(review.text.includes('Answer. It lets errors compound.'));
});

test('narrates passage commentary without reproducing source excerpts', () => {
  const passages = buildBookGuideNarration(artifact).find(item => item.id === 'key-passages');
  assert(passages.text.includes('This passage defines the central loop.'));
  assert(!passages.text.includes('source quotation'));
});

test('publishes metadata without narration text', () => {
  const manifest = publicNarrationManifest('book_1', artifact);
  assert.strictEqual(manifest.available, true);
  assert.match(manifest.version, /^[a-f0-9]{12}$/);
  assert(manifest.sections.every(item => !Object.hasOwn(item, 'text')));
});

test('uses stable cache identities for the same guide version', () => {
  assert.strictEqual(narrationArtifactId('book_1', artifact), narrationArtifactId('book_1', structuredClone(artifact)));
});

test('changes cache identity when a new guide is published', () => {
  const replacement = structuredClone(artifact);
  replacement.createdAt = '2026-08-15T12:00:00.000Z';
  assert.notStrictEqual(narrationArtifactId('book_1', artifact), narrationArtifactId('book_1', replacement));
});

test('changes cache identity when guide content changes under the same provenance', () => {
  const replacement = structuredClone(artifact);
  replacement.guide.orientation.thesis = 'Replacement guide content.';
  assert.notStrictEqual(narrationArtifactId('book_1', artifact), narrationArtifactId('book_1', replacement));
});

test('creates bounded safe cache path components', () => {
  const prefix = narrationBookPrefix('../unsafe/book');
  const id = narrationArtifactId('../unsafe/book', artifact);
  assert.match(prefix, /^guide_[a-f0-9]{12}_$/);
  assert.match(id, /^guide_[a-f0-9]{12}_[a-f0-9]{12}$/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
