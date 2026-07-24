const assert = require('assert');
const { chapterStructureKey, positionMatchesChapterStructure } = require('../lib/chapter-structure');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

const chapters = [
  { title: 'Introduction', type: 'content', sourceHref: 'intro.xhtml', text: 'old text' },
  { title: 'Chapter One', type: 'chapter', sourceHref: 'chapter-1.xhtml', text: 'old text' }
];

test('structure key ignores narration text and duration changes', () => {
  const revisedText = chapters.map(chapter => ({ ...chapter, text: 'new text', estimatedDuration: 999 }));
  assert.strictEqual(chapterStructureKey(revisedText), chapterStructureKey(chapters));
});

test('structure key changes when chapter identity or ordering changes', () => {
  assert.notStrictEqual(chapterStructureKey([...chapters].reverse()), chapterStructureKey(chapters));
  assert.notStrictEqual(chapterStructureKey([{ ...chapters[0], title: 'Foreword' }, chapters[1]]), chapterStructureKey(chapters));
});

test('versioned books reject positions from an older chapter structure', () => {
  const key = chapterStructureKey(chapters);
  assert.strictEqual(positionMatchesChapterStructure({ chapterStructureKey: key }, { chapterStructureKey: key }), true);
  assert.strictEqual(positionMatchesChapterStructure({}, { chapterStructureKey: key }), false);
  assert.strictEqual(positionMatchesChapterStructure({ chapterStructureKey: 'old' }, { chapterStructureKey: key }), false);
  assert.strictEqual(positionMatchesChapterStructure({}, {}), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
