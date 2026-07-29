const assert = require('assert');
const {
  normalizeChapterSequence,
  repairTextArtifacts
} = require('../lib/chapter-utils');

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

function toRoman(value) {
  const pairs = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ];
  let remaining = value;
  let roman = '';
  for (const [amount, marker] of pairs) {
    while (remaining >= amount) {
      roman += marker;
      remaining -= amount;
    }
  }
  return roman;
}

function federalistFixture() {
  const headings = new Map([
    [1, 'General Introduction'],
    [29, 'Concerning the Militia'],
    [58, 'Objection That the Number of Members Will Not Be Augmented as the Progress of Population Demands'],
    [82, 'The Judiciary Continued']
  ]);
  return [
    { title: 'Introduction', type: 'frontmatter', text: 'Introduction\n' + 'Prefatory prose. '.repeat(80) },
    ...Array.from({ length: 85 }, (_, offset) => {
      const number = offset + 1;
      const roman = toRoman(number);
      const heading = headings.get(number) || `Authored Essay ${number}`;
      const marker = number === 29 ? `${roman} 32` : roman;
      const leadingBookTitle = number === 1 ? 'The Federalist Papers\n' : '';
      const numberedArgument = number === 58
        ? '\n1. First objection\n2. Second objection\n3. Third objection'
        : '';
      return {
        title: roman,
        type: 'content',
        text: `${leadingBookTitle}${marker}\n${heading}${numberedArgument}\n${'Substantive essay prose. '.repeat(80)}`
      };
    }),
    { title: 'Endnotes', type: 'backmatter', text: 'Endnotes\n' + 'Notes. '.repeat(80) }
  ];
}

test('repairs every title and type class in a long Roman-numbered essay series', () => {
  const chapters = normalizeChapterSequence(federalistFixture());
  const papers = chapters.slice(1, 86);

  assert.strictEqual(papers[0].title, 'I: General Introduction');
  assert.strictEqual(papers[28].title, 'XXIX: Concerning the Militia');
  assert.strictEqual(
    papers[57].title,
    'LVIII: Objection That the Number of Members Will Not Be Augmented as the Progress of Population Demands'
  );
  assert.strictEqual(papers[81].title, 'LXXXII: The Judiciary Continued');
  assert.ok(papers.every(chapter => chapter.type === 'chapter'));
  assert.strictEqual(papers[0].rawTitle, 'I');
  assert.strictEqual(papers[57].rawTitle, 'LVIII');
  assert.strictEqual(papers[57].rawType, 'content');
});

test('does not reinterpret a short incidental Roman-numbered run', () => {
  const chapters = normalizeChapterSequence([
    { title: 'Appendix I', type: 'content', text: 'I\nFirst note\n' + 'Text. '.repeat(100) },
    { title: 'Appendix II', type: 'content', text: 'II\nSecond note\n' + 'Text. '.repeat(100) },
    { title: 'Appendix III', type: 'content', text: 'III\nThird note\n' + 'Text. '.repeat(100) }
  ]);
  assert.deepStrictEqual(chapters.map(chapter => chapter.title), ['Appendix I', 'Appendix II', 'Appendix III']);
  assert.ok(chapters.every(chapter => chapter.type === 'content'));
});

test('preserves trusted TOC titles while correcting their chapter type', () => {
  const fixture = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    const roman = toRoman(number);
    return {
      title: `${roman}: Trusted Subtitle ${number}`,
      type: 'content',
      fromToc: true,
      text: `${roman}\nDifferent Printed Subtitle ${number}\n${'Text. '.repeat(100)}`
    };
  });
  const chapters = normalizeChapterSequence(fixture);
  assert.deepStrictEqual(chapters.map(chapter => chapter.title), fixture.map(chapter => chapter.title));
  assert.ok(chapters.every(chapter => chapter.type === 'chapter'));
});

test('does not misclassify a numbered essay as an author biography', () => {
  const fixture = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    const roman = toRoman(number);
    return {
      title: roman,
      type: 'content',
      text: `${roman}\nAuthored Essay ${number}\nThe writer is the author of several arguments. ${'Text. '.repeat(100)}`
    };
  });
  const chapters = normalizeChapterSequence(fixture);
  assert.ok(chapters.every(chapter => chapter.type === 'chapter'));
  assert.ok(chapters.every(chapter => !chapter.title.startsWith('About ')));
});

test('removes printed page numbers fused to Roman headings only', () => {
  assert.strictEqual(
    repairTextArtifacts('XXIX 32\nConcerning the Militia\nBody text.'),
    'XXIX\nConcerning the Militia\nBody text.'
  );
  assert.strictEqual(
    repairTextArtifacts('In section XXIX 32 examples were counted.'),
    'In section XXIX 32 examples were counted.'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
