/**
 * EPUB Parsing Tests
 * 
 * Tests extractChapters() with real EPUB files from the cache directory.
 * Validates chapter structure, types, sequencing, and title quality.
 *
 * Run:  node test/test-epub-parsing.js
 */

const fs = require('fs');
const path = require('path');

// ─── Test Framework ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

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

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

// ─── Chapter extraction (real module — no more slicing server.js source) ─────

const { extractChapters } = require('../lib/chapter-extraction');

// ─── Valid chapter types ─────────────────────────────────────────────────────

const VALID_TYPES = new Set([
  'cover', 'copyright', 'toc', 'frontmatter', 'author',
  'backmatter', 'chapter', 'divider', 'content'
]);

// ─── Find EPUBs ─────────────────────────────────────────────────────────────

const cacheDir = path.join(__dirname, '..', 'cache');
let epubFiles = [];
try {
  epubFiles = fs.readdirSync(cacheDir)
    .filter(f => f.endsWith('.epub'))
    .map(f => path.join(cacheDir, f));
} catch (e) {
  console.log('No cache directory found, skipping EPUB tests');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  section('EPUB Parsing Tests');

  if (epubFiles.length === 0) {
    // Declare the skip explicitly so the runner reports it instead of
    // counting a 0-test run as green.
    console.log('  ⚠️  SUITE SKIPPED: no EPUB files found in cache/ — 0 tests ran');
    console.log(`\n${'═'.repeat(50)}`);
    console.log('EPUB parsing tests: SUITE SKIPPED (no fixtures)');
    return;
  }

  console.log(`  Found ${epubFiles.length} EPUB file(s) to test\n`);

  for (const epubPath of epubFiles) {
    const filename = path.basename(epubPath);
    section(`EPUB: ${filename}`);
    
    let chapters;
    try {
      chapters = await extractChapters(epubPath);
    } catch (err) {
      failed++;
      console.error(`  ❌ Failed to parse ${filename}: ${err.message}`);
      continue;
    }

    // Test 1: Chapters are returned
    assert(Array.isArray(chapters), `${filename}: Returns an array`);
    assert(chapters.length > 0, `${filename}: Has at least 1 chapter (got ${chapters.length})`);

    // Test 2: Each chapter has required properties
    let structureOk = true;
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      if (ch.index === undefined || ch.title === undefined || 
          ch.text === undefined || ch.type === undefined) {
        structureOk = false;
        failed++;
        console.error(`  ❌ Chapter ${i} missing required properties: ${JSON.stringify(Object.keys(ch))}`);
        break;
      }
    }
    if (structureOk) {
      passed++;
      console.log(`  ✅ ${filename}: All chapters have index, title, text, type`);
    }

    // Test 3: Types are valid
    let typesValid = true;
    const invalidTypes = [];
    for (const ch of chapters) {
      if (!VALID_TYPES.has(ch.type)) {
        typesValid = false;
        invalidTypes.push({ index: ch.index, type: ch.type });
      }
    }
    if (typesValid) {
      passed++;
      console.log(`  ✅ ${filename}: All chapter types are valid`);
    } else {
      failed++;
      console.error(`  ❌ ${filename}: Invalid types found: ${JSON.stringify(invalidTypes)}`);
    }

    // Test 4: Chapter indices are sequential (0, 1, 2, ...)
    let sequential = true;
    for (let i = 0; i < chapters.length; i++) {
      if (chapters[i].index !== i) {
        sequential = false;
        break;
      }
    }
    assert(sequential, `${filename}: Chapter indices are sequential 0..${chapters.length - 1}`);

    // Test 5: No "(none)" titles (TOC fallback bug)
    const noneTitles = chapters.filter(ch => 
      ch.title === '(none)' || ch.title === 'none' || ch.title === ''
    );
    assert(noneTitles.length === 0, 
      `${filename}: No "(none)" or empty titles (found ${noneTitles.length})`);

    // Test 6: No mismatched "Chapter N" titles (old bug — title says "Chapter 5" but it's actually chapter 3)
    // We check that if title is "Chapter N", the number N should be reasonable
    let chapterNumberBug = false;
    const numberedChapters = chapters.filter(ch => /^Chapter \d+$/i.test(ch.title.trim()));
    if (numberedChapters.length >= 2) {
      // Check that numbered chapters appear in order
      const numbers = numberedChapters.map(ch => parseInt(ch.title.match(/\d+/)[0]));
      for (let i = 1; i < numbers.length; i++) {
        // Allow gaps but not reversals
        if (numbers[i] < numbers[i - 1]) {
          chapterNumberBug = true;
          break;
        }
      }
    }
    assert(!chapterNumberBug, `${filename}: Numbered chapters are in order`);

    // Test 7: At least some chapters have substantial text
    const substantialChapters = chapters.filter(ch => ch.text.length > 500);
    assert(substantialChapters.length > 0,
      `${filename}: At least some chapters have >500 chars (got ${substantialChapters.length})`);

    // Test 8: No chapter text contains raw HTML tags
    let noRawHTML = true;
    for (const ch of chapters) {
      if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?\s*>/i.test(ch.text)) {
        noRawHTML = false;
        break;
      }
    }
    assert(noRawHTML, `${filename}: No raw HTML tags in chapter text`);

    // Test 9: Chapter type distribution makes sense
    const typeCount = {};
    for (const ch of chapters) {
      typeCount[ch.type] = (typeCount[ch.type] || 0) + 1;
    }
    
    // Most chapters should be 'chapter' or 'content' type
    const contentTypes = (typeCount.chapter || 0) + (typeCount.content || 0);
    const totalTypes = chapters.length;
    assert(contentTypes > 0,
      `${filename}: Has chapter/content types (${contentTypes}/${totalTypes})`);

    // Test 10: originalIndex is present and valid
    let origIndexOk = true;
    for (const ch of chapters) {
      if (ch.originalIndex === undefined || ch.originalIndex < 0) {
        origIndexOk = false;
        break;
      }
    }
    assert(origIndexOk, `${filename}: All chapters have valid originalIndex`);

    // Print summary
    console.log(`    Types: ${JSON.stringify(typeCount)}`);
    console.log(`    Total chapters: ${chapters.length}, Substantial: ${substantialChapters.length}`);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`EPUB parsing tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All EPUB parsing tests passed! ✅');
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
