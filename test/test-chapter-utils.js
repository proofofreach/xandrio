const assert = require('assert');
const {
  normalizeChapterSequence,
  mergeDegenerateSections,
  repairTextArtifacts,
  stripHTML
} = require('../lib/chapter-utils');
const {
  ALLOWED_TEXT_MUTATIONS,
  createMutationCollector
} = require('../lib/extraction-result');

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

test('does not promote generic attribution prose as a Roman-series subtitle', () => {
  const chapters = normalizeChapterSequence(Array.from({ length: 5 }, (_, index) => {
    const roman = toRoman(index + 1);
    return {
      title: roman,
      type: 'content',
      text: `${roman}\nA. Writer, with B. Editor: To the readers of this edition\n${'Substantive essay prose. '.repeat(100)}`
    };
  }));
  assert.deepStrictEqual(chapters.map(chapter => chapter.title), ['I', 'II', 'III', 'IV', 'V']);
  assert.ok(chapters.every(chapter => chapter.type === 'chapter'));
});

test('keeps concise authored subtitles in a Roman-numbered series', () => {
  const chapters = normalizeChapterSequence(Array.from({ length: 5 }, (_, index) => {
    const roman = toRoman(index + 1);
    return {
      title: roman,
      type: 'content',
      text: `${roman}\nA Quiet Beginning\n${'Substantive chapter prose. '.repeat(100)}`
    };
  }));
  assert.strictEqual(chapters[0].title, 'I: A Quiet Beginning');
  assert.strictEqual(chapters[4].title, 'V: A Quiet Beginning');
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

test('removes semantic EPUB pagebreak markers before extracting text', () => {
  assert.strictEqual(
    stripHTML([
      '<p>First printed page.</p>',
      '<span epub:type="pagebreak" id="page_37" title="37">37</span>',
      '<p>Second printed page.</p>',
      '<a role="doc-pagebreak" aria-label="38">38</a>',
      '<span epub:type="pagebreak" title="39"/>',
      '<span>Closing prose.</span>'
    ].join('')),
    'First printed page.\n Second printed page.\n Closing prose.'
  );
});

test('records each heuristic text mutation through the closed registry at the transformation site', () => {
  const collector = createMutationCollector();
  stripHTML([
    '<style>.hidden { display: none; }</style>',
    '<p>First­word.</p>',
    '<span epub:type="pagebreak">37</span>',
    '<p>self-\ncriticism and W I N D.</p>',
    '<table><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></table>'
  ].join(''), { mutationRecorder: collector.record });
  const codes = new Set(collector.values().map(mutation => mutation.code));
  for (const policy of [
    ALLOWED_TEXT_MUTATIONS.RECOGNIZED_BOILERPLATE_REMOVAL,
    ALLOWED_TEXT_MUTATIONS.INVISIBLE_CHARACTER_REMOVAL,
    ALLOWED_TEXT_MUTATIONS.SEMANTIC_PAGE_MARKER_REMOVAL,
    ALLOWED_TEXT_MUTATIONS.LINE_WRAP_DEHYPHENATION,
    ALLOWED_TEXT_MUTATIONS.SPACED_CAPS_NORMALIZATION
  ]) {
    assert(codes.has(policy.code), `missing registered activation for ${policy.code}`);
  }
});

// ── Degenerate section merge ─────────────────────────────────────────────────
// Synthetic, non-copyrighted sources shaped like the real evidence class: a
// collection whose authored navigation emits a bare source-work divider ahead
// of every excerpt, and a spine that emits stray figure captions as sections.

function narration(label, repetitions = 30) {
  return `${label} continues with complete synthetic sentences for characterization. `.repeat(repetitions);
}

function normalizedNarration(chapters) {
  return chapters
    .map(chapter => String(chapter.text || ''))
    .join('\n\n')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

test('authored divider sections merge forward and conserve narration exactly', () => {
  const source = [
    { index: 0, title: 'FROM', type: 'divider', tocTitleSource: 'href', text: 'FROM\n\nThe First Volume\n(1961)' },
    { index: 1, title: 'Chapter 2', type: 'chapter', tocTitleSource: 'href', text: narration('Excerpt one') },
    { index: 2, title: 'FROM', type: 'divider', tocTitleSource: 'href', text: 'FROM\n\nThe Second Volume:\n\nAn Honest Sequel\n(1972)' },
    { index: 3, title: 'Chapter 3', type: 'chapter', tocTitleSource: 'href', text: narration('Excerpt two') },
    { index: 4, title: 'A Named Essay', type: 'content', tocTitleSource: 'href', text: narration('Essay') }
  ];
  const merged = mergeDegenerateSections(source);
  assert.strictEqual(merged.length, 3, 'each divider joins the excerpt it introduces');
  assert.strictEqual(normalizedNarration(merged), normalizedNarration(source),
    'merging is a boundary change, never a text change');
  assert.deepStrictEqual(merged.map(chapter => chapter.title), [
    'FROM The First Volume (1961)',
    'FROM The Second Volume: An Honest Sequel (1972)',
    'A Named Essay'
  ], 'a divider hands its authored name to a host still labelled with an ordinal');
  assert.deepStrictEqual(merged.map(chapter => chapter.rawTitle), ['Chapter 2', 'Chapter 3', undefined],
    'the original title is retained, so the chapter structure key is unaffected by promotion');
  assert.strictEqual(merged[0].mergedSectionCount, 1);
});

test('a merged stub never relabels narrative text as front matter', () => {
  const source = [
    { index: 0, title: 'Dedication', type: 'divider', tocTitleSource: 'href', text: 'TO MARCIA' },
    { index: 1, title: 'ALSO BY', type: 'divider', tocTitleSource: 'href', text: 'ALSO BY A. WRITER\nAn Earlier Collection' },
    { index: 2, title: 'Chapter 1', type: 'chapter', tocTitleSource: 'href', text: narration('First story') },
    { index: 3, title: 'A Named Story', type: 'content', tocTitleSource: 'href', text: narration('Second story') },
    { index: 4, title: 'Another Story', type: 'content', tocTitleSource: 'href', text: narration('Third story') }
  ];
  const merged = mergeDegenerateSections(source);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(normalizedNarration(merged), normalizedNarration(source));
  assert.strictEqual(merged[0].title, 'Chapter 1',
    'a single-line stub and an auxiliary label are both refused as titles for a story');
  assert.strictEqual(merged[0].rawTitle, undefined, 'a refused promotion leaves the title untouched');
  assert.deepStrictEqual(merged[0].parentContext, ['To Marcia', 'ALSO BY A. WRITER An Earlier Collection'],
    'the absorbed headings stay available as context even when they cannot be titles');
});

test('an auxiliary label still names a host of the same non-narrative class', () => {
  const source = [
    { index: 0, title: 'Chapter 1', type: 'copyright', tocTitleSource: 'href', text: 'COPYRIGHT\nFirst Edition\nAll rights reserved' },
    { index: 1, title: 'Chapter 2', type: 'copyright', tocTitleSource: 'href', text: `Copyright notice text. ${'Reserved rights notice. '.repeat(12)}` },
    { index: 2, title: 'A Named Story', type: 'content', tocTitleSource: 'href', text: narration('Story') },
    { index: 3, title: 'Another Story', type: 'content', tocTitleSource: 'href', text: narration('Second') }
  ];
  const merged = mergeDegenerateSections(source);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged[0].title, 'COPYRIGHT First Edition All rights reserved');
  assert.strictEqual(merged[0].rawTitle, 'Chapter 2');
});

test('un-authored sub-threshold fragments merge into the following section', () => {
  const source = [
    { index: 0, title: 'Chapter 1', type: 'chapter', text: 'A ceremonial mask photographed on a field expedition' },
    { index: 1, title: 'Opening', type: 'content', tocTitleSource: 'href', text: narration('Opening') },
    { index: 2, title: 'Closing', type: 'content', tocTitleSource: 'href', text: narration('Closing') },
    { index: 3, title: 'Later', type: 'content', tocTitleSource: 'href', text: narration('Later') }
  ];
  const merged = mergeDegenerateSections(source);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(normalizedNarration(merged), normalizedNarration(source));
  assert.strictEqual(merged[0].title, 'Opening', 'a caption fragment never renames its host');
});

test('a short prose section keeps its own name and its own boundary', () => {
  const source = [
    { index: 0, title: 'The Door', type: 'chapter', text: 'He said nothing. The door closed behind him.' },
    { index: 1, title: 'Chapter 5', type: 'chapter', tocTitleSource: 'href', text: narration('Fifth') },
    { index: 2, title: 'Chapter 6', type: 'chapter', tocTitleSource: 'href', text: narration('Sixth') }
  ];
  assert.deepStrictEqual(mergeDegenerateSections(source), source,
    'only an ordinal placeholder marks sub-threshold prose as unclaimed spine debris');
});

test('a short section with authored navigation and real prose is kept', () => {
  const source = [
    {
      index: 0,
      title: 'Editor’s Note',
      type: 'content',
      tocTitleSource: 'href',
      text: 'The editor recorded that this excerpt comes from an unfinished manuscript, and that the spelling follows the surviving typescript exactly.'
    },
    { index: 1, title: 'Opening', type: 'content', tocTitleSource: 'href', text: narration('Opening') },
    { index: 2, title: 'Closing', type: 'content', tocTitleSource: 'href', text: narration('Closing') }
  ];
  assert.deepStrictEqual(mergeDegenerateSections(source), source,
    'prose behind an authored navigation entry is a section, not a divider');
});

test('a book built from short sections is left alone', () => {
  const poems = Array.from({ length: 12 }, (unused, number) => ({
    index: number,
    title: `Poem ${number + 1}`,
    type: 'content',
    text: `Poem ${number + 1}\n\nA short verse\nof four brief lines\nabout the desert`
  }));
  assert.deepStrictEqual(mergeDegenerateSections(poems), poems,
    'the density guard declines rather than destroy authored short-form structure');
});

test('merging never manufactures an unusable oversized chapter', () => {
  const source = [
    { index: 0, title: 'PART ONE', type: 'divider', text: 'PART ONE\n\nThe Long Section' },
    { index: 1, title: 'Chapter 1', type: 'chapter', tocTitleSource: 'href', text: 'x'.repeat(100000) },
    { index: 2, title: 'Chapter 2', type: 'chapter', tocTitleSource: 'href', text: narration('Second') },
    { index: 3, title: 'Chapter 3', type: 'chapter', tocTitleSource: 'href', text: narration('Third') }
  ];
  const merged = mergeDegenerateSections(source);
  assert.strictEqual(merged.length, 4, 'the divider stays separate rather than push a host over the limit');
  assert.strictEqual(normalizedNarration(merged), normalizedNarration(source));
});

test('trailing dividers merge backward instead of ending the book on a stub', () => {
  const source = [
    { index: 0, title: 'Opening', type: 'content', tocTitleSource: 'href', text: narration('Opening') },
    { index: 1, title: 'Closing', type: 'content', tocTitleSource: 'href', text: narration('Closing') },
    { index: 2, title: 'Later', type: 'content', tocTitleSource: 'href', text: narration('Later') },
    { index: 3, title: 'END', type: 'divider', text: 'What’s next on\n\nyour reading list' }
  ];
  const merged = mergeDegenerateSections(source);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(normalizedNarration(merged), normalizedNarration(source));
  assert.strictEqual(merged[2].title, 'Later', 'a backward merge never renames its host');
});

test('the merge runs inside sequence normalization and is idempotent', () => {
  const source = [
    { index: 0, title: 'FROM', type: 'divider', tocTitleSource: 'href', text: 'FROM\n\nThe First Volume\n(1961)' },
    { index: 1, title: 'Chapter 2', type: 'chapter', tocTitleSource: 'href', text: narration('Excerpt one') },
    { index: 2, title: 'A Named Essay', type: 'content', tocTitleSource: 'href', text: narration('Essay') },
    { index: 3, title: 'Another Essay', type: 'content', tocTitleSource: 'href', text: narration('Another') }
  ];
  const once = normalizeChapterSequence(source);
  const twice = normalizeChapterSequence(once);
  assert.strictEqual(once.length, 3);
  assert.strictEqual(normalizedNarration(once), normalizedNarration(source));
  assert.deepStrictEqual(twice.map(chapter => chapter.title), once.map(chapter => chapter.title));
  assert.strictEqual(twice.length, once.length, 're-reading a stored artifact must not re-cut it');
  assert.deepStrictEqual(once.map(chapter => chapter.index), [0, 1, 2]);
});


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
