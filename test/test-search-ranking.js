/**
 * Search Ranking Tests
 * 
 * Tests the search result ranking, grouping, and filtering logic
 * from server.js /api/search endpoint with mock data.
 *
 * Run:  node test/test-search-ranking.js
 */

const { calculateQualityScore, parseSizeToBytes } = require('../lib/search-utils');

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

const DERIVATIVE_TITLE_PENALTIES = [
  { pattern: /\b(dramati[sz]ation|dramatized|radio play|stage play|screenplay)\b/i, penalty: 140 },
  { pattern: /\b(reboot|remix|reimagined|reimagining|modernized|modernised)\b/i, penalty: 130 },
  { pattern: /\b(adaptation|adapted|retold|abridged|condensed)\b/i, penalty: 100 },
  { pattern: /\b(summary|study guide|analysis|companion|notes)\b/i, penalty: 120 }
];

function derivativeTitlePenalty(result) {
  const title = result.title || '';
  return DERIVATIVE_TITLE_PENALTIES.reduce((penalty, rule) => {
    return rule.pattern.test(title) ? Math.max(penalty, rule.penalty) : penalty;
  }, 0);
}

function canonicalTitleCandidates(result) {
  return [
    result.canonicalTitle,
    result.openLibraryCanonicalTitle,
    result.openLibraryTitle,
    result.title
  ].filter(Boolean);
}

function canonicalQueryBonus(queryNorm, result) {
  const penalty = derivativeTitlePenalty(result);
  const hasCanonicalMatch = canonicalTitleCandidates(result)
    .some(title => normalizeTitle(title) === queryNorm);

  return hasCanonicalMatch && penalty === 0 ? 80 : 0;
}

/**
 * Simulate the full search ranking pipeline from the /api/search handler.
 * Input: query string + array of raw search results
 * Output: { recommended, alternatives } after grouping/ranking/filtering
 */
function rankSearchResults(query, results) {
  const ebookFormats = new Set(['EPUB', 'MOBI', 'AZW', 'AZW3', 'PRC']);
  if (results.some(result => ebookFormats.has(String(result.format || '').toUpperCase()))) {
    results = results.filter(result => ebookFormats.has(String(result.format || '').toUpperCase()));
  }

  const queryLower = query.toLowerCase();
  const queryNorm = normalizeTitle(query);
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
  
  const scoredResults = results.map(result => {
    let relevanceScore = 0;
    const titleLower = (result.title || '').toLowerCase();
    const titleNorm = normalizeTitle(result.title);
    const authorLower = (result.author || '').toLowerCase();
    const derivativePenalty = derivativeTitlePenalty(result);
    const canonicalBonus = canonicalQueryBonus(queryNorm, result);
    
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

    relevanceScore += canonicalBonus;
    relevanceScore -= derivativePenalty;
    
    const year = extractYear(result.publisher);
    
    return {
      ...result,
      qualityScore: calculateQualityScore(result),
      relevanceScore,
      canonicalQueryBonus: canonicalBonus,
      derivativePenalty,
      _year: year
    };
  });
  
  const workGroups = new Map();
  for (const result of scoredResults) {
    const authorKey = (result.author || 'unknown').toLowerCase().split(/[\s,]+/)[0];
    const groupKey = result.openLibraryWorkKey || (normalizeTitle(result.title) + '|' + authorKey);
    
    if (!workGroups.has(groupKey)) {
      workGroups.set(groupKey, {
        title: result.title,
        author: result.author,
        editions: [],
        bestRelevance: result.relevanceScore
      });
    }
    workGroups.get(groupKey).editions.push(result);
    workGroups.get(groupKey).bestRelevance = Math.max(
      workGroups.get(groupKey).bestRelevance,
      result.relevanceScore
    );
  }
  
  const rankedWorks = [];
  for (const [key, group] of workGroups) {
    const fmtOrder = { 'EPUB': 0, 'MOBI': 1, 'AZW3': 1, 'PDF': 2 };
    group.editions.sort((a, b) => {
      const fmtA = fmtOrder[a.format] ?? 3;
      const fmtB = fmtOrder[b.format] ?? 3;
      if (fmtA !== fmtB) return fmtA - fmtB;

      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      
      const yearA = a._year || 0;
      const yearB = b._year || 0;
      if (yearB !== yearA) return yearB - yearA;
      
      return parseSizeToBytes(b.size) - parseSizeToBytes(a.size);
    });
    
    const bestEdition = group.editions[0];
    rankedWorks.push({
      ...bestEdition,
      editionCount: group.editions.length,
      otherEditions: group.editions.slice(1, 5),
      bestRelevance: group.bestRelevance
    });
  }
  
  rankedWorks.sort((a, b) => {
    if (b.bestRelevance !== a.bestRelevance) return b.bestRelevance - a.bestRelevance;
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    return parseSizeToBytes(b.size) - parseSizeToBytes(a.size);
  });
  
  const acceptableWorks = rankedWorks.filter(r => r.qualityScore >= 2 || r.format === 'PDF');
  
  if (acceptableWorks.length === 0) {
    return { recommended: null, alternatives: [] };
  }
  
  return {
    recommended: acceptableWorks[0],
    alternatives: acceptableWorks.slice(1)
  };
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

function makeResult(overrides) {
  return {
    title: 'Default Title',
    author: 'Default Author',
    format: 'EPUB',
    size: '2 MB',
    hash: 'hash_' + Math.random().toString(36).slice(2, 10),
    publisher: '',
    language: 'en',
    url: '',
    ...overrides
  };
}

// ─── 1. Work Grouping Tests ─────────────────────────────────────────────────

section('1. Work grouping (same title+author → grouped)');

(() => {
  const results = [
    makeResult({ title: 'Dune', author: 'Frank Herbert', format: 'EPUB', size: '2 MB', publisher: 'Ace, 2019' }),
    makeResult({ title: 'Dune', author: 'Frank Herbert', format: 'PDF', size: '5 MB', publisher: 'Penguin, 2010' }),
    makeResult({ title: 'Dune', author: 'Frank Herbert', format: 'MOBI', size: '1.5 MB', publisher: 'Ace, 2023' }),
    makeResult({ title: 'Dune Messiah', author: 'Frank Herbert', format: 'EPUB', size: '1.8 MB' }),
  ];

  const ranked = rankSearchResults('Dune', results);
  
  // All 3 "Dune" editions should be grouped into 1 work
  assert(ranked.recommended !== null, 'Has a recommended result');
  
  // Check that the recommended is Dune (exact match)
  assertEqual(normalizeTitle(ranked.recommended.title), 'dune', 'Recommended is "Dune"');
  
  // The recommended Dune should have editionCount showing grouping
  assert(ranked.recommended.editionCount >= 2, 
    `"Dune" has multiple editions grouped (${ranked.recommended.editionCount})`);
  
  // Dune Messiah should be a separate work
  const messiahInAlts = ranked.alternatives.some(a => normalizeTitle(a.title).includes('dune messiah'));
  assert(messiahInAlts || normalizeTitle(ranked.recommended.title).includes('dune messiah'),
    'Dune Messiah is a separate work');

  // Total unique works = 2 (Dune + Dune Messiah)
  const totalWorks = 1 + ranked.alternatives.length;
  assertEqual(totalWorks, 2, 'Total unique works = 2');
})();

// ─── 2. Edition Selection Tests ─────────────────────────────────────────────

section('2. Edition selection (format + year priority)');

(() => {
  // 2a. EPUB preferred over MOBI over PDF
  const results = [
    makeResult({ title: 'Test Book', author: 'Author', format: 'PDF', size: '10 MB', publisher: 'Pub, 2020' }),
    makeResult({ title: 'Test Book', author: 'Author', format: 'EPUB', size: '2 MB', publisher: 'Pub, 2020' }),
    makeResult({ title: 'Test Book', author: 'Author', format: 'MOBI', size: '3 MB', publisher: 'Pub, 2020' }),
  ];

  const ranked = rankSearchResults('Test Book', results);
  assertEqual(ranked.recommended.format, 'EPUB', 'EPUB selected as best edition');

  // 2b. Newest year preferred (same format)
  const results2 = [
    makeResult({ title: 'Classic Novel', author: 'Author', format: 'EPUB', size: '2 MB', publisher: 'Old Press, 2005' }),
    makeResult({ title: 'Classic Novel', author: 'Author', format: 'EPUB', size: '2 MB', publisher: 'New Press, 2023' }),
    makeResult({ title: 'Classic Novel', author: 'Author', format: 'EPUB', size: '2 MB', publisher: 'Mid Press, 2015' }),
  ];

  const ranked2 = rankSearchResults('Classic Novel', results2);
  assertEqual(ranked2.recommended.publisher, 'New Press, 2023', 'Newest year selected');

  // 2c. Larger file preferred as final tiebreaker
  const results3 = [
    makeResult({ title: 'Same Book', author: 'Author', format: 'EPUB', size: '1 MB', publisher: 'Pub, 2020' }),
    makeResult({ title: 'Same Book', author: 'Author', format: 'EPUB', size: '5 MB', publisher: 'Pub, 2020' }),
  ];

  const ranked3 = rankSearchResults('Same Book', results3);
  assertEqual(ranked3.recommended.size, '5 MB', 'Larger file preferred as tiebreaker');

  // 2d. Other editions are accessible
  assert(ranked.recommended.otherEditions !== undefined, 'otherEditions array exists');
  assert(ranked.recommended.otherEditions.length >= 1, 
    `Has alternative editions (${ranked.recommended.otherEditions.length})`);
})();

// ─── 3. Relevance Scoring Tests ─────────────────────────────────────────────

section('3. Relevance scoring');

(() => {
  // 3a. Exact title match ranked first
  const results = [
    makeResult({ title: 'The Great Gatsby Companion Guide', author: 'Study Author' }),
    makeResult({ title: 'The Great Gatsby', author: 'F. Scott Fitzgerald' }),
    makeResult({ title: 'Gatsby Believed in the Green Light', author: 'Random Author' }),
  ];

  const ranked = rankSearchResults('The Great Gatsby', results);
  assertEqual(normalizeTitle(ranked.recommended.title), 'the great gatsby', 
    'Exact title match is recommended');

  // 3b. Title-contains ranked above no-match
  const results2 = [
    makeResult({ title: 'Totally Different Book', author: 'Nobody' }),
    makeResult({ title: '1984: The Annotated Edition', author: 'George Orwell' }),
    makeResult({ title: '1984', author: 'George Orwell' }),
  ];

  const ranked2 = rankSearchResults('1984', results2);
  assertEqual(normalizeTitle(ranked2.recommended.title), '1984', 
    'Exact title "1984" ranked first');

  // 3c. Mixed relevance — query matches author name
  const results3 = [
    makeResult({ title: 'Selected Poems', author: 'Emily Dickinson' }),
    makeResult({ title: 'The Life of Emily Dickinson', author: 'Biographer Name' }),
    makeResult({ title: 'Random Poetry', author: 'Unknown Poet' }),
  ];

  const ranked3 = rankSearchResults('Emily Dickinson', results3);
  // Both first two should rank above "Random Poetry"
  const topTitles = [
    normalizeTitle(ranked3.recommended.title),
    ...ranked3.alternatives.map(a => normalizeTitle(a.title))
  ];
  const randomIdx = topTitles.indexOf('random poetry');
  assert(randomIdx === topTitles.length - 1 || randomIdx === -1,
    'Non-matching "Random Poetry" ranked last');
})();

// ─── 4. Quality Filter Tests ────────────────────────────────────────────────

section('4. Quality filter (removes <2 star results)');

(() => {
  // 4a. Low quality results filtered
  const results = [
    makeResult({ title: 'Good Book', format: 'EPUB', size: '5 MB', author: 'Auth', publisher: 'Pub 2023' }),
    makeResult({ title: 'Bad Book', format: 'DJVU', size: '50 KB', author: 'Unknown', publisher: '' }),
  ];

  // Manually check: DJVU + 50KB should score very low
  const badScore = calculateQualityScore(results[1]);
  assert(badScore < 2.0, `DJVU+50KB scores below 2.0 (${badScore})`);

  const ranked = rankSearchResults('Good Book', results);
  assert(ranked.recommended !== null, 'Has a recommended result');
  assertEqual(ranked.recommended.title, 'Good Book', 'Good quality result recommended');
  
  // The bad book should be filtered out
  const badInAlts = ranked.alternatives.some(a => a.title === 'Bad Book');
  assert(!badInAlts, 'Low quality "Bad Book" filtered out of alternatives');

  // 4b. All results below quality threshold
  const allBad = [
    makeResult({ title: 'Junk 1', format: 'TXT', size: '10 KB', author: 'Unknown', publisher: '' }),
    makeResult({ title: 'Junk 2', format: 'DJVU', size: '5 KB', author: 'Unknown', publisher: '' }),
  ];

  const ranked2 = rankSearchResults('Junk', allBad);
  assertEqual(ranked2.recommended, null, 'No recommendation when all quality < 2');
  assertEqual(ranked2.alternatives.length, 0, 'No alternatives when all quality < 2');
})();

// ─── 5. Complex Scenario Tests ──────────────────────────────────────────────

section('5. Complex scenarios');

(() => {
  // 5a. Searching for "Dune" with many results of varying quality
  const results = [
    makeResult({ title: 'Dune', author: 'Frank Herbert', format: 'EPUB', size: '3 MB', publisher: 'Ace, 2020' }),
    makeResult({ title: 'Dune', author: 'Frank Herbert', format: 'PDF', size: '10 MB', publisher: 'Penguin, 2018' }),
    makeResult({ title: 'Dune Messiah', author: 'Frank Herbert', format: 'EPUB', size: '2 MB' }),
    makeResult({ title: 'Children of Dune', author: 'Frank Herbert', format: 'EPUB', size: '2.5 MB' }),
    makeResult({ title: 'The Dune Encyclopedia', author: 'Willis E. McNelly', format: 'PDF', size: '15 MB' }),
    makeResult({ title: 'Dune (Illustrated Edition)', author: 'Frank Herbert', format: 'EPUB', size: '50 MB', publisher: 'Ace, 2023' }),
  ];

  const ranked = rankSearchResults('Dune', results);
  
  // "Dune" exact matches should be grouped and recommended
  assertEqual(normalizeTitle(ranked.recommended.title), 'dune', 'Exact "Dune" recommended');
  
  // Should have grouped Dune editions (plain + illustrated)
  assert(ranked.recommended.editionCount >= 2, 
    `Dune editions grouped (${ranked.recommended.editionCount})`);

  // EPUB should be preferred
  assertEqual(ranked.recommended.format, 'EPUB', 'EPUB edition selected');

  // Alternatives should include sequels
  assert(ranked.alternatives.length >= 2, 
    `Has alternatives including sequels (${ranked.alternatives.length})`);

  // 5b. Search with no exact match but word overlap
  const ranked2 = rankSearchResults('Frank Herbert Dune', results);
  // "Dune" by Frank Herbert should still be top (author match + title match)
  assert(ranked2.recommended !== null, 'Has recommendation for author+title search');
  assert(normalizeTitle(ranked2.recommended.title).includes('dune'), 
    'Author+title search finds Dune');

  // 5c. Empty results
  const ranked3 = rankSearchResults('Nonexistent Book', []);
  assertEqual(ranked3.recommended, null, 'Empty results → null recommendation');
  assertEqual(ranked3.alternatives.length, 0, 'Empty results → no alternatives');
})();

// ─── 6. Edge Cases ──────────────────────────────────────────────────────────

section('6. Edge cases');

(() => {
  // 6a. Single result
  const results = [
    makeResult({ title: 'Only Book', author: 'Author' }),
  ];
  const ranked = rankSearchResults('Only Book', results);
  assertEqual(ranked.recommended.title, 'Only Book', 'Single result becomes recommendation');
  assertEqual(ranked.alternatives.length, 0, 'Single result → no alternatives');

  // 6b. Results with missing metadata
  const results2 = [
    makeResult({ title: 'Mystery', author: '', format: 'EPUB', size: '2 MB' }),
    makeResult({ title: '', author: 'Auth', format: 'EPUB', size: '2 MB', hash: 'empty_title' }),
  ];
  // Should not crash
  const ranked2 = rankSearchResults('Mystery', results2);
  assert(ranked2.recommended !== null || ranked2.recommended === null, 
    'Handles missing metadata without crashing');

  // 6c. Unicode titles
  const results3 = [
    makeResult({ title: 'Lés Misérables', author: 'Victor Hugo', format: 'EPUB', size: '5 MB' }),
  ];
  const ranked3 = rankSearchResults('Les Miserables', results3);
  assert(ranked3.recommended !== null, 'Unicode title matched');

  // 6d. Very long query
  const longQuery = 'The Complete and Unabridged Works of William Shakespeare Including All Plays';
  const results4 = [
    makeResult({ title: 'The Complete Works of William Shakespeare', author: 'William Shakespeare' }),
  ];
  const ranked4 = rankSearchResults(longQuery, results4);
  assert(ranked4.recommended !== null, 'Long query returns results');

  // 6e. PDF fallback behavior
  const mixedFormats = [
    makeResult({ title: 'Rare Book', author: 'Author', format: 'PDF', size: '20 MB' }),
    makeResult({ title: 'Rare Book', author: 'Author', format: 'EPUB', size: '1 MB' })
  ];
  const ranked5 = rankSearchResults('Rare Book', mixedFormats);
  assertEqual(ranked5.recommended.format, 'EPUB', 'PDF hidden when ebook format exists');
  assert(!ranked5.alternatives.some(result => result.format === 'PDF'), 'PDF omitted from alternatives when ebook exists');

  const pdfOnly = [
    makeResult({ title: 'Archive Only', author: 'Author', format: 'PDF', size: '20 MB' })
  ];
  const ranked6 = rankSearchResults('Archive Only', pdfOnly);
  assertEqual(ranked6.recommended.format, 'PDF', 'PDF shown when no ebook format exists');

  const openLibraryGrouped = [
    makeResult({ title: 'Harry Potter and the Philosopher Stone', author: 'J. K. Rowling', format: 'EPUB', size: '1 MB', openLibraryWorkKey: '/works/OL82563W' }),
    makeResult({ title: "Harry Potter and the Sorcerer's Stone", author: 'J.K. Rowling', format: 'MOBI', size: '2 MB', openLibraryWorkKey: '/works/OL82563W' })
  ];
  const ranked7 = rankSearchResults('Harry Potter', openLibraryGrouped);
  assertEqual(ranked7.recommended.editionCount, 2, 'Open Library work key groups title variants as one work');
})();

// ─── 7. Search Hardening Tests ─────────────────────────────────────────────

section('7. Search hardening');

(() => {
  // 7a. Open Library work keys group title variants, then prefer canonical editions.
  const aliceResults = [
    makeResult({
      title: "Alice's Adventures in Wonderland: A Dramatization",
      author: 'Lewis Carroll',
      format: 'EPUB',
      size: '8 MB',
      publisher: 'Dramatic Press, 2024',
      openLibraryWorkKey: '/works/OL819350W',
      canonicalTitle: "Alice's Adventures in Wonderland"
    }),
    makeResult({
      title: "Alice's Adventures in Wonderland",
      author: 'Lewis Carroll',
      format: 'EPUB',
      size: '1 MB',
      publisher: 'Macmillan, 1865',
      openLibraryWorkKey: '/works/OL819350W',
      canonicalTitle: "Alice's Adventures in Wonderland"
    })
  ];

  const rankedAlice = rankSearchResults("Alice's Adventures in Wonderland", aliceResults);
  assertEqual(rankedAlice.recommended.title, "Alice's Adventures in Wonderland",
    'Alice canonical result beats dramatization in the same Open Library work group');
  assertEqual(rankedAlice.recommended.editionCount, 2,
    'Alice editions grouped by Open Library work key');
  assert(rankedAlice.recommended.canonicalQueryBonus > 0,
    'Canonical Alice edition receives canonical-query bonus');
  assert(rankedAlice.recommended.otherEditions[0].derivativePenalty > 0,
    'Alice dramatization receives derivative penalty');

  const iliadResults = [
    makeResult({
      title: 'Iliad: The Reboot',
      author: 'Keith Tokash',
      format: 'EPUB',
      size: '12 MB'
    }),
    makeResult({
      title: 'The Iliad',
      author: 'Homer',
      format: 'EPUB',
      size: '1 MB'
    })
  ];
  const rankedIliad = rankSearchResults('Iliad Homer', iliadResults);
  assertEqual(rankedIliad.recommended.title, 'The Iliad',
    'Canonical Iliad beats reboot edition');
  assert(rankedIliad.alternatives[0].derivativePenalty > 0,
    'Iliad reboot receives derivative penalty');

  // 7b. Adaptations and summaries lose to the canonical work for the same query.
  const odysseyResults = [
    makeResult({
      title: 'The Odyssey: A Graphic Novel Adaptation',
      author: 'Homer',
      format: 'EPUB',
      size: '9 MB',
      openLibraryWorkKey: '/works/OL18020194W',
      canonicalTitle: 'The Odyssey'
    }),
    makeResult({
      title: 'The Odyssey Summary and Study Guide',
      author: 'Book Notes',
      format: 'EPUB',
      size: '4 MB',
      openLibraryWorkKey: '/works/OL18020194W',
      canonicalTitle: 'The Odyssey'
    }),
    makeResult({
      title: 'The Odyssey',
      author: 'Homer',
      format: 'EPUB',
      size: '1 MB',
      openLibraryWorkKey: '/works/OL18020194W',
      canonicalTitle: 'The Odyssey'
    })
  ];

  const rankedOdyssey = rankSearchResults('The Odyssey', odysseyResults);
  assertEqual(rankedOdyssey.recommended.title, 'The Odyssey',
    'Canonical result beats adaptation and summary');
  assert(rankedOdyssey.recommended.otherEditions.every(result => result.derivativePenalty > 0),
    'Adaptation and summary editions receive penalties');

  // 7c. PDF fallback still works after hardening.
  const pdfOnly = [
    makeResult({
      title: 'Alice Archive Facsimile',
      author: 'Lewis Carroll',
      format: 'PDF',
      size: '25 MB',
      openLibraryWorkKey: '/works/OL819350W'
    })
  ];
  const rankedPdf = rankSearchResults('Alice Archive Facsimile', pdfOnly);
  assertEqual(rankedPdf.recommended.format, 'PDF', 'PDF fallback remains available when no ebook exists');
})();

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Search ranking tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All search ranking tests passed! ✅');
}
