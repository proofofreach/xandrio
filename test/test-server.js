/**
 * Server API Integration Tests
 * 
 * Tests helper functions extracted from server.js:
 *   - stripHTML()
 *   - calculateQualityScore()
 *   - parseAnnasResults()
 *   - normalizeTitle()
 *   - parseSizeToBytes()
 *   - selectBestResult()
 *   - shouldFilterChapter()
 *   - Search relevance scoring
 *
 * Run:  node test/test-server.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseAudioRange } = require('../lib/audio-response');
const { isGoogleBooksCoverMatch } = require('../lib/cover-service');
const { isSafeBookId } = require('../lib/request-guards');
const hemingwayCrossSourceResults = require('./fixtures/hemingway-cross-source-results.json');
const {
  calculateQualityScore,
  parseAnnasResults,
  parseSizeToBytes,
  selectBestResult,
  sourceFileQualityPenalty
} = require('../lib/search-utils');
const {
  stripHTML,
  shouldFilterChapter,
  buildChapterQuality,
  validateExtractedChapters,
  isChapterOneTitle,
  isChapterLikeTitle,
  normalizeChapterType,
  normalizeChapterSequence,
  normalizeChapterTitleForDisplay,
  findPreferredAudioStartChapterIndex,
  splitOversizedChapters
} = require('../lib/chapter-utils');
const {
  isGarbageTitle,
  normalizeAuthorForDisplay,
  resolveMetadataSeed,
  scoreOpenLibraryDoc,
  resolveOpenLibraryIdentity
} = require('../lib/metadata-service');
const {
  normalizePdfText,
  normalizePdfPages
} = require('../lib/pdf-text-normalizer');
const {
  getKokoroChunkSize,
  getKokoroVariantKey,
  prepareKokoroText
} = require('../lib/kokoro-tuning');
const {
  canonicalWorkKey,
  findDuplicateBook,
  assessExtractedContent,
  assessMetadataConfidence
} = require('../lib/import-validation');
const {
  prepareTtsText,
  splitOversizedText,
  isSpeakableText
} = require('../lib/tts-text');
const {
  __test: serverTestHooks
} = require('../server');

// ─── Test Framework ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const pendingAsyncTests = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

function assertDeep(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message} — expected ${expectedJson}, got ${actualJson}`);
  }
}

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

function normalizeTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*:\s*.*/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(pubStr) {
  if (!pubStr) return null;
  const match = pubStr.match(/(19|20)\d{2}/);
  return match ? parseInt(match[0]) : null;
}

// ─── 1. stripHTML Tests ──────────────────────────────────────────────────────

section('1. stripHTML');

(() => {
  // 1a. Basic tag removal
  const r1 = stripHTML('<p>Hello</p>');
  assert(r1.includes('Hello'), 'Basic tag removal: <p>Hello</p> → Hello');
  assert(!r1.includes('<'), 'No HTML tags remain');

  // 1b. Entity decoding
  const r2 = stripHTML('&amp; &lt; &gt; &quot;');
  assert(r2.includes('&'), 'Decodes &amp; → &');
  assert(r2.includes('<'), 'Decodes &lt; → <');
  assert(r2.includes('>'), 'Decodes &gt; → >');
  assert(r2.includes('"'), 'Decodes &quot; → "');

  // 1c. Apostrophe entity
  const r3 = stripHTML('don&#39;t');
  assert(r3.includes("don't"), "Decodes &#39; → '");

  // 1d. Script/style removal
  const r4 = stripHTML('<style>.foo { color: red; }</style><p>Content</p><script>alert("x")</script>');
  assert(r4.includes('Content'), 'Preserves content after script/style removal');
  assert(!r4.includes('color'), 'Removes style content');
  assert(!r4.includes('alert'), 'Removes script content');

  // 1e. Nested tags
  const r5 = stripHTML('<div><p><strong><em>Deep</em></strong></p></div>');
  assert(r5.includes('Deep'), 'Handles deeply nested tags');
  assert(!r5.includes('<'), 'No tags remain from nested input');

  // 1f. Empty input
  const r6 = stripHTML('');
  assertEqual(r6, '', 'Empty string returns empty');

  // 1g. Styled/spaced-out text (Winnie-the-Pooh style)
  const r7 = stripHTML('<span>W</span> <span>INNIE</span>');
  // The function collapses single uppercase letters with spaces: "W INNIE" → "WINNIE"
  assert(r7.includes('WINNIE') || r7.includes('W INNIE'), 'Styled text is cleaned up');

  // 1h. Spaced-out all-caps text
  const r8 = stripHTML('W I N N I E');
  // The regex .replace(/\b([A-Z])\s+([A-Z])/g, '$1$2') handles letter-by-letter
  assert(r8.length < 'W I N N I E'.length, 'Spaced-out letters are collapsed');

  // 1i. HTML source whitespace collapses like a browser: hard-wrapped
  // (pretty-printed) XHTML must not leave mid-sentence line breaks, which
  // become audible TTS pauses. Real breaks come only from block tags/<br>.
  const rWrap = stripHTML('<p>And he heard\n a child crying.\n They were his own tears.</p><p>Next paragraph.</p>');
  assert(rWrap.includes('heard a child crying. They were his own tears.'),
    'Source newlines inside a paragraph collapse to spaces');
  assert(/tears\.\s*\n/.test(rWrap), 'Block-tag boundaries still produce line breaks');
  const rBr = stripHTML('<p>Line one<br/>Line two</p>');
  assert(/Line one\s*\n\s*Line two/.test(rBr), '<br> still produces a line break');

  // 1j. Hyphenated compound split across a source line wrap rejoins;
  // suspended hyphens before coordinations keep their space.
  const rHyph = stripHTML('<p>an act of self- \ncriticism and copper- \nand iron-tipped arrows</p>');
  assert(rHyph.includes('self-criticism'), 'Hyphen + line wrap rejoins compound word');
  assert(rHyph.includes('copper- and iron-tipped'), 'Suspended hyphen before coordination keeps its space');

  // 1k. Invisible characters are removed (soft hyphen, zero-width space)
  const rInvis = stripHTML('<p>every­one knows zero​width</p>');
  assert(rInvis.includes('everyone') && rInvis.includes('zerowidth'), 'Soft hyphens and zero-width chars are stripped');

  // 1k2. Soft-hyphen entity + inline span mid-word (real EPUB pattern:
  // "there&shy;<span>fore", "self-</span>criticism")
  const rShy = stripHTML('<p>And there&shy;<span>fore do You resist</span></p>');
  assert(rShy.includes('therefore'), '&shy; entity followed by inline tag rejoins the word');
  const rSpanHyph = stripHTML('<p>we admire <span>his self-</span>criticism.</p>');
  assert(rSpanHyph.includes('self-criticism'), 'Inline tag after a hyphen rejoins the compound');

  // 1l. Mostly-numeric data tables are dropped; prose tables survive
  const rNumTable = stripHTML('<p>Before.</p><table><tr><td>Able Creek</td><td>73</td><td>42</td><td>120</td><td>02</td></tr><tr><td>Academy Glacier</td><td>81</td><td>30</td><td>32</td><td>10</td></tr></table><p>After.</p>');
  assert(!rNumTable.includes('73') && rNumTable.includes('Before.') && rNumTable.includes('After.'),
    'Mostly-numeric table is dropped from narration text');
  const rProseTable = stripHTML('<table><tr><td>When on high the heaven had not been named,</td></tr><tr><td>Firm ground below had not been called by name.</td></tr></table>');
  assert(rProseTable.includes('heaven had not been named'), 'Prose laid out in a table is kept');

  // 1i. BR tags become newlines
  const r9 = stripHTML('Line 1<br>Line 2<br/>Line 3');
  assert(r9.includes('Line 1') && r9.includes('Line 2') && r9.includes('Line 3'),
    'BR tags converted to newlines, content preserved');

  // 1j. &nbsp; handling
  const r10 = stripHTML('Hello&nbsp;World');
  assert(r10.includes('Hello') && r10.includes('World'), '&nbsp; replaced with space');

  // 1k. Block elements get newlines
  const r11 = stripHTML('<p>Para 1</p><p>Para 2</p>');
  assert(r11.includes('Para 1') && r11.includes('Para 2'), 'Paragraphs are preserved');

  // 1l. Hyphen cleanup in all-caps
  const r12 = stripHTML('WINNIE-  THE-  POOH');
  // The regex fixes "X-  Y" → "X-Y" in all-caps
  assert(!r12.includes('-  ') || r12.includes('WINNIE'), 'Hyphen spacing cleaned in caps');

  // 1m. Multiple whitespace collapse
  const r13 = stripHTML('Hello     World');
  assert(!r13.includes('     '), 'Multiple spaces collapsed');

  // 1n. Unknown entities replaced
  const r14 = stripHTML('Hello&mdash;World');
  assert(!r14.includes('&mdash;'), 'Unknown HTML entities replaced');
  assertEqual(r14, 'Hello—World', 'Decodes named dash entity');

  const r15 = stripHTML('<b><i>NEW YORK TIMES </i>BEST SELLER &bull; Sam &amp; Sadie&mdash;friends&#160;forever</b><br>It isn&rsquo;t simple.');
  assert(!/[<>]|&bull;|&mdash;|&rsquo;|&#160;/.test(r15), 'Book-description style HTML/entities are cleaned');
  assert(r15.includes('NEW YORK TIMES BEST SELLER • Sam & Sadie—friends forever'), 'Preserves readable description text');

  const r16 = serverTestHooks.cleanBookDescription('**This *New York Times* – bestseller** by the author of *Arctic Dreams * was called “dazzling” (*The** New York Times*).');
  assert(!/[*_`]/.test(r16), 'Book descriptions remove leaked Markdown emphasis markers');
  assert(r16.includes('This New York Times – bestseller'), 'Markdown cleanup preserves description prose');
  assert(r16.includes('(The New York Times)'), 'Markdown cleanup repairs malformed italic source names');

  // 1o. Single-capital words are NOT joined into the next word ("A Canticle" bug)
  const r17 = stripHTML('<p>A Canticle For Leibowitz</p>');
  assert(r17.includes('A Canticle'), 'Does not corrupt "A Canticle" into "ACanticle"');
  const r18 = stripHTML('<p>I Am Legend</p>');
  assert(r18.includes('I Am'), 'Does not corrupt "I Am" into "IAm"');

  // 1p. Drop-cap repair: lone capital in its own block, word continues lowercase
  const r19 = stripHTML('<h2>1</h2><table><tr><td><p><b><span>B</span></b></p></td></tr></table><p>rother Francis Gerard of Utah might never have discovered it.</p>');
  assert(r19.includes('Brother Francis'), 'Drop-cap letter rejoined with its word');
  const r20 = stripHTML('<td><p><span> </span>“<b><span>Y</span></b></p></td><p>ou did the right thing.</p>');
  assert(r20.includes('You did'), 'Drop-cap after opening quote rejoined');

  // 1q. Digit headings split across spans ("2 4" → "24")
  const r21 = stripHTML('<h2><span>2</span><span>4</span></h2><p>There were spaceships again in that century.</p>');
  assert(/(^|\n)24\b/.test(r21), 'Split digit heading rejoined to "24"');

  // 1r. Literal non-breaking spaces treated as whitespace
  const r22 = stripHTML('<p>Hello\u00a0World</p>');
  assert(r22.includes('Hello World'), 'Literal   character normalized to space');

  // 1s. Spaced small caps still collapse, mid-sentence linebreaks untouched
  const r23 = stripHTML('W I N N I E');
  assert(r23 === 'WINNIE', 'Letter-by-letter caps run still collapses');
  const r24 = stripHTML('<p>and I</p><p>came back home to the village.</p>');
  assert(r24.includes('I\n') || r24.includes('I '), 'Trailing "I" before block break is not merged into next word');

  // 1t. Same-line inline drop caps and mid-word markup rejoin without a space
  const r25 = stripHTML('<p><span class="dropcap">K</span>al stood up straight.</p>');
  assert(r25.includes('Kal stood'), 'Inline span drop cap rejoined ("K al" fixed)');
  const r26 = stripHTML('<p>It was im<i>possible</i> to say.</p>');
  assert(r26.includes('impossible'), 'Mid-word emphasis tags removed without a space');
  const r27 = stripHTML('<p><b>T</b>ony was a rogue.</p>');
  assert(r27.includes('Tony was'), 'Inline bold drop cap rejoined ("T ony" fixed)');
  const r28 = stripHTML('<p><span>W</span> <span>INNIE</span> lived in a forest.</p>');
  assert(r28.includes('WINNIE'), 'Spaced styled small caps still collapse');
  const r29 = stripHTML('<p>He said <i>quietly</i> that it was fine.</p>');
  assert(r29.includes('said quietly that'), 'Normal inter-word markup keeps its spaces');
})();

// ─── 1b. sourceFileQualityPenalty ────────────────────────────────────────────

section('1b. sourceFileQualityPenalty');

(() => {
  const rtf = sourceFileQualityPenalty({
    title: 'A Canticle For Leibowitz',
    filePath: 'lgli/RW_1961-_Walter_Miller_-_A_Canticle_for_Leibowitz_(RTF).epub'
  });
  assert(rtf.penalty >= 40, 'RTF conversion path is penalized');
  assert(rtf.labels.includes('rtf-conversion'), 'RTF penalty is labeled');

  const retail = sourceFileQualityPenalty({
    title: 'A Canticle for Leibowitz',
    filePath: 'lgli/Walter M. Miller - A Canticle for Leibowitz (Harper Collins, Inc.).epub'
  });
  assert(retail.penalty <= 0, 'Publisher-named file is not penalized');

  const epublibre = sourceFileQualityPenalty({
    title: 'A Canticle for Leibowitz',
    filePath: 'lgli/Miller - A Canticle for Leibowitz (1960, ePubLibre).epub'
  });
  assert(epublibre.penalty < 0, 'ePubLibre curated release gets a bonus');

  const ocr = sourceFileQualityPenalty({ title: 'Some Book [OCR]', filePath: '' });
  assert(ocr.penalty >= 40, 'OCR marker in title is penalized');

  const none = sourceFileQualityPenalty({ title: 'Clean Title' });
  assertEqual(none.penalty, 0, 'Clean result gets zero penalty');

  const empty = sourceFileQualityPenalty({});
  assertEqual(empty.penalty, 0, 'Missing fields are safe');
})();

// ─── 2. calculateQualityScore Tests ──────────────────────────────────────────

section('2. calculateQualityScore');

(() => {
  // 2a. EPUB base score
  const epub = calculateQualityScore({ format: 'EPUB', size: '5 MB', title: 'Test', author: 'Author', publisher: 'Pub 2023' });
  assert(epub >= 4.5, `EPUB with good metadata scores high (${epub} ≥ 4.5)`);

  // 2b. PDF base score
  const pdf = calculateQualityScore({ format: 'PDF', size: '5 MB', title: 'Test', author: 'Unknown', publisher: '' });
  assert(pdf < 2.0, `PDF is a fallback audiobook source (${pdf} < 2.0)`);
  assert(pdf >= 1.0, `PDF score is at least 1.0 (${pdf})`);

  // 2c. MOBI base score
  const mobi = calculateQualityScore({ format: 'MOBI', size: '2 MB', title: 'Test', author: 'Author', publisher: 'Pub' });
  assert(mobi >= 4.0, `MOBI base score is ≥ 4.0 (${mobi})`);

  // 2d. Unknown format score
  const unknown = calculateQualityScore({ format: 'DJVU', size: '2 MB', title: 'Test', author: 'Unknown', publisher: '' });
  assert(unknown >= 1.0 && unknown <= 2.0, `Unknown format scores low (${unknown})`);

  // 2e. Small file penalty (<100KB)
  const small = calculateQualityScore({ format: 'EPUB', size: '50 KB', title: 'Test', author: 'Unknown', publisher: '' });
  const normal = calculateQualityScore({ format: 'EPUB', size: '5 MB', title: 'Test', author: 'Unknown', publisher: '' });
  assert(small < normal, `Small file (<100KB) gets penalty: ${small} < ${normal}`);

  // 2f. Medium file penalty (100-500KB)
  const medium = calculateQualityScore({ format: 'EPUB', size: '300 KB', title: 'Test', author: 'Unknown', publisher: '' });
  assert(medium < normal, `Medium file (300KB) gets penalty: ${medium} < ${normal}`);
  assert(medium > small, `Medium file less penalty than tiny: ${medium} > ${small}`);

  // 2g. Good metadata bonus (use a lower base format so the bonus is visible before hitting cap)
  const withMeta = calculateQualityScore({ format: 'MOBI', size: '5 MB', title: 'Title', author: 'Author', publisher: 'Publisher' });
  const noMeta = calculateQualityScore({ format: 'MOBI', size: '5 MB', title: 'Title', author: 'Unknown', publisher: '' });
  assert(withMeta > noMeta, `Good metadata gets bonus: ${withMeta} > ${noMeta}`);

  // 2h. Recent edition bonus
  const recent = calculateQualityScore({ format: 'EPUB', size: '5 MB', title: 'Title', author: 'Author', publisher: 'Penguin, 2023' });
  const old = calculateQualityScore({ format: 'EPUB', size: '5 MB', title: 'Title', author: 'Author', publisher: 'Penguin, 1990' });
  assert(recent >= old, `Recent edition (2023) gets bonus: ${recent} ≥ ${old}`);

  // 2i. Score bounds (1-5)
  // Try to create an extremely bad result
  const worst = calculateQualityScore({ format: 'TXT', size: '1 KB', title: '', author: 'Unknown', publisher: '' });
  assert(worst >= 1.0, `Score never below 1.0 (${worst})`);

  // Try to create an extremely good result
  const best = calculateQualityScore({ format: 'EPUB', size: '50 MB', title: 'Title', author: 'Author', publisher: 'Penguin 2024' });
  assert(best <= 5.0, `Score never above 5.0 (${best})`);

  // 2j. Score is rounded to nearest 0.5
  const score = calculateQualityScore({ format: 'EPUB', size: '1 MB', title: 'T', author: 'A', publisher: 'P' });
  assertEqual(score % 0.5, 0, `Score ${score} is rounded to nearest 0.5`);

  // 2k. No size info → no penalty
  const noSize = calculateQualityScore({ format: 'EPUB', size: '', title: 'Title', author: 'Unknown', publisher: '' });
  assertEqual(noSize, normal, `No size info → same as normal (${noSize} = ${normal})`);

  // 2l. EPUB > MOBI > PDF ordering
  const epubScore = calculateQualityScore({ format: 'EPUB', size: '5 MB', title: 'T', author: 'Unknown', publisher: '' });
  const mobiScore = calculateQualityScore({ format: 'MOBI', size: '5 MB', title: 'T', author: 'Unknown', publisher: '' });
  const pdfScore = calculateQualityScore({ format: 'PDF', size: '5 MB', title: 'T', author: 'Unknown', publisher: '' });
  assert(epubScore >= mobiScore, `EPUB ≥ MOBI: ${epubScore} ≥ ${mobiScore}`);
  assert(mobiScore >= pdfScore, `MOBI ≥ PDF: ${mobiScore} ≥ ${pdfScore}`);
})();

// ─── 3. parseSizeToBytes Tests ───────────────────────────────────────────────

section('3. parseSizeToBytes');

(() => {
  assertEqual(parseSizeToBytes('1 KB'), 1024, '1 KB = 1024 bytes');
  assertEqual(parseSizeToBytes('1 MB'), 1024 * 1024, '1 MB');
  assertEqual(parseSizeToBytes('1 GB'), 1024 * 1024 * 1024, '1 GB');
  assertEqual(parseSizeToBytes('5.5 MB'), 5.5 * 1024 * 1024, '5.5 MB');
  assertEqual(parseSizeToBytes(''), 0, 'Empty string → 0');
  assertEqual(parseSizeToBytes(null), 0, 'null → 0');
  assertEqual(parseSizeToBytes(undefined), 0, 'undefined → 0');
  assertEqual(parseSizeToBytes('500KB'), 500 * 1024, '500KB (no space)');
  assertEqual(parseSizeToBytes('1.8MB'), 1.8 * 1024 * 1024, '1.8MB (no space)');
  assertEqual(parseSizeToBytes('no-match'), 0, 'Non-matching string → 0');
})();

// ─── 4. parseAnnasResults Tests ──────────────────────────────────────────────

section('4. parseAnnasResults');

assertEqual(serverTestHooks.annasBrowserSearchPermitted({}), false,
  'Anna browser search is disabled by default');
assertEqual(serverTestHooks.annasBrowserSearchPermitted({ ANNAS_BROWSER_SEARCH_MODE: 'permitted' }), true,
  'Anna browser search requires the explicit permitted mode');
assertEqual(serverTestHooks.annasBrowserSearchPermitted({ ANNAS_BROWSER_SEARCH_MODE: 'true' }), false,
  'Anna browser search rejects ambiguous truthy settings');
assertEqual(serverTestHooks.annasSearchTimeoutMs({}), 20000,
  'Anna primary search gets enough time to finish its CLI deadline');
assertEqual(serverTestHooks.annasSearchTimeoutMs({ ANNAS_BROWSER_SEARCH_MODE: 'permitted' }), 75000,
  'permitted browser fallback receives an end-to-end provider budget');
assertEqual(serverTestHooks.annasSearchTimeoutMs({ ANNAS_SEARCH_TIMEOUT_MS: '90000' }), 90000,
  'Anna search timeout accepts a bounded operator override');
assertDeep(serverTestHooks.annasMcpSearchArgs('Moby Dick'), ['book-search', 'Moby Dick'],
  'Anna search uses the current annas-mcp book-search command');
const annasCliEnv = serverTestHooks.buildAnnasCliEnv(
  { secretKey: 'synthetic-test-key' },
  { ANNAS_BASE_URL: 'https://stale.example', SAFE_VALUE: 'retained' }
);
assert(!Object.hasOwn(annasCliEnv, 'ANNAS_BASE_URL'),
  'Anna CLI search leaves mirror selection to its automatic discovery');
assertEqual(annasCliEnv.SAFE_VALUE, 'retained', 'Anna CLI search preserves unrelated environment values');
assertEqual(serverTestHooks.annasMcpExecutable({}, {
  homeDir: '/Users/reader',
  existsSync: candidate => candidate === '/Users/reader/.local/bin/annas-mcp'
}), '/Users/reader/.local/bin/annas-mcp',
'Anna search finds a user-local CLI when a service PATH omits it');
assertEqual(serverTestHooks.annasMcpExecutable({ ANNAS_MCP_BIN: '/srv/bin/annas-mcp' }, {
  homeDir: '/Users/reader', existsSync: () => false
}), '/srv/bin/annas-mcp', 'Anna search honors an explicit CLI path');

(() => {
  // 4a. Single result
  const single = parseAnnasResults(
    `Book 1:
Title: The Great Gatsby
Authors: F. Scott Fitzgerald
Publisher: Scribner, 2004
Language: en
Format: epub
Size: 1.5 MB
URL: https://annas-archive.li/md5/abc123
Hash: abc123def456`
  );
  assertEqual(single.length, 1, 'Single result parsed');
  assertEqual(single[0].title, 'The Great Gatsby', 'Title extracted');
  assertEqual(single[0].author, 'F. Scott Fitzgerald', 'Author extracted');
  assertEqual(single[0].format, 'EPUB', 'Format normalized to uppercase');
  assertEqual(single[0].size, '1.5 MB', 'Size extracted');
  assertEqual(single[0].hash, 'abc123def456', 'Hash extracted');
  assertEqual(single[0].publisher, 'Scribner, 2004', 'Publisher extracted');
  assertEqual(single[0].language, 'en', 'Language extracted');

  // 4b. Multiple results
  const multi = parseAnnasResults(
    `Book 1:
Title: Dune
Authors: Frank Herbert
Publisher: Penguin
Format: epub
Size: 2 MB
Hash: hash1

Book 2:
Title: Dune Messiah
Authors: Frank Herbert
Publisher: Ace
Format: pdf
Size: 5 MB
Hash: hash2

Book 3:
Title: Children of Dune
Authors: Frank Herbert
Publisher: Penguin
Format: mobi
Size: 1.5 MB
Hash: hash3`
  );
  assertEqual(multi.length, 3, 'Multiple results parsed');
  assertEqual(multi[0].title, 'Dune', 'First result correct');
  
  // 4c. Empty input
  const empty = parseAnnasResults('');
  assertEqual(empty.length, 0, 'Empty input → empty array');

  // 4d. Malformed input (missing hash)
  const noHash = parseAnnasResults(`Book 1:\nTitle: Test Book\nAuthors: Nobody`);
  assertEqual(noHash.length, 0, 'Result without hash is skipped');

  // 4e. Results sorted by format priority (EPUB first)
  const sorted = parseAnnasResults(
    `Book 1:
Title: Book A
Authors: Auth
Format: pdf
Size: 5 MB
Hash: hash1

Book 2:
Title: Book B
Authors: Auth
Format: epub
Size: 2 MB
Hash: hash2

Book 3:
Title: Book C
Authors: Auth
Format: mobi
Size: 3 MB
Hash: hash3`
  );
  assertEqual(sorted[0].format, 'EPUB', 'EPUB sorted first');
  assertEqual(sorted[1].format, 'MOBI', 'MOBI sorted second');
  assertEqual(sorted[2].format, 'PDF', 'PDF sorted after EPUB/MOBI');

  // 4f. Small files (<100KB) are filtered out
  const withSmall = parseAnnasResults(
    `Book 1:
Title: Tiny Book
Authors: Auth
Format: epub
Size: 50 KB
Hash: tinyHash

Book 2:
Title: Normal Book
Authors: Auth
Format: epub
Size: 2 MB
Hash: normalHash`
  );
  assertEqual(withSmall.length, 1, 'Tiny file (<100KB) filtered out');
  assertEqual(withSmall[0].hash, 'normalHash', 'Normal-sized file kept');

  // 4g. Files with no size info are kept
  const noSize = parseAnnasResults(
    `Book 1:
Title: No Size Book
Authors: Auth
Format: epub
Hash: noSizeHash`
  );
  assertEqual(noSize.length, 1, 'File with no size info kept');

  // 4h. Default format when not specified
  const noFormat = parseAnnasResults(
    `Book 1:
Title: Default Format
Authors: Auth
Hash: defHash`
  );
  assertEqual(noFormat[0].format, 'EPUB', 'Default format is EPUB');

  // 4i. Default author when not specified
  const noAuthor = parseAnnasResults(
    `Book 1:
Title: No Author Book
Format: epub
Size: 1 MB
Hash: noAuthHash`
  );
  assertEqual(noAuthor[0].author, 'Unknown', 'Default author is Unknown');
})();

// ─── 5. normalizeTitle Tests ─────────────────────────────────────────────────

section('5. normalizeTitle');

(() => {
  assertEqual(normalizeTitle('The Great Gatsby'), 'the great gatsby', 'Simple lowercase');
  assertEqual(normalizeTitle('On the Road (Original Scroll)'), 'on the road', 'Strip parentheticals');
  assertEqual(normalizeTitle('Dune: The Machine Crusade'), 'dune', 'Strip subtitle after colon');
  assertEqual(normalizeTitle('1984 [Penguin Edition]'), '1984', 'Strip brackets');
  assertEqual(normalizeTitle('  The   Hobbit  '), 'the hobbit', 'Trim and collapse whitespace');
  assertEqual(normalizeTitle(''), '', 'Empty string');
  assertEqual(normalizeTitle(null), '', 'null input');
  assertEqual(normalizeTitle(undefined), '', 'undefined input');
  
  // Punctuation removal
  assertEqual(normalizeTitle("Harry Potter & the Sorcerer's Stone"), 'harry potter the sorcerers stone', 'Remove punctuation');
  
  // Multiple transformations
  assertEqual(normalizeTitle('The Lord of the Rings: The Fellowship (Extended) [Deluxe]'),
    'the lord of the rings', 'Multiple transformations combined');
})();

// ─── 6. extractYear Tests ────────────────────────────────────────────────────

section('6. extractYear');

(() => {
  assertEqual(extractYear('Penguin, 2023'), 2023, 'Extract year 2023');
  assertEqual(extractYear('Scribner 1990'), 1990, 'Extract year 1990');
  assertEqual(extractYear('No year here'), null, 'No year → null');
  assertEqual(extractYear(null), null, 'null → null');
  assertEqual(extractYear(''), null, 'Empty → null');
  assertEqual(extractYear('Published 2007 by Ace'), 2007, 'Year in middle of string');
  assertEqual(extractYear('1899 edition'), null, 'Year before 1900 not matched');
})();

// ─── 7. selectBestResult Tests ───────────────────────────────────────────────

section('7. selectBestResult');

(() => {
  // 7a. Empty array
  assertEqual(selectBestResult([]), null, 'Empty array → null');
  assertEqual(selectBestResult(null), null, 'null → null');

  // 7b. Single result
  const single = selectBestResult([
    { title: 'Test', author: 'Auth', format: 'EPUB', size: '5 MB', publisher: '' }
  ]);
  assertEqual(single.title, 'Test', 'Single result returned');

  // 7c. EPUB preferred over PDF
  const best = selectBestResult([
    { title: 'Book', author: 'Auth', format: 'PDF', size: '10 MB', publisher: '' },
    { title: 'Book', author: 'Auth', format: 'EPUB', size: '5 MB', publisher: '' },
  ]);
  assertEqual(best.format, 'EPUB', 'EPUB preferred over PDF');

  // 7d. Larger file wins as tiebreaker
  const larger = selectBestResult([
    { title: 'Book', author: 'Auth', format: 'EPUB', size: '1 MB', publisher: '' },
    { title: 'Book', author: 'Auth', format: 'EPUB', size: '5 MB', publisher: '' },
  ]);
  assertEqual(larger.size, '5 MB', 'Larger file preferred as tiebreaker');
})();

// ─── 8. shouldFilterChapter Tests ────────────────────────────────────────────

section('8. shouldFilterChapter');

(() => {
  // 8a. Short chapters (<300 chars) are filtered
  assert(shouldFilterChapter({ title: 'Some Section', text: 'Short.' }),
    'Very short chapter (<300 chars) filtered');

  // 8b. Short numbered chapters are kept
  assert(!shouldFilterChapter({ title: 'Chapter 1', text: 'Short.' }),
    'Short numbered chapter "Chapter 1" kept');

  assert(isChapterLikeTitle('2 Origins II: George W. Hayduke'),
    'Numbered prose titles are chapter-like');
  assertEqual(
    normalizeChapterType({
      title: '2 Origins II: George W. Hayduke',
      type: 'frontmatter',
      text: 'Copyright\nThe Monkey Wrench Gang\nCopyright © 1975'
    }).title,
    'Copyright',
    'Chapter-like stale titles are repaired from frontmatter text'
  );
  assertEqual(
    normalizeChapterType({
      title: '8 Hayduke and Smith at Play',
      type: 'content',
      text: '1\nOrigins I: A. K. Sarvis, M.D.\nDr. Sarvis with his bald mottled dome...'
    }).title,
    '1 Origins I: A. K. Sarvis, M.D.',
    'Shifted content titles are repaired from numbered text headings'
  );
  assertEqual(
    normalizeChapterType({
      title: '7 Hayduke’s Night March',
      type: 'content',
      text: 'PROLOGUE\nThe Aftermath\n' + 'Narrative prose. '.repeat(80)
    }).type,
    'content',
    'Substantial shifted prologue text remains reader content'
  );

  // 8c. Copyright chapter filtered
  assert(shouldFilterChapter({ title: 'Copyright', text: '© 2023 All rights reserved. '.repeat(20) }),
    'Copyright chapter filtered');

  // 8d. Cover chapter filtered
  assert(shouldFilterChapter({ title: 'Cover', text: 'Cover image. '.repeat(5) }),
    'Cover chapter filtered');

  // 8e. Table of Contents filtered
  assert(shouldFilterChapter({ title: 'Table of Contents', text: 'Chapter 1... Chapter 2... '.repeat(10) }),
    'Table of Contents filtered');

  // 8f. About the Author filtered (short)
  assert(shouldFilterChapter({ title: 'About the Author', text: 'John was born in 1950. He lives in New York. '.repeat(20) }),
    'About the Author filtered');

  // 8g. About the Author with substantial content kept
  assert(!shouldFilterChapter({ title: 'About the Author', text: 'A'.repeat(6000) }),
    'About the Author with >5000 chars kept');

  // 8h. Normal chapter kept
  assert(!shouldFilterChapter({ title: 'The Journey Begins', text: 'A'.repeat(5000) }),
    'Normal chapter with content kept');

  // 8i. Bio-like content detected
  assert(shouldFilterChapter({ 
    title: 'Notes', 
    text: 'John was born in 1950. He is the author of many books. © 2023 All rights reserved. ISBN 978-0-123456-78-9' 
  }), 'Bio/copyright content detected and filtered');

  // 8j. Dedication filtered
  assert(shouldFilterChapter({ title: 'Dedication', text: 'To my family. '.repeat(10) }),
    'Dedication filtered');

  // 8k. Also By filtered
  assert(shouldFilterChapter({ title: 'Also By Author Name', text: 'Book list. '.repeat(5) }),
    'Also By filtered');

  // 8l. Book divider (all caps, short) filtered
  assert(shouldFilterChapter({ title: 'BOOK ONE', text: 'X' }),
    'All-caps book divider filtered');

  // 8m. "Part One" divider filtered
  assert(shouldFilterChapter({ title: 'Part One', text: 'Short content.' }),
    'Part divider filtered');
})();

// ─── 9. Search Relevance Scoring (Integration) ──────────────────────────────

section('9. Search relevance scoring');

assertEqual(serverTestHooks.normalizeSearchLanguage('English'), 'en', 'Search language normalization maps full English name to en');
assertEqual(serverTestHooks.normalizeSearchLanguage('Italian'), 'it', 'Search language normalization maps full Italian name to it');
assertEqual(serverTestHooks.normalizeSearchLanguage('English [en]'), 'en', 'Search language normalization accepts bracketed language codes');

(() => {
  // Simulate the scoring logic from the search handler
  function scoreResult(query, result) {
    const queryLower = query.toLowerCase();
    const queryNorm = normalizeTitle(query);
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
    
    let relevanceScore = 0;
    const titleLower = (result.title || '').toLowerCase();
    const titleNorm = normalizeTitle(result.title);
    const authorLower = (result.author || '').toLowerCase();
    
    if (titleNorm === queryNorm) {
      relevanceScore += 200;
    } else if (titleNorm.includes(queryNorm)) {
      relevanceScore += 150;
    } else if (titleLower.includes(queryLower)) {
      relevanceScore += 100;
    }
    
    const titleWords = titleNorm.split(/\s+/);
    const matchingWords = queryWords.filter(qw => 
      titleWords.some(tw => tw === qw || tw.startsWith(qw))
    );
    const wordMatchRatio = queryWords.length > 0 ? matchingWords.length / queryWords.length : 0;
    relevanceScore += Math.round(wordMatchRatio * 80);
    
    const authorWords = authorLower.split(/[\s,]+/);
    const authorMatch = queryWords.some(qw => authorWords.some(aw => aw === qw));
    if (authorMatch) {
      relevanceScore += 40;
    }
    
    if (titleNorm.length > queryNorm.length * 3) {
      relevanceScore -= 10;
    }
    
    return relevanceScore;
  }

  // 9a. Exact title match scores highest
  const exactScore = scoreResult('Dune', { title: 'Dune', author: 'Frank Herbert' });
  const containsScore = scoreResult('Dune', { title: 'Dune Messiah', author: 'Frank Herbert' });
  const partialScore = scoreResult('Dune', { title: 'Children of Dune: The Complete Story', author: 'Frank Herbert' });
  const noMatchScore = scoreResult('Dune', { title: 'The Hobbit', author: 'Tolkien' });

  assert(exactScore > containsScore, `Exact match (${exactScore}) > contains (${containsScore})`);
  assert(containsScore > noMatchScore, `Contains (${containsScore}) > no match (${noMatchScore})`);

  // 9b. Author match adds bonus
  const withAuthor = scoreResult('Herbert', { title: 'Dune', author: 'Frank Herbert' });
  const noAuthor = scoreResult('Herbert', { title: 'Dune', author: 'Other Person' });
  assert(withAuthor > noAuthor, `Author match (${withAuthor}) > no author match (${noAuthor})`);

  // 9c. Word-level matching is proportional
  const allWords = scoreResult('lord of the rings', { title: 'The Lord of the Rings', author: '' });
  const someWords = scoreResult('lord of the rings', { title: 'Lord of War', author: '' });
  assert(allWords > someWords, `All words match (${allWords}) > partial match (${someWords})`);

  // 9d. Long titles get penalty
  const short = scoreResult('Dune', { title: 'Dune', author: '' });
  const long = scoreResult('Dune', { 
    title: 'Dune: The Amazing Extended Director\'s Cut Special Anniversary Collector\'s Edition', 
    author: '' 
  });
  // Both should contain 'dune' but the long one might get a penalty
  assert(short >= long, `Short title (${short}) ≥ long title (${long})`);

  // 9e. Case insensitivity
  const lower = scoreResult('dune', { title: 'Dune', author: '' });
  const upper = scoreResult('DUNE', { title: 'Dune', author: '' });
  assertEqual(lower, upper, `Case insensitive: ${lower} = ${upper}`);

  // 9f. Normalized matching ignores subtitles
  const withSubtitle = scoreResult('Dune', { title: 'Dune: Deluxe Edition', author: '' });
  // normalizeTitle strips ": Deluxe Edition", so it becomes "dune" = exact match
  assert(withSubtitle >= 200, `Subtitle stripped for matching (${withSubtitle} ≥ 200)`);
})();

// ─── 10. Identifier and Range Validation ────────────────────────────────────

section('10. Identifier and range validation');

(() => {
  assert(isSafeBookId('abc123'), 'Alphanumeric book id accepted');
  assert(isSafeBookId('pg-123_hash'), 'Hyphen/underscore book id accepted');
  assert(!isSafeBookId('../outside'), 'Path traversal book id rejected');
  assert(!isSafeBookId(''), 'Empty book id rejected');

  assertDeep(parseAudioRange('bytes=0-99', 1000), { start: 0, end: 99 }, 'Explicit byte range parsed');
  assertDeep(parseAudioRange('bytes=900-', 1000), { start: 900, end: 999 }, 'Open-ended byte range parsed');
  assertDeep(parseAudioRange('bytes=-100', 1000), { start: 900, end: 999 }, 'Suffix byte range parsed');
  assert(parseAudioRange('bytes=1000-', 1000).invalid, 'Out-of-bounds byte range rejected');
  assert(parseAudioRange('bytes=abc-def', 1000).invalid, 'Malformed byte range rejected');
})();

// ─── 11. Extracted Chapter Validation ───────────────────────────────────────

section('11. Extracted chapter validation');

(() => {
  const substantialChapters = Array.from({ length: 5 }, (_, index) => ({
    title: `Chapter ${index + 1}`,
    text: 'x'.repeat(12000)
  }));

  const validation = validateExtractedChapters(substantialChapters, {
    format: 'pdf',
    fileSize: 2 * 1024 * 1024
  });
  assert(validation.valid, 'Substantial extracted chapters validate');
  assertEqual(validation.errors.length, 0, 'Valid extracted chapters have no errors');

  const tinyValidation = validateExtractedChapters([{ title: 'Short', text: 'too short' }], {
    format: 'mobi',
    fileSize: 1024
  });
  assert(!tinyValidation.valid, 'Insufficient extracted text is rejected');
  assert(tinyValidation.errors[0].includes('Insufficient content'), 'Insufficient content error is reported');

  const sparseValidation = validateExtractedChapters([
    { title: 'Chapter 1', text: 'x'.repeat(60000) },
    { title: 'Divider', text: 'short' },
    { title: 'Divider 2', text: 'short' }
  ], {
    format: 'pdf',
    fileSize: 60 * 1024 * 1024
  });
  assert(sparseValidation.valid, 'Sparse but sufficient extracted text can still validate');
  assert(sparseValidation.warnings.some(w => w.includes('Large PDF file')), 'Large source warning is preserved');
  assert(sparseValidation.warnings.some(w => w.includes('sections are empty or very short')), 'Sparse section warning is reported');

  const quality = buildChapterQuality(substantialChapters, 2);
  assert(quality.isGoodStructure, 'Normal extracted chapters have good structure');
  assertEqual(quality.contentChapters, 5, 'Quality counts content chapters');

  const giantQuality = buildChapterQuality([{ title: 'Whole Book', text: 'x'.repeat(120000) }], 0);
  assert(!giantQuality.isGoodStructure, 'Giant single chapter is marked poor structure');
  assert(giantQuality.reasons.some(r => r.includes('Giant chapter')), 'Giant chapter reason is reported');

  const repairedChapters = splitOversizedChapters([{
    index: 0,
    title: 'Whole Book',
    text: 'A complete sentence. '.repeat(12000),
    type: 'content'
  }]);
  const repairedQuality = buildChapterQuality(repairedChapters, 0);
  const repairedValidation = validateExtractedChapters(repairedChapters, { format: 'epub' });
  assert(repairedChapters.length >= 3, 'Oversized source section becomes several audiobook chapters');
  assert(repairedQuality.isGoodStructure, 'Repaired oversized section passes chapter quality');
  assert(repairedValidation.valid, 'Repaired oversized section passes extracted-content validation');
  assert(repairedValidation.warnings.some(warning => warning.includes('Split 1 oversized source section')), 'Repair is reported as a validation warning');
})();

// ─── 12. Preferred Audio Start Chapter ──────────────────────────────────────

section('12. Preferred audio start chapter');

(() => {
  assert(isChapterOneTitle('Chapter 1'), 'Chapter 1 title detected');
  assert(isChapterOneTitle('Chapter One'), 'Chapter One title detected');
  assert(isChapterOneTitle('Chapter I'), 'Chapter I title detected');
  assert(isChapterOneTitle('1. The Beginning'), 'Numbered chapter title detected');
  assert(isChapterOneTitle('I: The Beginning'), 'Roman numeral chapter title detected');
  assert(!isChapterOneTitle('Part One'), 'Part One is not treated as Chapter 1');
  assert(!isChapterOneTitle('Author Note'), 'Author note is not treated as Chapter 1');
  assertEqual(
    normalizeChapterTitleForDisplay('Chapter 1 It was the best of times. It was the worst of times. The first sentence leaked into the title.'),
    'Chapter 1',
    'Long Chapter 1 title is trimmed before first sentence'
  );
  assertEqual(
    normalizeChapterTitleForDisplay('I. Loomings. Call me Ishmael. Some years ago never mind how long precisely.'),
    'I. Loomings',
    'Roman numeral chapter title preserves real subtitle'
  );
  assertEqual(
    normalizeChapterTitleForDisplay('Chapter 1 The Boy Who Lived. Mr and Mrs Dursley, of number four, Privet Drive, were proud to say.'),
    'Chapter 1 The Boy Who Lived',
    'Chapter title preserves short real subtitle before body prose'
  );
  assertEqual(
    normalizeChapterTitleForDisplay('Chapter 2: A Window Opens'),
    'Chapter 2 A Window Opens',
    'Chapter title preserves colon subtitle'
  );
  assertEqual(
    normalizeChapterTitleForDisplay('1 Origins I: A. K. Sarvis, M.D.'),
    '1 Origins I: A. K. Sarvis, M.D.',
    'Numbered chapter title preserves initials in subtitle'
  );
  assertEqual(
    normalizeChapterTitleForDisplay('2 Origins II: George W. Hayduke'),
    '2 Origins II: George W. Hayduke',
    'Numbered chapter title preserves middle initial'
  );
  assertEqual(
    normalizeChapterTitleForDisplay('Son of Man vs. Son of God'),
    'Son of Man vs. Son of God',
    'Chapter titles are not truncated at the vs. abbreviation'
  );
  assertEqual(
    normalizeChapterTitleForDisplay("Part Two : Gemstones in Christ's Teachings"),
    "Part Two: Gemstones in Christ's Teachings",
    'Chapter titles remove stray spaces before punctuation'
  );
  assert(normalizeChapterTitleForDisplay('A very long section title with no useful break '.repeat(4)).length <= 80,
    'Runaway titles are capped for player display');

  const chapters = [
    { title: 'Epigraph', type: 'content', text: 'x'.repeat(900) },
    { title: "Author's Note", type: 'frontmatter', text: 'x'.repeat(2000) },
    { title: 'Introduction', type: 'content', text: 'x'.repeat(5000) },
    { title: 'Chapter One', type: 'content', text: 'x'.repeat(1000) },
    { title: 'Chapter Two', type: 'chapter', text: 'x'.repeat(1000) }
  ];
  assertEqual(findPreferredAudioStartChapterIndex(chapters), 3, 'Preload starts at Chapter One before frontmatter/content');

  const prologueBeforeChapterOne = [
    { title: 'Copyright', type: 'frontmatter', text: 'x'.repeat(1200) },
    { title: 'PROLOGUE: The Aftermath', type: 'content', text: 'x'.repeat(1200) },
    { title: '1 Origins I: A. K. Sarvis, M.D.', type: 'chapter', text: 'x'.repeat(1200) }
  ];
  assertEqual(findPreferredAudioStartChapterIndex(prologueBeforeChapterOne), 1, 'Substantial prologue before Chapter 1 is the preferred start');

  const romanChapters = [
    { title: 'Preface', type: 'content', text: 'x'.repeat(1200) },
    { title: 'I. Loomings', type: 'content', text: 'x'.repeat(1200) }
  ];
  assertEqual(findPreferredAudioStartChapterIndex(romanChapters), 1, 'Roman numeral Chapter I variant is preferred');

  const noChapterOne = [
    { title: 'Dedication', type: 'frontmatter', text: 'x'.repeat(1200) },
    { title: 'The Road', type: 'content', text: 'x'.repeat(1200) }
  ];
  assertEqual(findPreferredAudioStartChapterIndex(noChapterOne), 1, 'Falls back to first substantial content when no Chapter 1 title exists');

  const lateGenericChapter = [
    { title: 'Copyright', type: 'copyright', text: 'x'.repeat(1200) },
    { title: 'Introduction', type: 'content', text: 'x'.repeat(5000) },
    { title: 'Chapter 27', type: 'chapter', text: 'x'.repeat(2000) }
  ];
  assertEqual(findPreferredAudioStartChapterIndex(lateGenericChapter), 1,
    'Preload does not jump past real content to a late generic chapter title');

  const repairedSections = normalizeChapterSequence([
    { title: 'Foreword', type: 'frontmatter', text: 'Revelations of Christ\nProclaimed by Paramhansa Yogananda\nCrystal Clarity Publishers', kindleExtractor: 'kf8', sourceHref: 'wrong-1' },
    { title: 'Introduction', type: 'frontmatter', text: 'Copyright 2010 by Hansa Trust\nAll rights reserved\nISBN 978-1-56589-240-8', kindleExtractor: 'kf8', sourceHref: 'wrong-2' },
    { title: 'Part One', type: 'frontmatter', text: 'Dedicated to those sincere Christians whose faith has been shaken', kindleExtractor: 'kf8', sourceHref: 'wrong-3' },
    { title: 'Major Disadvantages', type: 'content', text: 'Foreword\nIntroduction\n1. Major Disadvantages\n2. A Name for Truth\n3. The Purpose of Religion', kindleExtractor: 'kf8', sourceHref: 'wrong-4' },
    { title: 'Chapter 27', type: 'chapter', text: '“A leading light.”\n—Lama Surya Das\nSwami Kriyananda\nA prolific author and direct disciple who founded communities.', kindleExtractor: 'kf8' },
    { title: 'Further Explorations', type: 'content', text: 'Further Explorations\nContact Information:\nonline: example.org\nemail: books@example.org', kindleExtractor: 'kf8' }
  ]);
  assertEqual(repairedSections.slice(0, 4).map(chapter => chapter.title).join('|'),
    'Title Page|Copyright|Dedication|Contents', 'Repairs shifted structural section titles from their text');
  assertEqual(repairedSections[4].title, 'About Swami Kriyananda', 'Repairs a generic author-bio title');
  assert(repairedSections.slice(4).every(chapter => chapter.type === 'backmatter' || chapter.type === 'author'),
    'Trailing author and promotional sections are non-narrative back matter');

  const trustedTocChapter = normalizeChapterSequence([{
    title: '1 - The Thinker & The Prover',
    type: 'content',
    fromToc: true,
    text: 'WARNING\nA short editorial warning.\n\nCHAPTER ONE\nTHE THINKER & THE PROVER\n' + 'x'.repeat(1200)
  }])[0];
  assertEqual(trustedTocChapter.title, '1 - The Thinker & The Prover',
    'Trusted EPUB TOC title survives a short heading prepended to chapter text');
  assertEqual(trustedTocChapter.type, 'chapter',
    'Numbered EPUB TOC entry is classified as a chapter');

  const prefatorySequence = normalizeChapterSequence([
    { title: 'Preface To The Second Edition', type: 'content', text: 'x'.repeat(1200) },
    { title: '1 - The Thinker & The Prover', type: 'content', fromToc: true, text: 'CHAPTER ONE\n' + 'x'.repeat(1200) }
  ]);
  assertEqual(prefatorySequence[0].type, 'frontmatter',
    'Preface before the first authored chapter is classified as front matter');
})();

// ─── 13. Metadata Seed Cleanup ──────────────────────────────────────────────

section('13. Metadata seed cleanup');

(() => {
  const hash = '5ad3364e164db174680b270182cf1fd0';
  assert(isGarbageTitle(hash), 'MD5 hashes are treated as garbage titles');
  assert(isGarbageTitle('T H E'), 'Spaced letter fragments are treated as garbage titles');
  assertEqual(normalizeAuthorForDisplay('Yogananda, Paramhansa'), 'Paramhansa Yogananda',
    'Catalog-order embedded author names are normalized for display');

  const seed = resolveMetadataSeed(
    { title: 'Desert Solitaire', author: 'Edward Abbey' },
    hash,
    'Edward Abbey',
    `${hash}.epub`
  );
  assertEqual(seed.title, 'Desert Solitaire', 'Embedded title wins over hash filename');
  assert(!seed.embeddedLooksWrong, 'Hash filename does not mark embedded title as mismatched');

  const mismatched = resolveMetadataSeed(
    { title: 'Essay on Man', author: 'Alexander Pope' },
    'The Left Hand of Darkness',
    'Ursula K. Le Guin',
    '6dee27a11fca76c4b628c33e45c696e0.pdf'
  );
  assertEqual(mismatched.title, 'The Left Hand of Darkness', 'Selected search title wins over unrelated embedded metadata');
  assertEqual(mismatched.author, 'Ursula K. Le Guin', 'Selected search author wins when embedded title is unrelated');
  assert(mismatched.embeddedLooksWrong, 'Unrelated embedded metadata is marked mismatched');

  assertEqual(serverTestHooks.publishedYearFromMetadata('2024-03-10', 1999), 2024, 'Metadata date extracts published year');
  assertEqual(serverTestHooks.publishedYearFromMetadata('not a date', 1999), 1999, 'Invalid metadata date uses fallback year');
  assertEqual(serverTestHooks.publishedYearFromMetadata('', 2001), 2001, 'Missing metadata date uses fallback year');
})();

// ─── 14. PDF Extraction Guardrails ──────────────────────────────────────────

section('14. PDF extraction guardrails');

(() => {
  const badBare = serverTestHooks.validatePdfChapterGuess([
    { title: 'chapter', text: 'x'.repeat(200000) },
    { title: 'chapter 23', text: 'x'.repeat(1000) },
    { title: 'chapter 16', text: 'x'.repeat(1000) }
  ]);
  assert(!badBare.valid, 'PDF bare chapter/giant section guess is rejected');

  const badOrder = serverTestHooks.validatePdfChapterGuess([
    { title: 'Chapter 23', text: 'x'.repeat(1000) },
    { title: 'Chapter 16', text: 'x'.repeat(1000) }
  ]);
  assert(!badOrder.valid, 'PDF out-of-order chapter numbers are rejected');

  const grouped = serverTestHooks.buildPdfPageGroups([
    { pageNumber: 1, text: 'a'.repeat(9000) },
    { pageNumber: 2, text: 'b'.repeat(9000) },
    { pageNumber: 3, text: 'c'.repeat(9000) }
  ], { targetChars: 10000, maxChars: 20000 });
  assertEqual(grouped[0].title, 'Pages 1-2', 'PDF fallback groups pages by character budget');
  assertEqual(grouped[1].title, 'Page 3', 'PDF fallback preserves page order');
  assertEqual(grouped[0].type, 'pdf-page-group', 'PDF fallback marks page-group extraction');

  const normalized = normalizePdfPages([
    { pageNumber: 1, text: 'Book Title\n1\nconfigura-\ntion\nL O W W I N D O W\n' },
    { pageNumber: 2, text: 'Book Title\n2\nsoft\nwrapped line\n' },
    { pageNumber: 3, text: 'Book Title\n3\nmore text\n' }
  ]);
  assert(normalized.pages[0].text.includes('configuration'), 'PDF normalization joins hyphenated line wraps');
  assert(normalized.pages[0].text.includes('LOWWINDOW'), 'PDF normalization collapses spaced all-caps terms');
  assert(!normalized.pages.some(page => page.text.includes('Book Title')), 'PDF normalization removes repeated headers');
  assert(!normalized.pages.some(page => /^\d+$/.test(page.text)), 'PDF normalization removes standalone page numbers');
  assert(normalized.diagnostics.hyphenJoins >= 1, 'PDF normalization reports hyphen joins');
  assert(normalized.diagnostics.spacedCapsFixes >= 1, 'PDF normalization reports spaced caps fixes');
  assert(normalized.diagnostics.repeatedHeaderFooterLinesRemoved >= 3, 'PDF normalization reports repeated header removal');

  const paragraph = normalizePdfText('First line\ncontinues here\n\nSecond paragraph with ﬁne ﬂow.');
  assert(paragraph.text.includes('First line continues here'), 'PDF normalization collapses soft paragraph line breaks');
  assert(paragraph.text.includes('fine flow'), 'PDF normalization replaces ligatures');
  assert(paragraph.text.includes('\n\nSecond paragraph'), 'PDF normalization preserves paragraph breaks');
  assert(paragraph.diagnostics.paragraphLineJoins >= 1, 'PDF normalization reports paragraph joins');
  assert(paragraph.diagnostics.ligatureFixes >= 1, 'PDF normalization reports ligature fixes');

  const ocr = normalizePdfText('The sand 1s a little higher and th1s pattern rnay show sorne light frorn a window.');
  assert(ocr.text.includes('sand is a little higher'), 'PDF OCR repair fixes contextual 1s → is');
  assert(ocr.text.includes('this pattern may show some light from a window'), 'PDF OCR repair fixes allowlisted prose tokens');
  assert(ocr.diagnostics.ocrRepairsApplied >= 5, 'PDF OCR repair reports applied fixes');
  assert(ocr.diagnostics.ocrRepairExamples.length > 0, 'PDF OCR repair includes examples');

  const unsafeOcr = normalizePdfText('Model X1s and code A1s should not be changed.');
  assert(unsafeOcr.text.includes('X1s'), 'PDF OCR repair skips token-like model strings');
  assert(unsafeOcr.text.includes('A1s'), 'PDF OCR repair skips code-like strings');

  const cleanCandidate = {
    ok: true,
    name: 'clean',
    mode: 'pdftotext-normalized',
    chapters: [
      { title: 'Pages 1-2', text: 'This is clean readable prose with normal sentence flow. '.repeat(2000) }
    ]
  };
  const noisyCandidate = {
    ok: true,
    name: 'noisy',
    mode: 'pdf-parse-normalized',
    chapters: [
      { title: 'Pages 1-2', text: ('HARRY POTTER\n1s th1s hght rorLrer LQRRO_°oewe\n').repeat(3000) }
    ]
  };
  const cleanScore = serverTestHooks.scorePdfExtractionCandidate(cleanCandidate);
  const noisyScore = serverTestHooks.scorePdfExtractionCandidate(noisyCandidate);
  assert(cleanScore.score > noisyScore.score, 'PDF extraction scoring prefers clean readable text over noisy OCR text');
  const selected = serverTestHooks.selectPdfExtractionCandidate([noisyCandidate, cleanCandidate]);
  assertEqual(selected.selected.name, 'clean', 'PDF extraction selector picks the best-scored candidate');
})();

// ─── 15. Kokoro Tuning ──────────────────────────────────────────────────────

section('15. Kokoro tuning');

(() => {
  assertEqual(getKokoroChunkSize('kokoro:am_michael', 'quality'), 440, 'Kokoro quality profile uses voice-specific chunk size');
  assertEqual(getKokoroChunkSize('kokoro:am_michael', 'balanced'), 580, 'Kokoro balanced profile uses voice-specific chunk size');
  assertEqual(getKokoroChunkSize('kokoro:am_michael', 'fast'), 860, 'Kokoro fast profile uses voice-specific chunk size');

  const balancedKey = getKokoroVariantKey('kokoro:am_michael', { profile: 'balanced', format: 'mp3' });
  const qualityKey = getKokoroVariantKey('kokoro:am_michael', { profile: 'quality', format: 'mp3' });
  const wavKey = getKokoroVariantKey('kokoro:am_michael', { profile: 'balanced', format: 'wav' });
  assert(balancedKey.includes('profilebalanced'), 'Kokoro cache key includes profile');
  assert(balancedKey.includes('chunk580'), 'Kokoro cache key includes tuned chunk size');
  assert(balancedKey !== qualityKey, 'Kokoro cache key changes by profile');
  assert(balancedKey !== wavKey, 'Kokoro cache key changes by requested format');

  // Audio-processing pipeline tags: the audio version and paragraph pause are
  // baked into chunk audio, so both must scope the cache.
  const { AUDIO_PIPELINE_VERSION, NARRATION_PREP_VERSION } = require('../lib/tts-engine-profile');
  assert(balancedKey.includes(`:audio${AUDIO_PIPELINE_VERSION}`), 'variant key includes audio pipeline version');
  assert(balancedKey.includes(`:prep${NARRATION_PREP_VERSION}`), 'variant key includes narration preparation version');
  assert(balancedKey.includes(':br160k:'), 'variant key includes mastering bitrate');
  assert(balancedKey.includes(':outmp3:'), 'Kokoro cache key defaults to storage-efficient MP3 output');
  assert(/:pause\d+$/.test(balancedKey), 'variant key includes paragraph pause tag');
  const defaultKey = getKokoroVariantKey('kokoro:am_michael');
  assert(defaultKey.includes('profilequality'), 'Kokoro defaults to quality profile');
  assert(defaultKey.includes('chunk440'), 'Kokoro default quality profile uses tuned chunk size');
  assert(defaultKey.includes(':fmtwav'), 'default requested format is wav (single-encode path)');
  const prevKokoroOutput = process.env.KOKORO_TTS_OUTPUT_FORMAT;
  process.env.KOKORO_TTS_OUTPUT_FORMAT = 'wav';
  try {
    const wavOutputKey = getKokoroVariantKey('kokoro:am_michael', { profile: 'balanced', format: 'wav' });
    assert(wavOutputKey.includes(':outwav:'), 'Kokoro WAV output override scopes cache key');
  } finally {
    if (prevKokoroOutput === undefined) delete process.env.KOKORO_TTS_OUTPUT_FORMAT;
    else process.env.KOKORO_TTS_OUTPUT_FORMAT = prevKokoroOutput;
  }
  const prevPause = process.env.PARAGRAPH_PAUSE_MS;
  process.env.PARAGRAPH_PAUSE_MS = '0';
  try {
    const noPauseKey = getKokoroVariantKey('kokoro:am_michael', { profile: 'balanced', format: 'mp3' });
    assert(noPauseKey !== balancedKey, 'changing PARAGRAPH_PAUSE_MS changes the variant key');
    assert(noPauseKey.endsWith(':pause0'), 'pause tag reflects PARAGRAPH_PAUSE_MS');
  } finally {
    if (prevPause === undefined) delete process.env.PARAGRAPH_PAUSE_MS;
    else process.env.PARAGRAPH_PAUSE_MS = prevPause;
  }

  const prepared = prepareKokoroText('Chapter 1\nThe room was quiet ,and alive....  “ Hello ”');
  assert(prepared.text.includes('Chapter 1\n\nThe room'), 'Kokoro prep adds pause after short heading');
  assert(prepared.text.includes('quiet, and alive...'), 'Kokoro prep fixes punctuation spacing and repeated periods');
  assert(prepared.text.includes('“Hello”'), 'Kokoro prep fixes quote spacing');
  assert(prepared.diagnostics.headingPauseFixes >= 1, 'Kokoro prep reports heading pause fixes');
  assert(prepared.diagnostics.punctuationSpacingFixes >= 1, 'Kokoro prep reports punctuation spacing fixes');
})();

// ─── 16. Import Validation ──────────────────────────────────────────────────

section('16. Import validation');

(() => {
  const keyA = canonicalWorkKey('The Hobbit: or There and Back Again', 'J. R. R. Tolkien');
  const keyB = canonicalWorkKey('The Hobbit', 'J R R Tolkien');
  assertEqual(keyA, keyB, 'Canonical work key ignores subtitle and author punctuation');

  const duplicate = findDuplicateBook({
    a: { id: 'a', title: 'The Hobbit', author: 'J R R Tolkien', workKey: keyA }
  }, {
    id: 'b',
    title: 'The Hobbit: Or There and Back Again',
    author: 'J. R. R. Tolkien'
  });
  assertEqual(duplicate.id, 'a', 'Duplicate detection catches normalized title/author matches');

  const noisyContent = assessExtractedContent([
    { text: 'Readable text '.repeat(5000) },
    { text: 'x'.repeat(160000) }
  ], { format: 'pdf' });
  assert(!noisyContent.valid, 'Import content validation rejects giant extracted sections');

  const lowScorePdf = assessExtractedContent([
    {
      text: 'Readable text '.repeat(5000),
      pdfExtraction: { score: 40, warnings: ['low readable character ratio'] }
    }
  ], { format: 'pdf' });
  assert(!lowScorePdf.valid, 'Import content validation rejects low-score PDF extraction');

  const ocrRequiredPdf = assessExtractedContent([
    {
      text: 'Readable text '.repeat(5000),
      pdfExtraction: { status: 'ocr-required', score: 80, warnings: ['very low extracted text density'] }
    }
  ], { format: 'pdf' });
  assert(!ocrRequiredPdf.valid, 'Import content validation rejects OCR-required PDF extraction');

  const metadata = assessMetadataConfidence({
    selectedTitle: 'The Hobbit',
    embeddedTitle: 'A Brief History of Time',
    enrichedTitle: 'The Hobbit'
  });
  assert(metadata.needsReview, 'Metadata validation flags selected/embedded title conflicts');

  const olDuplicate = findDuplicateBook({
    a: { id: 'a', title: 'Different Local Title', author: 'Unknown', openLibraryWorkKey: '/works/OL123W' }
  }, {
    id: 'b',
    title: 'The Hobbit',
    author: 'J. R. R. Tolkien',
    openLibraryWorkKey: '/works/OL123W'
  });
  assertEqual(olDuplicate.id, 'a', 'Duplicate detection prefers Open Library work key matches');
})();

// ─── 17. Open Library Identity ───────────────────────────────────────────────

section('17. Open Library identity');

pendingAsyncTests.push((async () => {
  const exact = scoreOpenLibraryDoc({
    key: '/works/OL1W',
    title: 'The Hobbit',
    author_name: ['J. R. R. Tolkien'],
    edition_key: ['OL1M'],
    isbn: ['9780547928227'],
    language: ['en']
  }, {
    title: 'The Hobbit',
    author: 'J R R Tolkien',
    isbn: '978-0-547-92822-7',
    language: 'en'
  });
  assertEqual(exact.level, 'high', 'Open Library exact title/author/ISBN match scores high confidence');

  const normalizedLanguage = scoreOpenLibraryDoc({
    key: '/works/OL1W',
    title: 'The Hobbit',
    author_name: ['J. R. R. Tolkien'],
    language: ['eng']
  }, {
    title: 'The Hobbit',
    author: 'J R R Tolkien',
    language: 'English'
  });
  assert(normalizedLanguage.languageMatch, 'Open Library language normalization matches eng and English');

  const pathLanguage = scoreOpenLibraryDoc({
    key: '/works/OL1W',
    title: 'The Hobbit',
    author_name: ['J. R. R. Tolkien'],
    language: ['/languages/eng']
  }, {
    title: 'The Hobbit',
    author: 'J R R Tolkien',
    language: 'en-US'
  });
  assert(pathLanguage.languageMatch, 'Open Library language normalization matches /languages/eng and en-US');

  const titleOnly = scoreOpenLibraryDoc({
    key: '/works/OL2W',
    title: 'The Hobbit',
    author_name: ['Someone Else']
  }, {
    title: 'The Hobbit'
  });
  assert(titleOnly.level === 'medium' || titleOnly.level === 'low', 'Open Library title-only match does not become high confidence');

  const collection = scoreOpenLibraryDoc({
    key: '/works/OLCOLLECTIONW',
    title: 'Michael Crichton Collection (Airframe / Lost World / Timeline)',
    author_name: ['Michael Crichton'],
    edition_key: ['OLCOLLECTIONM'],
    language: ['en']
  }, {
    title: 'Crichton, Michael - Airframe',
    author: 'Crichton, Michael [Crichton, Michael]',
    language: 'en'
  });
  assert(collection.level !== 'high', 'Open Library collection does not masquerade as an exact single-title match');

  const genericSubtitle = scoreOpenLibraryDoc({
    key: '/works/OLNOVELW',
    title: 'State of Fear',
    author_name: ['Michael Crichton'],
    edition_key: ['OLNOVELM'],
    language: ['en']
  }, {
    title: 'State of fear : a novel',
    author: 'Michael Crichton, 1942-2008',
    language: 'en'
  });
  assertEqual(genericSubtitle.level, 'high', 'Open Library generic novel subtitle still resolves to the exact work');

  const datedCatalogTitle = scoreOpenLibraryDoc({
    key: '/works/OLSKETCHESW',
    title: 'Book of sketches, 1952-57',
    author_name: ['Jack Kerouac'],
    language: ['en']
  }, {
    title: 'Book of Sketches',
    author: 'Jack Kerouac',
    language: 'en'
  });
  assertEqual(datedCatalogTitle.level, 'high', 'Open Library year-range suffix still resolves to the exact work');

  assert(isGoogleBooksCoverMatch({
    title: 'Book of Sketches',
    authors: ['Jack Kerouac']
  }, 'Book of Sketches', 'Kerouac, Jack'), 'Google Books accepts an exact title and author cover');
  assert(!isGoogleBooksCoverMatch({
    title: 'Michael Crichton Collection (Airframe / Lost World / Timeline)',
    authors: ['Michael Crichton']
  }, 'Airframe', 'Michael Crichton'), 'Google Books rejects a collection cover for a single title');
  assert(!isGoogleBooksCoverMatch({
    title: 'Book of Sketches',
    authors: ['Another Author']
  }, 'Book of Sketches', 'Jack Kerouac'), 'Google Books rejects an exact title with the wrong author');

  const conflict = scoreOpenLibraryDoc({
    key: '/works/OL3W',
    title: 'A Brief History of Time',
    author_name: ['Stephen Hawking']
  }, {
    title: 'The Hobbit',
    author: 'J. R. R. Tolkien'
  });
  assertEqual(conflict.level, 'conflict', 'Open Library wrong title/author match is marked conflict');

  const resolved = await resolveOpenLibraryIdentity({
    title: 'The Hobbit',
    author: 'J. R. R. Tolkien'
  }, {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { docs: [{
          key: '/works/OL123W',
          title: 'The Hobbit',
          author_name: ['J. R. R. Tolkien'],
          edition_key: ['OL456M'],
          isbn: ['9780547928227'],
          first_publish_year: 1937,
          language: ['en'],
          cover_i: 123
        }] };
      }
    })
  });
  assertEqual(resolved.openLibraryWorkKey, '/works/OL123W', 'Open Library resolver returns work key');
  assertEqual(resolved.openLibraryEditionKey, '/books/OL456M', 'Open Library resolver returns edition key');
  assertEqual(resolved.confidence.level, 'high', 'Open Library resolver returns confidence level');
  assertEqual(resolved.matchedFrom, 'raw', 'Open Library resolver reports raw title match source');

  const cleanedResolved = await resolveOpenLibraryIdentity({
    title: 'The Hobbit [retail]',
    author: 'J. R. R. Tolkien'
  }, {
    fetchImpl: async url => {
      const q = new URL(url).searchParams.get('q');
      return {
        ok: true,
        async json() {
          return {
            docs: q === 'The Hobbit J. R. R. Tolkien'
              ? [{
                  key: '/works/OL123W',
                  title: 'The Hobbit',
                  author_name: ['J. R. R. Tolkien'],
                  edition_key: ['OL456M']
                }]
              : []
          };
        }
      };
    }
  });
  assertEqual(cleanedResolved.matchedFrom, 'cleaned', 'Open Library resolver falls through to cleaned title lookup');

  const queryResolved = await resolveOpenLibraryIdentity({
    query: 'There and Back Again Tolkien'
  }, {
    fetchImpl: async url => {
      const q = new URL(url).searchParams.get('q');
      return {
        ok: true,
        async json() {
          return {
            docs: q === 'There and Back Again Tolkien'
              ? [{
                  key: '/works/OL123W',
                  title: 'There and Back Again Tolkien',
                  author_name: ['J. R. R. Tolkien'],
                  edition_key: ['OL456M']
                }]
              : []
          };
        }
      };
    }
  });
  assertEqual(queryResolved.matchedFrom, 'query', 'Open Library resolver supports explicit query lookup source');

  const leakedQueryIdentity = await resolveOpenLibraryIdentity({
    title: 'KURT VONNEGUT: Tribute to Alan Ginsberg',
    author: 'Chris Huber (Durham, NC USA); KURT VONNEGUT',
    language: 'en',
    queryTitle: 'Slaughterhouse-Five',
    queryAuthor: 'Kurt Vonnegut'
  }, {
    fetchImpl: async url => {
      const q = new URL(url).searchParams.get('q');
      return {
        ok: true,
        async json() {
          return {
            docs: q.includes('Slaughterhouse-Five')
              ? [{
                  key: '/works/OL98459W',
                  title: 'Slaughterhouse-Five',
                  author_name: ['Kurt Vonnegut'],
                  edition_key: ['OL123M'],
                  language: ['eng'],
                  cover_i: 123
                }]
              : []
          };
        }
      };
    }
  });
  assertEqual(
    leakedQueryIdentity.confidence.level,
    'conflict',
    'Open Library query fallback cannot override the provider listing title and primary author'
  );

  const failOpenResolved = await resolveOpenLibraryIdentity({
    title: 'The Hobbit [retail]',
    author: 'J. R. R. Tolkien'
  }, {
    fetchImpl: async url => {
      const q = new URL(url).searchParams.get('q');
      if (q.includes('[retail]')) throw new Error('temporary raw lookup failure');
      return {
        ok: true,
        async json() {
          return {
            docs: [{
              key: '/works/OL123W',
              title: 'The Hobbit',
              author_name: ['J. R. R. Tolkien'],
              edition_key: ['OL456M']
            }]
          };
        }
      };
    }
  });
  assertEqual(failOpenResolved.matchedFrom, 'cleaned', 'Open Library resolver continues after a failed raw lookup');
  assert(failOpenResolved.warnings.some(warning => warning.includes('unavailable')), 'Open Library resolver reports partial lookup failures');

  const failed = await resolveOpenLibraryIdentity({ title: 'The Hobbit' }, {
    fetchImpl: async () => { throw new Error('network down'); }
  });
  assertEqual(failed.confidence.level, 'low', 'Open Library resolver fails open on network errors');
  assertEqual(failed.matchedFrom, null, 'Open Library resolver reports no match source on failure');
  assert(failed.warnings.length > 0, 'Open Library resolver returns warning on failure');
})());

// ─── 18. TTS Text Safety ────────────────────────────────────────────────────

section('18. TTS text safety');

(() => {
  const prepared = prepareTtsText('Hello ,world....\n\n\nNext');
  assert(prepared.includes('Hello, world'), 'Provider-neutral TTS prep fixes punctuation spacing');
  const casing = prepareTtsText(
    'DICKENS & JOYCE: THE TWO-CIRCUIT DIALECTIC\nJUNG met LEARY at NASA and asked about HTML and NATO.'
  );
  assert(casing.includes('Dickens & Joyce'), 'Narration casing prevents lexical names from being spelled letter by letter');
  assert(casing.includes('TWO-Circuit Dialectic'), 'Narration casing repairs all-caps compound headings');
  assert(casing.includes('Jung met Leary'), 'Narration casing repairs all-caps names in body prose');
  assert(casing.includes('Nasa') && casing.includes('Nato'), 'Narration casing makes word-spoken acronyms pronounceable');
  assert(casing.includes('HTML'), 'Narration casing preserves letter-spelled initialisms');
  const acronymCoverage = prepareTtsText(
    'ASCII JPEG CAPTCHA UNESCO WIFI WYSIWYG versus NCAA USPS YMCA LGBTQIA.'
  );
  assert(acronymCoverage.includes('Ascii Jpeg Captcha Unesco Wifi Wysiwyg'),
    'Narration casing covers common word-spoken acronyms');
  assert(acronymCoverage.includes('NCAA USPS YMCA LGBTQIA'),
    'Narration casing covers common long letter-spelled initialisms');
  const ornamentalBreak = prepareTtsText(
    'The first passage ends here.\n\n ~•~ \n\nThe next passage begins here.'
  );
  assert(!ornamentalBreak.includes('~') && !ornamentalBreak.includes('•'),
    'Narration removes standalone ornamental scene-break symbols');
  const meaningfulSymbols = prepareTtsText(
    'Wait ~5 minutes, use C++, and compare x < y.'
  );
  assert(meaningfulSymbols.includes('~5') && meaningfulSymbols.includes('C++') && meaningfulSymbols.includes('x < y'),
    'Narration preserves symbols embedded in meaningful prose');
  assert(isSpeakableText(prepared), 'Speakable prose passes TTS validation');
  assert(!isSpeakableText('---- ____ ////'), 'Non-speakable text fails TTS validation');
  const chunks = splitOversizedText('word '.repeat(300), 100);
  assert(chunks.length > 1, 'Oversized TTS text splits at word boundaries');
  assert(chunks.every(chunk => chunk.length <= 101), 'Oversized TTS chunks respect max length');
})();

// ─── 19. Sync identity and position store helpers ───────────────────────────

section('19. Sync identity');

(() => {
  assertEqual(serverTestHooks.sanitizeSyncId('usr_abc-123', 'fallback'), 'usr_abc-123', 'Sync id accepts alphanumeric underscore hyphen');
  assertEqual(serverTestHooks.sanitizeSyncId('bad/user', 'fallback'), 'fallback', 'Sync id rejects unsafe characters');

  const legacy = {
    bookA: { chapterIndex: 1, timestamp: 10 }
  };
  const normalized = serverTestHooks.normalizePositionsStore(legacy);
  assert(normalized.users.default.bookA, 'Legacy flat positions normalize under default user');

  const removed = serverTestHooks.removeBookPositions({
    users: {
      alice: { bookA: { timestamp: 1 }, bookB: { timestamp: 2 } },
      bob: { bookA: { timestamp: 3 } }
    }
  }, 'bookA');
  assert(!removed.users.alice.bookA, 'Delete cleanup removes book position from first user');
  assert(!removed.users.bob.bookA, 'Delete cleanup removes book position from second user');
  assert(removed.users.alice.bookB, 'Delete cleanup preserves unrelated book positions');

  const users = serverTestHooks.normalizeUsersStore({});
  assert(users.users && typeof users.users === 'object', 'Users store normalizes missing users object');

  const profile = serverTestHooks.publicSyncProfile({
    id: 'usr_test',
    name: 'My Library',
    createdAt: '2026-01-01T00:00:00.000Z',
    devices: {
      dev_a: { id: 'dev_a', name: 'Phone', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z' }
    }
  }, 'dev_a');
  assertEqual(profile.id, 'usr_test', 'Public sync profile exposes user id');
  assertEqual(profile.deviceId, 'dev_a', 'Public sync profile includes active device id');
  assertEqual(profile.devices.length, 1, 'Public sync profile lists devices');

  const code = serverTestHooks.createPairingCode();
  assert(/^\d{6}$/.test(code), 'Pairing code is six digits');
  assertEqual(serverTestHooks.normalizePairingCode('123-456'), '123456', 'Pairing code normalization strips separators');
  assertEqual(serverTestHooks.hashPairingCode('123456'), serverTestHooks.hashPairingCode('123456'), 'Pairing code hash is stable');
})();

// ─── 20. Import jobs and Gutenberg metadata ────────────────────────────────

section('20. Import progress and Gutenberg metadata');

pendingAsyncTests.push((async () => {
  const { bookDocument, xbookStore } = serverTestHooks;
  const bookId = `kindle-cover-wiring-${process.pid}-${Date.now()}`;
  const sourcePath = '/tmp/kindle-import.azw3';
  const xbookPath = xbookStore.getXBookPath(bookId);
  const outputPath = path.join(path.dirname(xbookPath), `${bookId}_cover.jpg`);
  const originalExtractCover = bookDocument.extractCover;
  const calls = [];

  bookDocument.extractCover = async (...args) => {
    calls.push(args);
    return true;
  };

  try {
    const { artifact } = await xbookStore.writeXBookArtifact(bookId, sourcePath, {
      metadata: { title: 'Kindle test' },
      chapters: [],
      originalFormat: 'AZW3'
    });
    assertDeep(calls, [[sourcePath, outputPath]],
      'XBook Kindle imports forward the generated cover output path to Book Document');
    assert(artifact.embeddedCover, 'XBook artifacts retain the extracted Kindle cover state');
  } finally {
    bookDocument.extractCover = originalExtractCover;
    fs.rmSync(xbookPath, { force: true });
    fs.rmSync(outputPath, { force: true });
  }
})());

pendingAsyncTests.push((async () => {
  const job = serverTestHooks.createImportJob();
  const progress = serverTestHooks.progressForImportJob(job);
  progress(2, 'Downloading test file');
  const snapshot = serverTestHooks.importJobSnapshot(job);
  assertEqual(snapshot.step, 2, 'Import job progress stores current step');
  assertEqual(snapshot.label, 'Downloading file', 'Import job progress stores canonical step label');
  assertEqual(snapshot.detail, 'Downloading test file', 'Import job progress stores detail text');
  assertEqual(snapshot.totalSteps, 7, 'Import progress reports the seven import stages');

  progress(5, 'Trying alternative edition 1 of 2');
  progress(3, 'Checking alternative file format');
  const clamped = serverTestHooks.importJobSnapshot(job);
  assertEqual(clamped.step, 5, 'Import job step never moves backward when earlier steps are re-emitted');
  assertEqual(clamped.detail, 'Checking alternative file format', 'Clamped progress still reports the latest activity detail');
  const lastEvent = job.events[job.events.length - 1];
  assertEqual(lastEvent.data.step, 5, 'Stored progress events carry the clamped step for SSE replay');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-epub-'));
  const epubDir = path.join(tempRoot, 'epub');
  fs.mkdirSync(path.join(epubDir, '4217'), { recursive: true });
  fs.writeFileSync(path.join(epubDir, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(epubDir, '4217', 'content.opf'), '<metadata><identifier>https://www.gutenberg.org/ebooks/4217</identifier></metadata>');
  fs.writeFileSync(path.join(epubDir, '4217', 'toc.ncx'), '<ncx></ncx>');
  const epubPath = path.join(tempRoot, 'test.epub');
  execFileSync('zip', ['-qr', epubPath, '.'], { cwd: epubDir });

  const inferred = await serverTestHooks.inferGutenbergIdFromBook(epubPath, {});
  assertEqual(inferred, '4217', 'Gutenberg ID is inferred from EPUB zip paths/metadata');

  fs.rmSync(tempRoot, { recursive: true, force: true });
})());

pendingAsyncTests.push((async () => {
  const selected = hemingwayCrossSourceResults[0];
  const volume = hemingwayCrossSourceResults[6];
  const command = serverTestHooks.downloadImportCommand({
    ...selected,
    fallbackGroupId: 'forged-compatible-group',
    filename: 'complete-works.epub',
    alternatives: [{ ...volume, fallbackGroupId: 'forged-compatible-group' }]
  });
  assertEqual(
    await command.alternatives[0].shouldTry(),
    false,
    'Server rejects a constituent volume despite a forged matching client fallback-group ID'
  );
  const compatible = serverTestHooks.downloadImportCommand({
    ...hemingwayCrossSourceResults[3],
    filename: 'complete-works.epub',
    alternatives: [hemingwayCrossSourceResults[4]]
  });
  assertEqual(
    await compatible.alternatives[0].shouldTry(),
    true,
    'Server retains a compatible cross-source version as an automatic fallback'
  );
})());

pendingAsyncTests.push((async () => {
  const failure = new Error('alternative provider rejected download');
  let attemptedDestination;
  const command = serverTestHooks.downloadImportCommand({
    hash: `primary-cleanup-${process.pid}-${Date.now()}`,
    filename: 'primary.epub',
    title: 'Primary Cleanup',
    alternatives: [{
      hash: `alternative-cleanup-${process.pid}-${Date.now()}`,
      format: 'epub',
      title: 'Alternative Cleanup',
      source: 'annas'
    }]
  }, {
    download: async (_alternative, destination) => {
      attemptedDestination = destination;
      fs.writeFileSync(destination, 'partial download');
      throw failure;
    }
  });
  let received;
  let partialRemoved;
  try {
    await command.alternatives[0].acquire();
  } catch (error) {
    received = error;
  } finally {
    partialRemoved = attemptedDestination && !fs.existsSync(attemptedDestination);
    if (attemptedDestination) fs.rmSync(attemptedDestination, { force: true });
  }
  assertEqual(received, failure, 'alternative acquisition preserves provider failures');
  assert(partialRemoved,
    'alternative acquisition removes a partial provider destination before rethrowing');
})());

pendingAsyncTests.push((async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-no-toc-epub-'));
  const epubDir = path.join(tempRoot, 'epub');
  const oebpsDir = path.join(epubDir, 'OEBPS');
  fs.mkdirSync(path.join(epubDir, 'META-INF'), { recursive: true });
  fs.mkdirSync(oebpsDir, { recursive: true });
  fs.writeFileSync(path.join(epubDir, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(epubDir, 'META-INF', 'container.xml'), `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  fs.writeFileSync(path.join(oebpsDir, 'content.opf'), `<?xml version="1.0" encoding="UTF-8"?>
    <package version="2.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="bookid">no-toc-readable</dc:identifier>
        <dc:title>Readable Archive Document</dc:title>
        <dc:creator>Archive Author</dc:creator>
        <dc:language>en</dc:language>
      </metadata>
      <manifest>
        <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
        <item id="c3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine>
        <itemref idref="c1"/>
        <itemref idref="c2"/>
        <itemref idref="c3"/>
      </spine>
    </package>`);
  const body = '<p>' + 'Readable archive prose with enough text for audiobook import. '.repeat(420) + '</p>';
  for (const index of [1, 2, 3]) {
    fs.writeFileSync(path.join(oebpsDir, `chapter${index}.xhtml`), `<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><head><title>Section ${index}</title></head>
      <body><h1>Section ${index}</h1>${body}</body></html>`);
  }
  const noTocPath = path.join(tempRoot, 'no-toc-readable.epub');
  execFileSync('zip', ['-X0q', noTocPath, 'mimetype'], { cwd: epubDir });
  execFileSync('zip', ['-X0qr', noTocPath, 'META-INF', 'OEBPS'], { cwd: epubDir });

  const validation = await serverTestHooks.validateEPUB(noTocPath);
  assert(validation.valid, 'Readable EPUB without TOC validates through spine fallback');
  assert(validation.warnings.some(w => /Missing EPUB table of contents/.test(w)), 'Missing TOC is reported as a warning');

  fs.rmSync(tempRoot, { recursive: true, force: true });
})());

(() => {
  const identified = serverTestHooks.coverSourceSteps({
    path: '/tmp/book.epub',
    title: 'Lila',
    author: 'Robert M. Pirsig',
    openLibraryWorkKey: '/works/OL827364W'
  }, 'epub', false).map(step => step.id);
  assertEqual(identified[0], 'openlibrary-work', 'Identified books try Open Library work covers before embedded covers');
  assertEqual(identified[1], 'embedded', 'Embedded cover is preferred over generic metadata searches');
  const identifiedDownload = serverTestHooks.coverSourceSteps({
    id: '28a8007aa970b47183274df933959bd5',
    path: '/tmp/book.epub',
    title: 'Prometheus Rising',
    author: 'Robert Anton Wilson',
    downloadSource: 'annas',
    openLibraryWorkKey: '/works/OL1805249W'
  }, 'epub', false).map(step => step.id);
  assertEqual(identifiedDownload[0], 'openlibrary-work',
    'Stable catalog identity supersedes the duplicate selected-search cover path');
  assertEqual(identifiedDownload[1], 'embedded',
    'Exact embedded cover is tried before generic metadata searches');

  const unidentified = serverTestHooks.coverSourceSteps({
    path: '/tmp/book.epub',
    title: 'Unknown',
    author: 'Unknown'
  }, 'epub', false).map(step => step.id);
  assertEqual(unidentified[0], 'embedded', 'Unidentified EPUBs still try embedded covers first');
  assert(
    unidentified.indexOf('openlibrary-search') < unidentified.indexOf('google-books'),
    'Open Library search is tried before Google Books for generic cover fallback'
  );

  const imported = serverTestHooks.coverSourceSteps({
    id: '91593b7cb5d7cc9c348f7070b956a9b8',
    title: 'Revelations of Christ',
    author: 'Paramhansa Yogananda',
    searchedTitle: 'Revelations of Christ',
    searchedAuthor: 'Paramhansa Yogananda',
    language: 'English',
    downloadSource: 'annas',
    sourceProvenance: { sourceUrl: 'https://annas-archive.gl/md5/91593b7cb5d7cc9c348f7070b956a9b8' }
  }, 'azw3', false).map(step => step.id);
  assertEqual(imported[0], 'selected-search-result',
    'Downloaded books promote the already-resolved selected search cover before new remote lookups');

  const jpeg = Buffer.alloc(64);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[3] = 0xe0;
  jpeg.writeUInt16BE(16, 4);
  jpeg[20] = 0xff;
  jpeg[21] = 0xc0;
  jpeg.writeUInt16BE(17, 22);
  jpeg[24] = 8;
  jpeg.writeUInt16BE(480, 25);
  jpeg.writeUInt16BE(320, 27);
  jpeg[29] = 3;
  jpeg[jpeg.length - 2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  assertEqual(serverTestHooks.validatedLibraryCoverInfo(jpeg)?.contentType, 'image/jpeg',
    'Validated cached JPEG bytes are served with image/jpeg rather than the cache extension');

  const png = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(png, 12);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(480, 20);
  png[24] = 8;
  png[25] = 2;
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]).copy(png, png.length - 12);
  assertEqual(serverTestHooks.validatedLibraryCoverInfo(png)?.contentType, 'image/png',
    'Validated cached PNG bytes are served with image/png despite the .jpg cache path');
  const smallJpeg = Buffer.from(jpeg);
  smallJpeg.writeUInt16BE(128, 25);
  smallJpeg.writeUInt16BE(100, 27);
  assertEqual(serverTestHooks.validatedLibraryCoverInfo(smallJpeg)?.contentType, 'image/jpeg',
    'Legitimate 100px-wide covers remain eligible for library serving');
  const incompleteJpeg = Buffer.from(jpeg);
  incompleteJpeg[incompleteJpeg.length - 1] = 0;
  assertEqual(serverTestHooks.validatedLibraryCoverInfo(incompleteJpeg), null,
    'Truncated JPEG cache entries without EOI are rejected');
  const incompletePng = Buffer.from(png);
  incompletePng[incompletePng.length - 1] = 0;
  assertEqual(serverTestHooks.validatedLibraryCoverInfo(incompletePng), null,
    'Truncated PNG cache entries without IEND are rejected');
  assertEqual(serverTestHooks.validatedLibraryCoverInfo(Buffer.from('not an image')), null,
    'Invalid cached cover bytes are rejected before the route can serve them');

  assert(serverTestHooks.shouldRefreshCachedCover({
    openLibraryWorkKey: '/works/OL827364W',
    coverPath: '/tmp/book_cover.jpg'
  }), 'Legacy cached catalog book cover refreshes when source is unknown');
  assert(serverTestHooks.shouldRefreshCachedCover({
    openLibraryWorkKey: '/works/OL827364W',
    coverSource: 'embedded'
  }), 'Embedded cached catalog book cover refreshes');
  assert(serverTestHooks.shouldRefreshCachedCover({
    openLibraryWorkKey: '/works/OL1805249W',
    coverSource: 'selected-search-result'
  }, false, { dimensions: { width: 140, height: 217 } }),
  'Low-resolution selected-search cover refreshes when a stronger source is available');
  assert(!serverTestHooks.shouldRefreshCachedCover({
    openLibraryWorkKey: '/works/OL1805249W',
    coverSource: 'selected-search-result'
  }, false, { dimensions: { width: 640, height: 1000 } }),
  'Display-quality selected-search cover remains cached');
  assert(!serverTestHooks.shouldRefreshCachedCover({
    openLibraryWorkKey: '/works/OL827364W',
    coverSource: 'openlibrary-work'
  }), 'Catalog-sourced cached cover is accepted');

  pendingAsyncTests.push((async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xandrio-cover-rank-'));
    const outputPath = path.join(tempRoot, 'cover.jpg');
    const low = Buffer.from(jpeg);
    low.writeUInt16BE(217, 25);
    low.writeUInt16BE(140, 27);
    const high = Buffer.from(jpeg);
    high.writeUInt16BE(1001, 25);
    high.writeUInt16BE(643, 27);
    const book = { id: 'cover-rank', title: 'Cover Rank', author: 'Author' };
    await serverTestHooks.ensureBookCover(book, {
      coverPath: outputPath,
      steps: [
        {
          id: 'thumbnail',
          label: 'thumbnail',
          fetch: async candidatePath => {
            fs.writeFileSync(candidatePath, low);
            return true;
          }
        },
        {
          id: 'embedded',
          label: 'embedded',
          fetch: async candidatePath => {
            fs.writeFileSync(candidatePath, high);
            return true;
          }
        }
      ]
    });
    const selected = serverTestHooks.validatedLibraryCoverInfo(fs.readFileSync(outputPath));
    assertEqual(selected?.dimensions?.width, 643,
      'Cover resolver continues past a valid thumbnail to a display-quality candidate');
    assertEqual(book.coverSource, 'embedded',
      'Cover resolver records the source of the sharper selected candidate');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  })());
})();

section('21. Error responses and bounded caches');
{
  // sendServerError responds 500 with a generic public message and never leaks err.message
  const originalConsoleError = console.error;
  console.error = () => {}; // silence the intentional server-side log for this test
  let captured = null;
  const fakeRes = {
    status(code) { this._code = code; return this; },
    json(body) { captured = { code: this._code, body }; return this; }
  };
  serverTestHooks.sendServerError(fakeRes, new Error('secret internal detail'), 'Failed to load library');
  console.error = originalConsoleError;
  assertEqual(captured.code, 500, 'sendServerError responds with HTTP 500');
  assertEqual(captured.body.error, 'Failed to load library', 'sendServerError returns the public message');
  assert(!JSON.stringify(captured.body).includes('secret internal detail'), 'sendServerError does not leak err.message to the client');

  const historicalPremiumVariant = 'chatterbox:archived-voice:modelturbo:profilequality:chunk220:fmtwav:refv1:prep1:audio3:pause350';
  assertEqual(serverTestHooks.premiumVoiceFromVariantKey(historicalPremiumVariant), 'chatterbox:archived-voice', 'premium recovery restores the recorded voice without switching UI state');
  assertEqual(serverTestHooks.premiumChunkSizeFromVariantKey(historicalPremiumVariant), 220, 'premium recovery restores the recorded chunk size');

  const uploadError = serverTestHooks.bookUploadErrorResponse(new Error('/private/cache/upload.tmp'));
  assertEqual(uploadError.error, 'Upload failed', 'upload middleware uses a stable message for unexpected failures');
  assert(!JSON.stringify(uploadError).includes('/private/'), 'upload middleware does not expose arbitrary internal errors');

  const routeUploadError = serverTestHooks.uploadRouteErrorResponse(Object.assign(
    new Error('/private/cache/upload.tmp'),
    { statusCode: 400, details: '/private/details' }
  ));
  assertEqual(routeUploadError.error, 'Upload could not be processed', 'upload route uses a stable message for unexpected 400 errors');
  assert(!JSON.stringify(routeUploadError).includes('/private/'), 'upload route does not expose arbitrary error details');

  const duplicateUploadError = serverTestHooks.uploadRouteErrorResponse({ statusCode: 400, existingBookId: 'abc123' });
  assertEqual(duplicateUploadError.error, 'Book already exists in library', 'upload route preserves the expected duplicate-book response');
  assertEqual(duplicateUploadError.existingBookId, 'abc123', 'upload route preserves the duplicate book identifier');

  assertEqual(serverTestHooks.uploadRouteErrorResponse({ code: 'PDF_OCR_REQUIRED' }).error, 'PDF requires OCR', 'upload route preserves safe OCR guidance');
  assertEqual(serverTestHooks.uploadRouteErrorResponse({ code: 'KINDLE_DRM_PROTECTED' }).error, 'Kindle file is DRM-protected', 'upload route preserves safe DRM guidance');

  const disconnectedDownload = serverTestHooks.zlibraryDownloadErrorResponse({
    code: 'ZLIB_NOT_CONFIGURED',
    statusCode: 409,
    publicMessage: 'Connect Z-Library before downloading.'
  });
  assertEqual(disconnectedDownload.statusCode, 409, 'Z-Library download preserves the not-configured HTTP status');
  assertEqual(disconnectedDownload.body.code, 'ZLIB_NOT_CONFIGURED', 'Z-Library download preserves the stable recovery code');
  assertEqual(disconnectedDownload.body.error, 'Connect Z-Library before downloading.', 'Z-Library download returns safe Settings guidance');

  const unexpectedZlibraryDownload = serverTestHooks.zlibraryDownloadErrorResponse(new Error('/private/token=secret'));
  assertEqual(unexpectedZlibraryDownload, null, 'unexpected download errors stay on the generic redacted path');

  const disconnectedPreflight = serverTestHooks.zlibraryDownloadPreflightResponse({ state: 'disconnected' });
  assertEqual(disconnectedPreflight.statusCode, 409, 'Z-Library download preflight returns 409 before queuing without a session');
  assertEqual(disconnectedPreflight.body.code, 'ZLIB_NOT_CONFIGURED', 'Z-Library download preflight retains the Settings recovery code');
  assertEqual(serverTestHooks.zlibraryDownloadPreflightResponse({ state: 'connected', downloadsRemaining: 2 }), null, 'connected Z-Library downloads proceed to the import job');

  pendingAsyncTests.push((async () => {
    const providerCalls = [];
    let failed = false;
    try {
      await serverTestHooks.acquireDownloadSource(
        { source: 'annas', hash: 'selected-annas-edition', title: 'Private query', author: 'Private author' },
        '/tmp/unused-annas-download.epub',
        () => {},
        { download: async selection => {
          providerCalls.push(selection);
          throw new Error('upstream body contained token=secret');
        } }
      );
    } catch {
      failed = true;
    }
    assert(failed, 'a failed Anna acquisition is returned to the caller for an explicit retry');
    assertEqual(providerCalls.length, 1, 'a failed Anna acquisition does not silently contact another provider');
    assertEqual(providerCalls[0].source, 'annas', 'the only attempted provider is the user-selected source');
  })());

  pendingAsyncTests.push((async () => {
    const chunks = await serverTestHooks.splitTransformedNarration({
      text: 'short source', bookId: 'book', chunkSize: 8,
      textTransform: async () => 'expanded narration text',
      splitter: (text, size) => text.match(new RegExp(`.{1,${size}}`, 'g')) || []
    });
    assertEqual(chunks.length, 3, 'readiness chunk counts use pronunciation-transformed narration');
  })());

  pendingAsyncTests.push((async () => {
    const record = await serverTestHooks.publicBookRecordWithCoverArtifact({
      id: 'book-with-stale-cover-metadata',
      title: 'Cached Cover',
      path: '/private/book.pdf'
    }, async candidatePath => {
      assert(candidatePath.endsWith('book-with-stale-cover-metadata_cover.jpg'), 'library probes the canonical cover artifact');
    });
    assertEqual(record.hasCover, true, 'library reports a cached cover even when coverPath metadata is stale');
    assert(!Object.hasOwn(record, 'path'), 'library cover projection still strips private book paths');
  })());

  pendingAsyncTests.push((async () => {
    const quiesced = [];
    const fakeWorker = name => ({
      quiesceChapterAllVariants: async (bookId, chapterIndex, boundaries, fallback) => {
        quiesced.push({ name, bookId, chapterIndex, boundaries, fallback });
      }
    });
    const sharedWorker = fakeWorker('shared');
    await serverTestHooks.quiescePronunciationWorkers({
      bookId: 'book', chapterIndex: 2, fromChunkIndexByVariant: { _tts1234567890: 3 }
    }, [sharedWorker, fakeWorker('premium'), sharedWorker]);
    assertEqual(quiesced.length, 2, 'pronunciation invalidation quiesces active and premium workers without duplicates');
    assert(quiesced.every(call => call.fallback === 0), 'pronunciation invalidation clears unknown historical variants from chunk zero');
  })());

  // deletedBookIds is bounded: oldest inserted ids are evicted beyond the cap
  const { rememberDeletedBookId, deletedBookIds, MAX_DELETED_BOOK_IDS } = serverTestHooks;
  deletedBookIds.clear();
  for (let i = 0; i < MAX_DELETED_BOOK_IDS + 25; i++) {
    rememberDeletedBookId(`deleted-book-${i}`);
  }
  assertEqual(deletedBookIds.size, MAX_DELETED_BOOK_IDS, 'deletedBookIds is capped at MAX_DELETED_BOOK_IDS');
  assert(!deletedBookIds.has('deleted-book-0'), 'deletedBookIds evicts the oldest-inserted id');
  assert(deletedBookIds.has(`deleted-book-${MAX_DELETED_BOOK_IDS + 24}`), 'deletedBookIds retains the most recent id');
  deletedBookIds.clear();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

Promise.all(pendingAsyncTests).then(() => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Server tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All server tests passed! ✅');
  }
}).catch(err => {
  failed++;
  console.error(`  ❌ Async test failed — ${err.message}`);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Server tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
});
