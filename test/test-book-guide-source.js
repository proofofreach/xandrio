'use strict';

const assert = require('node:assert');
const {
  bookGuideAnchorContext,
  createBookGuideAnchor,
  createBookGuideSourceSnapshot,
  detectGuideLanguage,
  isEnglishLanguage,
  normalizeGuideText,
  locateEvidence,
  resolveBookGuideAnchor
} = require('../lib/book-guide-source');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

async function run() {
  await test('normalizes source text deterministically', () => {
    assert.strictEqual(normalizeGuideText('  Alpha\n\tBeta  '), 'Alpha Beta');
  });

  await test('keeps source fingerprint stable across a safe split', () => {
    const joined = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en' }, chapters: [{ text: 'Alpha beta gamma delta.' }]
    });
    const split = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en-US' }, chapters: [{ text: 'Alpha beta' }, { text: 'gamma delta.' }]
    });
    assert.strictEqual(joined.fingerprint, split.fingerprint);
  });

  await test('resolves an anchor after chapter boundaries change', () => {
    const original = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en' }, chapters: [{ text: 'Alpha beta gamma delta epsilon.' }]
    });
    const anchor = createBookGuideAnchor(original, { chapterIndex: 0, start: 11, end: 22 });
    const rebuilt = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en' }, chapters: [{ text: 'Alpha beta' }, { text: 'gamma delta epsilon.' }]
    });
    const resolved = resolveBookGuideAnchor(rebuilt, anchor);
    assert.strictEqual(resolved.passage, 'gamma delta');
    assert.strictEqual(resolved.chapterIndex, 1);
    assert.strictEqual(resolved.start, 0);
  });

  await test('fails closed when anchored source bytes change', () => {
    const original = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en' }, chapters: [{ text: 'Alpha beta gamma.' }]
    });
    const anchor = createBookGuideAnchor(original, { chapterIndex: 0, start: 6, end: 10 });
    const changed = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en' }, chapters: [{ text: 'Alpha zeta gamma.' }]
    });
    assert.strictEqual(resolveBookGuideAnchor(changed, anchor), null);
  });

  await test('resolves a unique contiguous citation despite harmless punctuation changes', () => {
    const snapshot = createBookGuideSourceSnapshot({
      bookId: 'book_1',
      book: { language: 'en' },
      chapters: [{ text: 'The nervous system—rather than willpower—drives this response. A different point follows.' }]
    });
    const anchor = locateEvidence(snapshot, 0, 'the nervous system rather than willpower drives this response', {
      from: 0,
      to: snapshot.chapters[0].length
    });
    assert(anchor, 'unique lexical citation should resolve');
    assert.strictEqual(resolveBookGuideAnchor(snapshot, anchor).passage,
      'The nervous system—rather than willpower—drives this response');
  });

  await test('rejects ambiguous punctuation-insensitive citations', () => {
    const snapshot = createBookGuideSourceSnapshot({
      bookId: 'book_1',
      book: { language: 'en' },
      chapters: [{ text: 'A stable system—adapts slowly. A stable system, adapts slowly.' }]
    });
    assert.strictEqual(locateEvidence(snapshot, 0, 'a stable system adapts slowly', {
      from: 0,
      to: snapshot.chapters[0].length
    }), null);
  });

  await test('renders no more than eighteen context words', () => {
    const text = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const snapshot = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'en' }, chapters: [{ text, estimatedDuration: 300 }]
    });
    const anchor = createBookGuideAnchor(snapshot, { chapterIndex: 0, start: 0, end: text.length });
    const context = bookGuideAnchorContext(snapshot, anchor);
    assert.strictEqual(context.text.split(' ').length, 18);
    assert.strictEqual(context.exact, true);
  });

  await test('recognizes only explicit English language values', () => {
    assert.strictEqual(isEnglishLanguage('en-GB'), true);
    assert.strictEqual(isEnglishLanguage('English'), true);
    assert.strictEqual(isEnglishLanguage('fr'), false);
    assert.strictEqual(createBookGuideSourceSnapshot({
      bookId: 'book_1', book: { language: 'English' }, chapters: [{ text: 'Short source.' }]
    }).language, 'en');
  });

  await test('detects English deterministically when language metadata is absent', () => {
    const text = `The book explains how a team can improve its work when the members define the problem and record the expected result. These steps are useful because they make each decision visible, and they show which method has been tested in the real setting.`;
    assert.strictEqual(detectGuideLanguage(text), 'en');
    const snapshot = createBookGuideSourceSnapshot({
      bookId: 'book_1', book: {}, chapters: [{ text }]
    });
    assert.strictEqual(snapshot.language, 'en');
  });

  await test('marks non-English and insufficient sources as undetermined without metadata', () => {
    assert.strictEqual(detectGuideLanguage('Brief text.'), 'und');
    assert.strictEqual(detectGuideLanguage(`Este libro presenta una explicación detallada sobre los sistemas y las decisiones. Los autores describen métodos importantes para comprender problemas complejos, mientras los lectores consideran ejemplos, límites, resultados y diferentes formas de aplicar cada concepto en situaciones prácticas de la vida cotidiana.`), 'und');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

run();
