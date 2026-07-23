const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

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

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'util', 'chapter-labels.mjs'));
  const { chapterListItemState, chapterListOrdinal, chapterProgressContext, expandNumericChapterTitle, findPreferredStartChapterIndex, firstDisplaySentence } = await import(moduleUrl.href);

  test('numeric source titles are presented as chapter labels', () => {
    assert.strictEqual(expandNumericChapterTitle('1'), 'Chapter 1');
    assert.strictEqual(expandNumericChapterTitle('15'), 'Chapter 15');
    assert.strictEqual(expandNumericChapterTitle('Acknowledgments'), 'Acknowledgments');
  });

  test('narrative progress excludes front and back matter', () => {
    const chapters = [
      { title: 'Copyright', type: 'copyright' },
      ...Array.from({ length: 15 }, (_, index) => ({ title: String(index + 1), type: 'content' })),
      { title: 'Acknowledgments', type: 'backmatter' },
      { title: 'About the Author', type: 'author' }
    ];

    assert.strictEqual(chapterProgressContext(chapters, 1), 'Chapter 1 of 15');
  });

  test('non-narrative progress retains the section name', () => {
    const chapters = [
      { title: 'Copyright', type: 'copyright' },
      { title: '1', type: 'content' },
      { title: 'Acknowledgments', type: 'backmatter' },
      { title: 'About the Author', type: 'author' }
    ];

    assert.strictEqual(chapterProgressContext(chapters, 0), 'Copyright');
    assert.strictEqual(chapterProgressContext(chapters, 2), 'Acknowledgments');
    assert.strictEqual(chapterProgressContext(chapters, 3), 'About the Author');
  });

  test('named content is never assigned an invented chapter number', () => {
    const chapters = [
      { title: 'Preface To The Second Edition', type: 'content' },
      { title: 'Introduction', type: 'frontmatter' },
      { title: 'WARNING', type: 'content' },
      { title: 'Chapter Two', type: 'chapter' },
      { title: 'Interlude: The Leary-Wilson Paradigm', type: 'content' },
      { title: 'Chapter Nineteen', type: 'chapter' }
    ];

    assert.strictEqual(chapterProgressContext(chapters, 0), 'Preface To The Second Edition');
    assert.strictEqual(chapterProgressContext(chapters, 2), 'WARNING');
    assert.strictEqual(chapterProgressContext(chapters, 3), 'Chapter 2 of 19');
    assert.strictEqual(chapterProgressContext(chapters, 4), 'Interlude: The Leary-Wilson Paradigm');
    assert.strictEqual(chapterProgressContext(chapters, 5), 'Chapter 19 of 19');
  });

  test('chapter-list ordinals exclude front matter and preserve authored numbers', () => {
    const chapters = [
      { title: 'Copyright', type: 'copyright' },
      { title: 'Dedication', type: 'frontmatter' },
      { title: 'Contents', type: 'toc' },
      { title: 'Preface To The Second Edition', type: 'frontmatter' },
      { title: 'Introduction', type: 'frontmatter' },
      { title: '1 - The Thinker & The Prover', type: 'chapter' },
      { title: 'Chapter Two', type: 'chapter' }
    ];

    assert.strictEqual(chapterListOrdinal(chapters, 0), '');
    assert.strictEqual(chapterListOrdinal(chapters, 4), '');
    assert.strictEqual(chapterListOrdinal(chapters, 5), '01');
    assert.strictEqual(chapterListOrdinal(chapters, 6), '02');
  });

  test('player start does not jump to a late generic chapter after real content', () => {
    const chapters = [
      { title: 'Copyright', type: 'copyright', text: 'x'.repeat(1200) },
      { title: 'Introduction', type: 'content', text: 'x'.repeat(5000) },
      { title: 'Chapter 27', type: 'chapter', text: 'x'.repeat(2000) }
    ];
    assert.strictEqual(findPreferredStartChapterIndex(chapters), 1);
  });

  test('display-title sentence detection does not split at abbreviations', () => {
    assert.strictEqual(firstDisplaySentence('Son of Man vs. Son of God', { minLength: 12 }), '');
    assert.strictEqual(firstDisplaySentence('A Complete Title. This is body text.', { minLength: 12 }), 'A Complete Title.');
  });

  test('chapter order alone never presents enabled rows as played or disabled', () => {
    assert.strictEqual(chapterListItemState(4, 12), 'available');
    assert.strictEqual(chapterListItemState(12, 12), 'active');
    assert.strictEqual(chapterListItemState(18, 12), 'available');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
