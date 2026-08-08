const assert = require('node:assert/strict');
const { prepareTtsText } = require('../lib/tts-text');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

test('expands numeric ordinals before narration reaches a TTS engine', () => {
  assert.equal(
    prepareTtsText('The hearing was held on the 22nd of May.'),
    'The hearing was held on the twenty-second of May.'
  );
});

test('expands irregular and compound ordinal endings', () => {
  assert.equal(
    prepareTtsText('The 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 23rd, and 31st entries.'),
    'The first, second, third, fourth, eleventh, twelfth, thirteenth, twenty-first, twenty-third, and thirty-first entries.'
  );
});

test('expands larger ordinals and comma-grouped source numbers', () => {
  assert.equal(
    prepareTtsText('Milestones were the 100th, 101st, 1,000th, and 1,001st.'),
    'Milestones were the one hundredth, one hundred first, one thousandth, and one thousand first.'
  );
});

test('expands currency amounts before narration reaches a TTS engine', () => {
  assert.equal(
    prepareTtsText('The award was $3,000, plus $4.00 in costs and $0.50 in interest.'),
    'The award was three thousand dollars, plus four dollars in costs and fifty cents in interest.'
  );
  assert.equal(
    prepareTtsText('Balances were $1, $1.01, $1000, and $1,000,000.'),
    'Balances were one dollar, one dollar and one cent, one thousand dollars, and one million dollars.'
  );
  assert.equal(
    prepareTtsText('Other amounts were £1.01, €2.50, and ¥3,000.'),
    'Other amounts were one pound and one penny, two euros and fifty cents, and three thousand yen.'
  );
});

test('expands large cardinal numbers before narration reaches a TTS engine', () => {
  assert.equal(
    prepareTtsText('There were 90,000 claims among 110,000,000,000 records.'),
    'There were ninety thousand claims among one hundred ten billion records.'
  );
});

test('preserves decimal, malformed, and identifier forms while expanding ordinals', () => {
  assert.equal(
    prepareTtsText('Values 3,000.50 and 12,34,567; ordinal 1,000th; ISBN 9781862877337; docket 22-6810.'),
    'Values 3,000.50 and 12,34,567; ordinal one thousandth; ISBN 9781862877337; docket 22-6810.'
  );
});

test('preserves malformed ordinal suffixes instead of changing their meaning', () => {
  assert.equal(
    prepareTtsText('References 11st, 12nd, and 13rd are source errors.'),
    'References 11st, 12nd, and 13rd are source errors.'
  );
});

test('expands statutory sections, ranges, subsections, and jurisdictions', () => {
  assert.equal(
    prepareTtsText('s 90 and s 138 of the Evidence Act 1995 (NSW).'),
    'section ninety and section one hundred thirty-eight of the Evidence Act nineteen ninety-five, New South Wales.'
  );
  assert.equal(
    prepareTtsText('ss 90–92; s 138(1)(a); sub-s 138(3)(a)-(h).'),
    'sections ninety through ninety-two; section one hundred thirty-eight, subsection one, paragraph A; subsection one hundred thirty-eight, subsection three, paragraphs A through H.'
  );
});

test('narrates Australian case citations with semantic volume and page labels', () => {
  assert.equal(
    prepareTtsText('R v Lee (1950) 82 CLR 133; R v Ireland (1970) 126 CLR 321; Bunning v Cross (1978) 141 CLR 54.'),
    'R versus Lee, nineteen fifty, volume eighty-two C L R, page one hundred thirty-three; R versus Ireland, nineteen seventy, volume one hundred twenty-six C L R, page three hundred twenty-one; Bunning versus Cross, nineteen seventy-eight, volume one hundred forty-one C L R, page fifty-four.'
  );
});

test('narrates neutral court citations, case numbers, and paragraph pinpoints', () => {
  assert.equal(
    prepareTtsText('A v Home Secretary (No 2) [2005] UKHL 71; R v Malloy (1999) ACTSC 118, at [10]; LK [2010] HCA 17, at [97].'),
    'A versus Home Secretary (Number two), two thousand five, U K H L, case seventy-one; R versus Malloy, nineteen ninety-nine, A C T S C, case one hundred eighteen, at paragraph ten; LK, twenty ten, H C A, case seventeen, at paragraph ninety-seven.'
  );
});

test('narrates United States reporter citations and shortened pinpoint ranges', () => {
  assert.equal(
    prepareTtsText('Wong Sun v United States, 371 U.S. 471 (1963), at 484–85; Brown v Illinois, 422 U.S. 590 (1975).'),
    'Wong Sun versus United States, volume three hundred seventy-one U S, page four hundred seventy-one, nineteen sixty-three, at four hundred eighty-four through four hundred eighty-five; Brown versus Illinois, volume four hundred twenty-two U S, page five hundred ninety, nineteen seventy-five.'
  );
});

test('narrates reporter series, court parentheticals, and qualified UK court codes', () => {
  assert.equal(
    prepareTtsText('United States v Smith, 366 F. Supp. 717 (E.D.N.Y. 1973); Roe v Wade, 45 L. Ed. 2d 90 (1975); R v Example [2000] EWCA Crim 12.'),
    'United States versus Smith, volume three hundred sixty-six Federal Supplement, page seven hundred seventeen, E D N Y, nineteen seventy-three; Roe versus Wade, volume forty-five Lawyers Edition second series, page ninety, nineteen seventy-five; R versus Example, two thousand, E W C A Criminal, case twelve.'
  );
});

test('expands legal structural markers, Roman provisions, rules, notes, and pages', () => {
  assert.equal(
    prepareTtsText('Pt IIA, Sch 1, Div IV, reg 7, cl 8, r 3.4(2), para 9, n 182–86, pp 619–20, No 2.'),
    'Part two A, Schedule one, Division four, regulation seven, clause eight, rule three point four, subsection two, paragraph nine, notes one hundred eighty-two through one hundred eighty-six, pages six hundred nineteen through six hundred twenty, Number two.'
  );
});

test('supports compact section symbols, plural subsections, and provision lists', () => {
  assert.equal(
    prepareTtsText('s.78; §1983; §§1983–1985; ss 76(4), 78 and 90; sub-ss 138(2)(a) and 138(2)(b).'),
    'section seventy-eight; section one thousand nine hundred eighty-three; sections one thousand nine hundred eighty-three through one thousand nine hundred eighty-five; sections seventy-six, subsection four, seventy-eight and ninety; subsections one hundred thirty-eight, subsection two, paragraph A and one hundred thirty-eight, subsection two, paragraph B.'
  );
});

test('narrates United States statutory code references without absorbing the next citation', () => {
  assert.equal(
    prepareTtsText('42 U.S.C. § 1983 and 28 C.F.R. § 35.130.'),
    'title forty-two U S C, section one thousand nine hundred eighty-three and title twenty-eight C F R, section thirty-five point one hundred thirty.'
  );
});

test('normalizes unambiguous month-name dates while preserving numeric dates', () => {
  assert.equal(
    prepareTtsText('The decisions were issued May 22, 1990, and 2 September 1997; 22/5/1990 remains ambiguous.'),
    'The decisions were issued May twenty-second, nineteen ninety, and the second of September, nineteen ninety-seven; 22/5/1990 remains ambiguous.'
  );
});

test('normalizes numeric and Roman constitutional amendment references', () => {
  assert.equal(
    prepareTtsText('Amendment 4, Amendments IV–VI, and the 22nd Amendment.'),
    'Amendment four, Amendments four through six, and the twenty-second Amendment.'
  );
});

test('narrates Roman chapter markers as cardinal numbers', () => {
  assert.equal(
    prepareTtsText('Chapter IV. Chapters IX–XI. Ch. XLII.'),
    'Chapter four. Chapters nine through eleven. Ch. forty-two.'
  );
  assert.equal(
    prepareTtsText('IV\n\nThe fourth chapter begins here.'),
    'four\n\nThe fourth chapter begins here.'
  );
  assert.equal(
    prepareTtsText('XIV: A Difficult Choice'),
    'fourteen: A Difficult Choice'
  );
});

test('does not reinterpret unmarked identifiers or ambiguous numeric forms', () => {
  assert.equal(
    prepareTtsText('I was in Room 138 with version 3.4, code s90, docket 22-6810, ISBN 9781862877337, and date 22/5/1990.'),
    'I was in Room 138 with version 3.4, code s90, docket 22-6810, ISBN 9781862877337, and date 22/5/1990.'
  );
});

console.log(`tts-text tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
