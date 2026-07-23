const {
  canonicalWorkTitle,
  buildSearchWorks,
  applySearchIntent
} = require('../lib/search-work-groups');
const { fallbackCompatibility } = require('../lib/search-work-resolution');
const hemingwayCrossSourceResults = require('./fixtures/hemingway-cross-source-results.json');
const crossSourcePublicResults = require('./fixtures/cross-source-public-results.json');

let passed = 0;
let failed = 0;
let editionId = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function equal(actual, expected, message) {
  assert(actual === expected, `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function edition(overrides = {}) {
  return {
    hash: `edition-${overrides.id || ++editionId}`,
    source: 'fixture',
    title: 'Fixture Work',
    author: 'Fixture Author',
    format: 'EPUB',
    qualityScore: 4,
    relevanceScore: 10,
    _year: 2020,
    ...overrides
  };
}

function compareEdition(a, b) {
  const formatRank = format => ({ EPUB: 0, MOBI: 1, PDF: 9 })[format] ?? 5;
  return formatRank(a.format) - formatRank(b.format) ||
    Number(b.qualityScore) - Number(a.qualityScore) ||
    Number(b._year) - Number(a._year);
}

console.log('\n━━━ Work-first search grouping ━━━');

(() => {
  const works = buildSearchWorks(hemingwayCrossSourceResults, { compareEditions: compareEdition });
  const collection = works.find(work => work.title === 'Complete Works of Ernest Hemingway');
  equal(works.length, 2, 'Clear cross-source collection aliases merge without absorbing a constituent volume');
  equal(collection?.editionCount, 6, 'All six provider versions remain selectable in the merged collection');
  equal(collection?.sourceCount, 2, 'The merged collection reports both acquisition sources');
  const fallback = fallbackCompatibility(
    hemingwayCrossSourceResults[0],
    hemingwayCrossSourceResults[6]
  );
  equal(fallback.safe, false, 'A constituent volume sharing the collection ISBN is not an automatic fallback');
  const reversed = buildSearchWorks([...hemingwayCrossSourceResults].reverse(), { compareEditions: compareEdition });
  equal(
    JSON.stringify(reversed.map(work => ({ id: work.id, title: work.title, hashes: work.editions.map(item => item.hash) }))),
    JSON.stringify(works.map(work => ({ id: work.id, title: work.title, hashes: work.editions.map(item => item.hash) }))),
    'Work resolution is deterministic across provider response order'
  );
  equal(
    buildSearchWorks(hemingwayCrossSourceResults, { compareEditions: compareEdition, resolutionMode: 'exact' }).length,
    4,
    'Exact grouping mode disables corroborated publisher aliases as an operator escape hatch'
  );
})();

(() => {
  const works = buildSearchWorks(crossSourcePublicResults, { compareEditions: compareEdition });
  equal(works.length, 2, 'Resolver behavior is provider-agnostic across public and operator-configured sources');
  equal(works.find(work => work.title === 'Pride and Prejudice')?.sourceCount, 2, 'Standard Ebooks and Gutenberg versions resolve together');
  equal(works.find(work => work.title === 'Frankenstein')?.sourceCount, 2, 'Internet Archive and OPDS versions resolve together');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'dubliners-random-house',
      source: 'zlibrary',
      title: 'Dubliners',
      author: 'James Joyce',
      publisher: 'Random House Publishing Group'
    }),
    edition({
      id: 'dubliners-oxford-classics',
      source: 'zlibrary',
      title: "Dubliners (Oxford World's Classics)",
      author: 'James Joyce',
      publisher: 'Oxford University Press'
    }),
    edition({
      id: 'dubliners-author-preferred',
      source: 'zlibrary',
      title: "Dubliners (Author's Preferred)",
      author: 'James Joyce',
      publisher: 'Joyce Estate'
    })
  ], { compareEditions: compareEdition });
  equal(works.length, 1, 'Every recognized edition label normalizes in both suffix and parenthetical forms');
  equal(works[0]?.versionCount, 3, 'All Dubliners versions remain selectable after grouping');
  equal(works[0]?.title, 'Dubliners', 'The grouped work keeps the clean title');
  equal(
    canonicalWorkTitle('Dubliners — Oxford World’s Classics'),
    'dubliners',
    'Publisher-series suffixes normalize curly apostrophes'
  );
  equal(
    canonicalWorkTitle('The Modern Library'),
    'the modern library',
    'A publisher-series name used as a complete title is not stripped'
  );
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'live-dubliners-authority', source: 'annas', title: 'Dubliners', author: 'Joyce, James',
      publisher: 'Amazon Classics, 2017', language: 'English', openLibraryWorkKey: '/works/OL86320W',
      metadataConfidence: { source: 'openlibrary', score: 0.75, level: 'high' }
    }),
    edition({
      id: 'live-dubliners-modern-library', source: 'annas', title: 'Dubliners (Modern Library)',
      author: 'James Joyce; John Banville', publisher: 'Random House Publishing Group, 2012;2000',
      language: 'English', openLibraryWorkKey: '/works/OL36770928W',
      metadataConfidence: { source: 'openlibrary', score: 0.75, level: 'high' }
    }),
    edition({
      id: 'live-dubliners-jj', source: 'annas', title: 'Dubliners', author: 'JJ',
      publisher: '2012', language: 'English'
    }),
    edition({
      id: 'live-dubliners-wrong-initials', source: 'annas', title: 'Dubliners', author: 'JQ',
      publisher: '2012', language: 'English'
    }),
    edition({
      id: 'live-dubliners-byline', source: 'annas', title: 'DUBLINERS BY JAMES JOYCE',
      author: 'James Joyce & chenjin5.com', publisher: 'chenjin5.com, 2011', language: 'English'
    }),
    edition({
      id: 'live-dubliners-filename', source: 'annas', title: 'James Joyce_Dubliners',
      author: 'Joyce, James', publisher: "Pandora's Box, 2021", language: 'English'
    }),
    edition({
      id: 'live-dubliners-combined-work', source: 'annas',
      title: 'A Portrait of the Artist as a Young Man (a novel) and Dubliners (short stories)',
      author: 'James Joyce', publisher: 'Barnes & Noble Books, 2004', language: 'English'
    })
  ], { compareEditions: compareEdition });
  const dubliners = works.find(work => work.editions.some(item => item.hash === 'edition-live-dubliners-authority'));
  equal(works.length, 3, 'Live Dubliners metadata resolves safe edition, byline, filename, and creator-initial aliases');
  equal(dubliners?.versionCount, 5, 'All five live Dubliners alias forms remain selectable versions');
  equal(dubliners?.title, 'Dubliners', 'Noisy live aliases retain the clean Dubliners display title');
  equal(
    works.find(work => work.editions.some(item => item.hash === 'edition-live-dubliners-combined-work'))?.versionCount,
    1,
    'A combined work mentioning Dubliners remains separate'
  );
  equal(
    works.find(work => work.editions.some(item => item.hash === 'edition-live-dubliners-wrong-initials'))?.versionCount,
    1,
    'Non-matching compressed creator initials remain separate'
  );
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'live-portrait-contents-labels', source: 'annas',
      title: 'A Portrait of the Artist as a Young Man (a novel) and Dubliners (short stories)',
      author: 'James Joyce, with an Introduction and Notes by Kevin J. H. Dettmar',
      publisher: 'Barnes & Noble Books, Barnes & Noble Classics, 1, 2004', language: 'English'
    }),
    edition({
      id: 'live-portrait-classics', source: 'annas',
      title: 'A Portrait of the Artist as a Young Man and Dubliners (Barnes & Noble Classics)',
      author: 'Joyce, James',
      publisher: 'Barnes & Noble Classics; Sterling, Barnes & Noble classics, New York, 2004', language: 'English'
    }),
    edition({
      id: 'live-portrait-classics-series', source: 'annas',
      title: 'Portrait of the Artist as a Young Man and Dubliners (Barnes & Noble Classics Series)',
      author: 'James Joyce', publisher: 'Barnes & Noble, 2010', language: 'English'
    }),
    edition({
      id: 'live-portrait-standalone', source: 'annas',
      title: 'A Portrait of the Artist as a Young Man', author: 'James Joyce', language: 'English'
    }),
    edition({
      id: 'live-portrait-collected-works', source: 'annas',
      title: 'The Collected Works of James Joyce: Dubliners + A Portrait of the Artist as a Young Man + Ulysses',
      author: 'James Joyce', language: 'English'
    })
  ], { compareEditions: compareEdition });
  const compilationIds = new Set(works
    .filter(work => work.editions.some(item => item.hash === 'edition-live-portrait-contents-labels' ||
      item.hash === 'edition-live-portrait-classics' ||
      item.hash === 'edition-live-portrait-classics-series'))
    .map(work => work.id));
  equal(compilationIds.size, 1, 'Provider descriptions of the same multi-title edition resolve to one work');
  equal(
    works.find(work => work.editions.some(item => item.hash === 'edition-live-portrait-contents-labels'))?.versionCount,
    3,
    'All Barnes & Noble compilation versions remain selectable'
  );
  equal(
    works.find(work => work.editions.some(item => item.hash === 'edition-live-portrait-standalone'))?.versionCount,
    1,
    'A standalone constituent is not absorbed by its compilation'
  );
  equal(
    works.find(work => work.editions.some(item => item.hash === 'edition-live-portrait-collected-works'))?.versionCount,
    1,
    'A broader collected works volume remains separate'
  );

  const publisherMismatch = buildSearchWorks([
    edition({
      id: 'publisher-label-mismatch', source: 'annas', title: 'The Stand (Example House Classics)',
      author: 'Stephen King', publisher: 'Different Press'
    }),
    edition({
      id: 'publisher-label-base', source: 'annas', title: 'The Stand',
      author: 'Stephen King', publisher: 'Example House'
    })
  ], { compareEditions: compareEdition });
  equal(publisherMismatch.length, 2, 'A parenthetical label cannot be removed when publisher metadata contradicts it');

  const articleOnly = buildSearchWorks([
    edition({ id: 'leading-article', source: 'annas', title: 'The Stand', author: 'Stephen King' }),
    edition({ id: 'missing-leading-article', source: 'annas', title: 'Stand', author: 'Stephen King' })
  ], { compareEditions: compareEdition });
  equal(articleOnly.length, 2, 'Leading articles are not ignored for ordinary titles');
})();

(() => {
  const targetHashes = new Set([
    'edition-live-habits-canonical',
    'edition-live-habits-malformed-author',
    'edition-live-habits-subtitle',
    'edition-live-habits-extended-subtitle',
    'edition-live-habits-restoring-subtitle',
    'edition-live-habits-word-number',
    'edition-live-habits-trailing-author',
    'edition-live-habits-word-number-subtitle',
    'edition-live-habits-snapshots-edition',
    'edition-live-habits-damaged-title',
    'edition-live-habits-anniversary'
  ]);
  const works = buildSearchWorks([
    edition({
      id: 'live-habits-canonical', source: 'annas', title: 'The 7 Habits of Highly Effective People',
      author: 'Stephen R. Covey', publisher: 'RosettaBooks, 2016', language: 'English',
      openLibraryWorkKey: '/works/OL2629977W', openLibraryTitle: 'The 7 Habits of Highly Effective People',
      openLibraryAuthor: 'Stephen R. Covey',
      metadataConfidence: { source: 'openlibrary', score: 0.75, level: 'high' }
    }),
    edition({
      id: 'live-habits-malformed-author', source: 'annas', title: 'the 7 habits of highly effective people',
      author: 'R.Covey, Stephen', publisher: '2010', language: 'English',
      openLibraryWorkKey: '/works/OL2629977W', openLibraryTitle: 'The 7 Habits of Highly Effective People',
      openLibraryAuthor: 'Stephen R. Covey',
      metadataConfidence: { source: 'openlibrary', score: 0.75, level: 'high' }
    }),
    edition({
      id: 'live-habits-subtitle', source: 'annas',
      title: 'The 7 Habits of Highly Effective People: Powerful Lessons in Personal Change',
      author: 'Stephen R. Covey', publisher: 'RosettaBooks, 2013', language: 'English'
    }),
    edition({
      id: 'live-habits-extended-subtitle', source: 'annas',
      title: 'The 7 Habits of Highly Effective People: Powerful Lessons in Personal Change: Restoring the Character Ethic',
      author: 'Stephen R. Covey', publisher: 'Free Press, Revised edition, 2004', language: 'English'
    }),
    edition({
      id: 'live-habits-restoring-subtitle', source: 'annas',
      title: 'The 7 Habits of Highly Effective People: Restoring the Character Ethic',
      author: 'Stephen R. Covey', publisher: 'RosettaBooks, 2013', language: 'English'
    }),
    edition({
      id: 'live-habits-word-number', source: 'zlibrary',
      title: 'Seven habits of highly effective people',
      author: 'Stephen R. Covey', publisher: 'Free Press', language: 'English'
    }),
    edition({
      id: 'live-habits-trailing-author', source: 'zlibrary',
      title: 'Seven Habits of Highly Effective People, Stephen R. Covey',
      author: 'Covey, Stephen R', language: 'English'
    }),
    edition({
      id: 'live-habits-word-number-subtitle', source: 'zlibrary',
      title: 'The seven habits of highly effective people: restoring the character ethic',
      author: 'Stephen R Covey', publisher: 'Simon and Schuster', language: 'English'
    }),
    edition({
      id: 'live-habits-snapshots-edition', source: 'annas',
      title: 'The 7 Habits of Highly Effective People · New Snapshots Edition',
      author: 'Covey, Stephen R.', publisher: 'Mango Media Inc, 1989', language: 'English'
    }),
    edition({
      id: 'live-habits-damaged-title', source: 'annas', title: '7 Habits Effective Pople',
      author: 'Covey, Stephen', publisher: '0', language: 'English'
    }),
    edition({
      id: 'live-habits-anniversary', source: 'zlibrary',
      title: 'The 7 Habits of Highly Effective People - 25th Anniversary Edition',
      author: 'Stephen R. Covey', language: 'English'
    }),
    edition({
      id: 'live-habits-workbook', source: 'annas',
      title: 'The 7 Habits of Highly Effective People Personal Workbook',
      author: 'Stephen R. Covey', language: 'English'
    }),
    edition({
      id: 'live-habits-thoughts', source: 'annas', title: 'The 7 Habits Thoughts on Abundance',
      author: 'Stephen R. Covey', language: 'English'
    }),
    edition({
      id: 'live-habits-families', source: 'annas', title: 'The 7 Habits of Highly Effective Families',
      author: 'Stephen R. Covey', language: 'English'
    })
  ], { compareEditions: compareEdition });
  const targetWorks = works.filter(work => work.editions.some(item => targetHashes.has(item.hash)));
  equal(targetWorks.length, 1, 'Catalog, subtitle, anniversary, and bounded damaged-title variants resolve to one work object');
  equal(targetWorks[0]?.versionCount, 11, 'Every live Seven Habits base-work variant remains selectable');
  for (const id of ['live-habits-workbook', 'live-habits-thoughts', 'live-habits-families']) {
    equal(
      works.find(work => work.editions.some(item => item.hash === `edition-${id}`))?.versionCount,
      1,
      `${id.replace('live-habits-', '')} remains a separate work`
    );
  }
  const damagedPair = [
    edition({ id: 'habits-exact-mode-base', title: 'The 7 Habits of Highly Effective People', author: 'Stephen R. Covey' }),
    edition({ id: 'habits-exact-mode-damaged', title: '7 Habits Effective Pople', author: 'Stephen Covey' })
  ];
  equal(
    buildSearchWorks(damagedPair, { compareEditions: compareEdition, resolutionMode: 'exact' }).length,
    2,
    'Exact grouping mode disables bounded provider-damage repair'
  );
  equal(
    fallbackCompatibility(damagedPair[0], damagedPair[1]).safe,
    false,
    'A damaged-title match is selectable but never an automatic import fallback'
  );
})();

(() => {
  const variants = [
    edition({ id: 'slaughterhouse-canonical', source: 'annas', title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut' }),
    edition({ id: 'slaughterhouse-typo', source: 'zlibrary', title: 'Slaugterhouse-Five', author: 'Kurt Vonnegut' })
  ];
  const works = buildSearchWorks(variants, { compareEditions: compareEdition });
  equal(works.length, 1, 'A single long-token typo resolves across sources when the primary creator matches');
  equal(buildSearchWorks([...variants].reverse(), { compareEditions: compareEdition })[0].id, works[0].id, 'Fuzzy title resolution is deterministic across provider response order');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'shack-canonical-spelling', source: 'annas', title: 'The Shack', author: 'William P. Young' }),
    edition({ id: 'shack-transposition', source: 'zlibrary', title: 'The Shcak', author: 'William P. Young' })
  ], { compareEditions: compareEdition });
  equal(works.length, 1, 'An adjacent transposition in a meaningful title token resolves across sources');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'shack-real-word', source: 'annas', title: 'The Shack', author: 'Example Author' }),
    edition({ id: 'shock-real-word', source: 'zlibrary', title: 'The Shock', author: 'Example Author' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A short same-length word substitution does not merge two plausible titles');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'dune-singular', source: 'annas', title: 'Dune', author: 'Example Author' }),
    edition({ id: 'dunes-plural', source: 'zlibrary', title: 'Dunes', author: 'Example Author' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A one-character change to a short title never triggers fuzzy grouping');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'typo-author-one', source: 'annas', title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut' }),
    edition({ id: 'typo-author-two', source: 'zlibrary', title: 'Slaugterhouse-Five', author: 'Chris Huber' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A title typo cannot override conflicting primary creators');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'same-source-canonical', source: 'annas', title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut' }),
    edition({ id: 'same-source-typo', source: 'annas', title: 'Slaugterhouse-Five', author: 'Kurt Vonnegut' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Fuzzy title evidence requires cross-source corroboration');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'two-errors-canonical', source: 'annas', title: 'Slaughterhouse-Five Complete', author: 'Kurt Vonnegut' }),
    edition({ id: 'two-errors-variant', source: 'zlibrary', title: 'Slaugterhouse-Five Complet', author: 'Kurt Vonnegut' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Two changed title tokens remain separate even when both edits are small');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'exact-mode-canonical', source: 'annas', title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut' }),
    edition({ id: 'exact-mode-typo', source: 'zlibrary', title: 'Slaugterhouse-Five', author: 'Kurt Vonnegut' })
  ], { compareEditions: compareEdition, resolutionMode: 'exact' });
  equal(works.length, 2, 'Exact grouping mode disables fuzzy title resolution');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'hemingway-author-canonical', source: 'annas', title: 'The Old Man and the Sea', author: 'Ernest Hemingway' }),
    edition({ id: 'hemingway-author-typo', source: 'zlibrary', title: 'The Old Man and the Sea', author: 'Ernest Hemingawy' })
  ], { compareEditions: compareEdition });
  equal(works.length, 1, 'An exact title plus a single transposed author token resolves across sources');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'andersen-shared-title', source: 'annas', title: 'A Shared Title', author: 'Hans Andersen' }),
    edition({ id: 'anderson-shared-title', source: 'zlibrary', title: 'A Shared Title', author: 'Hans Anderson' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A one-letter author substitution remains a distinct creator');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'double-typo-canonical', source: 'annas', title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut' }),
    edition({ id: 'double-typo-variant', source: 'zlibrary', title: 'Slaugterhouse-Five', author: 'Kurt Vonnegutt' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Independent fuzzy title and creator evidence cannot combine into a merge');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'author-exact-mode-canonical', source: 'annas', title: 'The Old Man and the Sea', author: 'Ernest Hemingway' }),
    edition({ id: 'author-exact-mode-typo', source: 'zlibrary', title: 'The Old Man and the Sea', author: 'Ernest Hemingawy' })
  ], { compareEditions: compareEdition, resolutionMode: 'exact' });
  equal(works.length, 2, 'Exact grouping mode disables fuzzy creator resolution');
})();

(() => {
  const variants = [
    edition({ id: 'shack-initial', source: 'annas', title: 'The Shack', author: 'Young, William P.', language: 'en', openLibraryWorkKey: '/works/OL4417939W' }),
    edition({ id: 'shack-middle-name', source: 'annas', title: 'The Shack', author: 'Young, William Paul', language: 'en', openLibraryWorkKey: '/works/OL4417939W' }),
    edition({ id: 'shack-given-abbreviation', source: 'zlibrary', title: 'The Shack', author: 'Wm. Paul Young', language: 'en' }),
    edition({ id: 'shack-official-subtitle', source: 'annas', title: 'The Shack: Where Tragedy Confronts Eternity', author: 'William P Young; Jake Colsen', language: 'en' })
  ];
  const works = buildSearchWorks([
    ...variants,
    edition({ id: 'shack-other-author', source: 'annas', title: 'The Shack', author: 'Thomas Mulholland', language: 'en' }),
    edition({ id: 'shack-guide', source: 'zlibrary', title: 'The Shack: A Study Guide', author: 'William P. Young', language: 'en' }),
    edition({ id: 'shack-part-two', source: 'zlibrary', title: 'The Shack: Part 2', author: 'William P. Young', language: 'en' })
  ], { compareEditions: compareEdition });
  const resolved = works.find(work => work.editions.some(item => item.hash === 'edition-shack-initial'));
  equal(resolved?.editionCount, 4, 'Initials, conventional given-name abbreviations, and official subtitles resolve as one work');
  const reversed = buildSearchWorks([...variants].reverse(), { compareEditions: compareEdition })[0];
  equal(reversed?.id, resolved?.id, 'Creator and subtitle alias resolution is deterministic across provider response order');
  equal(works.find(work => work.editions.some(item => item.hash === 'edition-shack-other-author'))?.editionCount, 1, 'A different creator with the same title remains separate');
  equal(works.find(work => work.editions.some(item => item.hash === 'edition-shack-guide'))?.editionCount, 1, 'A derivative subtitle remains separate from the original work');
  equal(works.find(work => work.editions.some(item => item.hash === 'edition-shack-part-two'))?.editionCount, 1, 'A numbered subtitle remains separate from the unnumbered work');
  equal(fallbackCompatibility(variants[2], variants[3]).safe, true, 'Compatible creator and official-subtitle aliases are safe automatic alternatives');
})();

(() => {
  const conflictingNames = buildSearchWorks([
    edition({ id: 'middle-james', title: 'Shared Name Work', author: 'William James Young' }),
    edition({ id: 'middle-paul', title: 'Shared Name Work', author: 'William Paul Young' })
  ], { compareEditions: compareEdition });
  equal(conflictingNames.length, 2, 'Conflicting full middle names are not treated as author aliases');

  const bibliographicAbbreviation = buildSearchWorks([
    edition({ id: 'dickens-abbreviated', title: 'A Tale of Two Cities', author: 'Chas. Dickens' }),
    edition({ id: 'dickens-full', title: 'A Tale of Two Cities', author: 'Charles Dickens' })
  ], { compareEditions: compareEdition });
  equal(bibliographicAbbreviation.length, 1, 'Conventional bibliographic given-name abbreviations resolve to the full creator name');

  const givenInitial = buildSearchWorks([
    edition({ id: 'rowling-initial', title: 'Example Wizarding Work', author: 'J. K. Rowling' }),
    edition({ id: 'rowling-full', title: 'Example Wizarding Work', author: 'Joanne K. Rowling' })
  ], { compareEditions: compareEdition });
  equal(givenInitial.length, 1, 'Given-name initials resolve to compatible full creator names');

  const siblingSubtitles = buildSearchWorks([
    edition({ id: 'chronicle-dawn', source: 'annas', title: 'Example Chronicle: Dawn', author: 'Example Author', publisher: 'Example House' }),
    edition({ id: 'chronicle-dusk', source: 'zlibrary', title: 'Example Chronicle: Dusk', author: 'Example Author', publisher: 'Example House' })
  ], { compareEditions: compareEdition });
  equal(siblingSubtitles.length, 2, 'Two different subtitles do not merge without an unsuffixed title record');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'shared-work-en', title: 'The Stranger', author: 'Albert Camus', language: 'en', openLibraryWorkKey: '/works/OL1W' }),
    edition({ id: 'shared-work-fr', title: 'The Stranger', author: 'Albert Camus', language: 'fr', openLibraryWorkKey: '/works/OL1W' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Known different languages remain separate even under a shared catalog work key');
})();

(() => {
  const collection = edition({
    id: 'authority-collection', title: 'Complete Works of Ernest Hemingway', author: 'Ernest Hemingway',
    language: 'en', openLibraryWorkKey: '/works/OL-COLLECTION'
  });
  const individual = edition({
    id: 'authority-individual', title: 'The Sun Also Rises', author: 'Ernest Hemingway',
    language: 'en', openLibraryWorkKey: '/works/OL-COLLECTION'
  });
  const works = buildSearchWorks([collection, individual], { compareEditions: compareEdition });
  equal(works.length, 2, 'A collection and individual title remain separate despite a shared catalog key');
  equal(fallbackCompatibility(collection, individual).safe, false, 'A collection cannot automatically fall back to an individual title');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'shared-series-one', title: 'Collected Stories, Volume 1', author: 'Example Author', language: 'en', openLibraryWorkKey: '/works/OL2W' }),
    edition({ id: 'shared-series-two', title: 'Collected Stories, Volume 2', author: 'Example Author', language: 'en', openLibraryWorkKey: '/works/OL2W' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Different numbered volumes remain separate despite a shared catalog work key');
})();

(() => {
  const unknown = edition({ id: 'abridgement-unknown', title: 'A Farewell to Arms', author: 'Ernest Hemingway', language: 'en' });
  const explicitFull = edition({ id: 'abridgement-full', title: 'A Farewell to Arms (Unabridged Edition)', author: 'Ernest Hemingway', language: 'en' });
  const works = buildSearchWorks([unknown, explicitFull], { compareEditions: compareEdition });
  equal(works.length, 1, 'Unknown and explicitly unabridged versions remain manually selectable under one work');
  equal(new Set(works[0].editions.map(item => item.fallbackGroupId)).size, 2, 'Unknown and explicitly unabridged versions use different fallback groups');
  equal(fallbackCompatibility(unknown, explicitFull).safe, false, 'Unknown abridgement state cannot automatically replace an explicitly unabridged version');
})();

(() => {
  const diagnostics = [];
  buildSearchWorks([
    edition({ id: 'diagnostic-left', title: 'Delphi Diagnostic Work', author: 'Example Author', source: 'annas', publisher: 'Delphi Classics', isbn: ['9781786560360'] }),
    edition({ id: 'diagnostic-right', title: 'Diagnostic Work', author: 'Example Author', source: 'zlibrary', publisher: 'Delphi Classics', isbn: ['9781786560360'] })
  ], { compareEditions: compareEdition, diagnostics });
  equal(
    JSON.stringify(diagnostics.find(item => item.type === 'merged')?.sources),
    JSON.stringify(['annas', 'zlibrary']),
    'Opt-in resolution diagnostics identify the involved source IDs'
  );
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'alias-base-annas', source: 'annas', title: 'Diagnostic Work', author: 'Example Author', publisher: 'Delphi Classics' }),
    edition({ id: 'alias-base-zlib', source: 'zlibrary', title: 'Diagnostic Work', author: 'Example Author', publisher: 'Delphi Classics' }),
    edition({ id: 'alias-overlap-annas', source: 'annas', title: 'Delphi Classics Diagnostic Work', author: 'Example Author', publisher: 'Delphi Classics' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A publisher alias cannot borrow cross-source corroboration from an exact group containing the same source');
})();

(() => {
  const sharedNoise = {
    author: 'Example Author', publisher: 'Example Publishing', isbn: ['9781786560360'],
    size: '2 MB', _year: 2024, coverUrl: '/api/search-cover/0123456789abcdef0123456789abcdef'
  };
  const works = buildSearchWorks([
    edition({ id: 'noise-one', ...sharedNoise, source: 'annas', title: 'First Distinct Work' }),
    edition({ id: 'noise-two', ...sharedNoise, source: 'zlibrary', title: 'Second Distinct Work' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'ISBN, cover, publisher, year, and file size alone never merge distinct titles');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'ol-conflict-a', title: 'Shared Catalog Title', author: 'Example Author', openLibraryWorkKey: '/works/OL-A', metadataConfidence: { source: 'openlibrary', level: 'high' } }),
    edition({ id: 'ol-conflict-b', title: 'Shared Catalog Title', author: 'Example Author', openLibraryWorkKey: '/works/OL-B', metadataConfidence: { source: 'openlibrary', level: 'high' } })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Conflicting trusted Open Library keys prevent an otherwise exact merge');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'huxley-perennial-base', source: 'zlibrary', title: 'The Perennial Philosophy',
      author: 'Aldous Huxley', language: 'English', openLibraryWorkKey: '/works/OL64463W',
      openLibraryTitle: 'The perennial philosophy', openLibraryAuthor: 'Aldous Huxley',
      metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'huxley-perennial-ps', source: 'annas', title: 'The Perennial Philosophy (P.S.)',
      author: 'Aldous Huxley', language: 'English', openLibraryWorkKey: '/works/OL14992243W',
      openLibraryTitle: 'The Perennial Philosophy', openLibraryAuthor: 'Aldous Huxley',
      metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'versluis-perennial', source: 'zlibrary', title: 'Perennial Philosophy',
      author: 'Arthur Versluis', language: 'English'
    })
  ], { compareEditions: compareEdition });
  const huxley = works.find(work => work.author === 'Aldous Huxley');
  const versluis = works.find(work => work.author === 'Arthur Versluis');
  equal(works.length, 2, 'Duplicate authority keys for a recognized P.S. edition resolve without absorbing a different author');
  equal(huxley?.versionCount, 2, 'Both Huxley editions remain selectable under one work');
  equal(versluis?.versionCount, 1, 'The Versluis work with the same subject phrase remains separate');
})();

(() => {
  const variants = [
    edition({
      id: 'duplicate-authority-record-a', source: 'annas', title: 'First Provider Packaging Title',
      author: 'Example Author', language: 'English', openLibraryWorkKey: '/works/OL-DUPLICATE-A',
      openLibraryTitle: 'Canonical Authority Work', openLibraryAuthor: 'Example Author',
      metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'duplicate-authority-record-b', source: 'zlibrary', title: 'Second Provider Packaging Title',
      author: 'Example Author', language: 'English', openLibraryWorkKey: '/works/OL-DUPLICATE-B',
      openLibraryTitle: 'Canonical Authority Work', openLibraryAuthor: 'Example Author',
      metadataConfidence: { source: 'openlibrary', level: 'high' }
    })
  ];
  const works = buildSearchWorks(variants, { compareEditions: compareEdition });
  equal(works.length, 1, 'Conflicting authority IDs reconcile when their trusted title and creator identity agree exactly');
  equal(works[0]?.versionCount, 2, 'Reconciled duplicate authority records retain every provider version');
  equal(works[0]?.title, 'Canonical Authority Work', 'Reconciled duplicate authority records use the shared trusted title');
  equal(buildSearchWorks([...variants].reverse(), { compareEditions: compareEdition })[0]?.id, works[0]?.id, 'Duplicate-authority reconciliation is deterministic across provider response order');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'conflicting-authority-identity-a', title: 'Same Provider Title', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-CONFLICT-A', openLibraryTitle: 'First Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'conflicting-authority-identity-b', title: 'Same Provider Title', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-CONFLICT-B', openLibraryTitle: 'Second Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Matching provider text cannot override conflicting trusted authority identities');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'labeled-authority-conflict-a', title: 'Example Work', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-LABEL-CONFLICT-A', openLibraryTitle: 'First Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'labeled-authority-conflict-b', title: 'Example Work (P.S.)', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-LABEL-CONFLICT-B', openLibraryTitle: 'Second Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'An edition label cannot bypass conflicting trusted authority identities');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'ambiguous-authority-group-a1', title: 'First Provider Title', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-AMBIGUOUS-A', openLibraryTitle: 'Canonical Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'ambiguous-authority-group-a2', title: 'First Provider Title', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-AMBIGUOUS-A', openLibraryTitle: 'Conflicting Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    }),
    edition({
      id: 'ambiguous-authority-group-b', title: 'Second Provider Title', author: 'Example Author',
      openLibraryWorkKey: '/works/OL-AMBIGUOUS-B', openLibraryTitle: 'Canonical Authority Work',
      openLibraryAuthor: 'Example Author', metadataConfidence: { source: 'openlibrary', level: 'high' }
    })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'An authority group with multiple trusted identities cannot reconcile with another key');
})();

(() => {
  const pair = (left = {}, right = {}) => buildSearchWorks([
    edition({
      id: 'authority-boundary-a', title: 'First Provider Packaging Title', author: 'Example Author',
      language: 'English', openLibraryWorkKey: '/works/OL-BOUNDARY-A',
      openLibraryTitle: 'Canonical Authority Work', openLibraryAuthor: 'Example Author',
      metadataConfidence: { source: 'openlibrary', level: 'high' }, ...left
    }),
    edition({
      id: 'authority-boundary-b', title: 'Second Provider Packaging Title', author: 'Example Author',
      language: 'English', openLibraryWorkKey: '/works/OL-BOUNDARY-B',
      openLibraryTitle: 'Canonical Authority Work', openLibraryAuthor: 'Example Author',
      metadataConfidence: { source: 'openlibrary', level: 'high' }, ...right
    })
  ], { compareEditions: compareEdition });

  equal(pair({}, { language: 'French' }).length, 2, 'A language conflict blocks duplicate-authority reconciliation');
  equal(pair({ title: 'Provider Work Volume 1' }, { title: 'Provider Work Volume 2' }).length, 2, 'A volume conflict blocks duplicate-authority reconciliation');
  equal(pair({ title: 'Complete Works of Example Author' }).length, 2, 'A collection-scope conflict blocks duplicate-authority reconciliation');
  equal(pair({}, { title: 'Second Provider Study Guide' }).length, 2, 'A derivative conflict blocks duplicate-authority reconciliation');
  equal(pair({}, { title: 'Second Provider Graphic Novel' }).length, 2, 'An adaptation conflict blocks duplicate-authority reconciliation');
  equal(pair({}, { author: 'Different Author' }).length, 2, 'A provider-creator conflict blocks duplicate-authority reconciliation');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'unscored-key-one', source: 'annas', title: 'First Distinct Work', author: 'Example Author', openLibraryWorkKey: '/works/OL-UNSCORED', metadataConfidence: null }),
    edition({ id: 'unscored-key-two', source: 'zlibrary', title: 'Second Distinct Work', author: 'Example Author', openLibraryWorkKey: '/works/OL-UNSCORED', metadataConfidence: null })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'An unscored Open Library key is not authoritative work identity evidence');
})();

(() => {
  const original = edition({ id: 'derivative-original', title: 'Example Novel', author: 'Example Author', openLibraryWorkKey: '/works/OL-DERIVATIVE' });
  const guide = edition({ id: 'derivative-guide', title: 'Example Novel Study Guide', author: 'Example Author', openLibraryWorkKey: '/works/OL-DERIVATIVE' });
  equal(buildSearchWorks([original, guide], { compareEditions: compareEdition }).length, 2, 'Study guides remain separate despite a shared catalog key');
  equal(fallbackCompatibility(original, guide).safe, false, 'A derivative cannot automatically replace the original work');
})();

(() => {
  const english = edition({ id: 'fallback-en', title: 'The Stranger', author: 'Albert Camus', language: 'en' });
  const french = edition({ id: 'fallback-fr', title: 'The Stranger', author: 'Albert Camus', language: 'fr' });
  equal(fallbackCompatibility(english, french).safe, false, 'Automatic fallback rejects a different known language');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'authority-original', title: 'Example Story', author: 'Example Author', language: 'en', openLibraryWorkKey: '/works/OL3W' }),
    edition({ id: 'authority-adapted', title: 'Example Story Adapted', author: 'Example Author', language: 'en', openLibraryWorkKey: '/works/OL3W' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'Original and adapted works remain separate despite a shared catalog key');
  equal(new Set(works.map(work => work.id)).size, 2, 'Conflicting authoritative groups receive distinct deterministic IDs');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'full-text', title: 'A Farewell to Arms', author: 'Ernest Hemingway', language: 'en' }),
    edition({ id: 'abridged-text', title: 'A Farewell to Arms (Abridged Edition)', author: 'Ernest Hemingway', language: 'en' })
  ], { compareEditions: compareEdition });
  equal(works.length, 1, 'Abridgement remains a selectable version of the same displayed work');
  equal(new Set(works[0].editions.map(item => item.fallbackGroupId)).size, 2, 'Abridged and full versions use different automatic fallback groups');
  equal(fallbackCompatibility(works[0].editions[0], works[0].editions[1]).safe, false, 'Abridged and full versions cannot automatically replace one another');
})();

(() => {
  const shared = { author: 'Example Author', publisher: 'Delphi Classics', isbn: ['9781786560360'] };
  const works = buildSearchWorks([
    edition({ id: 'chain-en', ...shared, title: 'Delphi Example Work', source: 'annas', language: 'en' }),
    edition({ id: 'chain-unknown', ...shared, title: 'Example Work', source: 'zlibrary', language: '' }),
    edition({ id: 'chain-fr', ...shared, title: 'Delphi Example Work', source: 'annas', language: 'fr' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A language conflict prevents transitive alias-chain poisoning');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'unknown-a', title: 'Selected Poems', author: 'Unknown', source: 'annas' }),
    edition({ id: 'unknown-b', title: 'Selected Poems', author: 'Unknown', source: 'zlibrary' })
  ], { compareEditions: compareEdition });
  equal(works.length, 2, 'A generic title without a known creator is not enough to merge provider records');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'prometheus-canonical', source: 'annas', title: 'Prometheus Rising', author: 'Robert Anton Wilson',
      language: 'en', openLibraryWorkKey: '/works/OL1805249W', openLibraryTitle: 'Prometheus Rising',
      openLibraryAuthor: 'Robert Anton Wilson', metadataConfidence: { source: 'openlibrary', level: 'high' },
      publisher: 'New Falcon Publications, Reprint, 2009', _year: 2009
    }),
    edition({
      id: 'prometheus-creator-prefix', source: 'internetarchive',
      title: 'Robert Anton Wilson - Prometheus Rising', author: 'Robert Anton Wilson', language: 'en'
    }),
    edition({
      id: 'prometheus-creator-prefix-contributor', source: 'annas',
      title: 'Robert Anton Wilson Prometheus Rising', author: 'Robert Anton Wilson; introduced by Israel Regardie', language: 'English'
    }),
    edition({
      id: 'prometheus-unknown-epub', source: 'annas', title: 'Robert Anton Wilson Prometheus Rising',
      author: 'Unknown', language: 'English', format: 'EPUB'
    }),
    edition({
      id: 'prometheus-unknown-mobi', source: 'annas', title: 'Robert Anton Wilson Prometheus Rising',
      author: 'Unknown', language: 'English', format: 'MOBI'
    }),
    edition({
      id: 'prometheus-wink', title: 'Prometheus Rising', author: 'D. F. Wink', language: 'en',
      publisher: 'Story Artist Press', _year: 2018
    }),
    edition({
      id: 'prometheus-johnson', title: 'Prometheus Rising', author: 'Aaron Johnson', language: 'en',
      publisher: 'New Falcon Publications, Reprint, 2009', _year: 2009
    }),
    edition({ id: 'prometheus-akers', title: 'Prometheus Rising (The Gryphens Saga)', author: 'R. L. Akers', language: 'en' })
  ], { compareEditions: compareEdition });
  const wilson = works.find(work => work.openLibraryWorkKey === 'works/ol1805249w');
  equal(works.length, 3, 'Corroborated metadata variants merge without collapsing distinct same-title works');
  equal(wilson?.title, 'Prometheus Rising', 'The merged work keeps the authoritative canonical title');
  equal(wilson?.author, 'Robert Anton Wilson', 'The authoritative creator overrides a conflicting provider author');
  equal(wilson?.editionCount, 6, 'Known, unknown, and corroborated conflicting-author editions remain selectable under one work');
})();

(() => {
  const results = Array.from({ length: 25 }, (_, index) => edition({
    id: `many-${index}`,
    title: `Distinct Work ${index + 1}`,
    author: `Author ${index + 1}`
  }));
  const works = buildSearchWorks(results, { compareEditions: compareEdition });
  equal(works.length, 25, 'More than 24 distinct works remain available to the client');
  equal(new Set(works.map(work => work.id)).size, 25, 'Each distinct work has a stable unique identity');
})();

(() => {
  const results = [
    edition({ id: 'road-a', title: 'On the Road', author: 'Jack Kerouac', _year: 1957 }),
    edition({ id: 'road-b', title: 'On-the-Road: The Original Scroll', author: 'Kerouac, Jack', _year: 2007 }),
    edition({ id: 'bums', title: 'The Dharma Bums', author: 'Jack Kerouac' }),
    edition({ id: 'road-other', title: 'On the Road', author: 'John Doe' })
  ];
  const works = buildSearchWorks(results, { compareEditions: compareEdition });
  const road = works.find(work => work.editionCount === 2 && canonicalWorkTitle(work.title) === 'on the road');
  equal(road.editionCount, 2, 'Formatting variants and Original Scroll group as editions');
  equal(works.length, 3, 'Distinct titles and distinct authors are not merged');
})();

(() => {
  const surnameFirstWork = buildSearchWorks([
    edition({ id: 'surname-first-display', title: 'On the Road', author: 'Kerouac, Jack, 1922-1969' })
  ], { compareEditions: compareEdition })[0];
  equal(surnameFirstWork.author, 'Jack Kerouac', 'Surname-first catalog authors use normal given-name-first display order');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'road-normal', title: 'On the Road', author: 'Jack Kerouac' }),
    edition({ id: 'road-catalog-alias', title: 'On The Road', author: 'Jack Kerouac [Kerouac, Jack]' }),
    edition({ id: 'blues-catalog-alias', title: 'Book of Blues', author: 'Kerouac Jack [Kerouac Jack]' }),
    edition({ id: 'blues-contributors', title: 'Book of Blues', author: 'Jack Kerouac; Allen Ginsberg' }),
    edition({ id: 'blues-different-primary', title: 'Book of Blues', author: 'Allen Ginsberg; Jack Kerouac' })
  ], { compareEditions: compareEdition });
  const road = works.find(work => canonicalWorkTitle(work.title) === 'on the road');
  equal(road.editionCount, 2, 'Bracketed reversed catalog alias groups with the canonical On the Road author');
  const bluesPrimaryKerouac = works.find(work => canonicalWorkTitle(work.title) === 'book of blues' && work.primaryCreator === 'jack kerouac');
  const bluesPrimaryGinsberg = works.find(work => canonicalWorkTitle(work.title) === 'book of blues' && work.primaryCreator === 'allen ginsberg');
  equal(bluesPrimaryKerouac.editionCount, 2, 'Same title and primary creator group despite full contributor differences');
  equal(works.length, 3, 'A different primary creator remains a separate work identity');

  const intent = applySearchIntent('Jack Kerouac', works);
  equal(intent.works.find(work => work.id === bluesPrimaryKerouac.id).searchGroup, 'authored', 'Kerouac Jack bracket alias is classified as authored');
  equal(intent.works.find(work => work.id === bluesPrimaryGinsberg.id).searchGroup, 'authored', 'A work listing Kerouac as a contributor is classified as authored');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'road-canonical', title: 'On the Road', author: 'Jack Kerouac' }),
    edition({ id: 'road-penguin-scroll', title: 'On the Road: The Original Scroll : (Penguin Classics Deluxe Edition)', author: 'Kerouac, Jack, 1922-1969' }),
    edition({ id: 'road-penguin', title: 'On The Road : (Penguin Classics Deluxe Edition)', author: 'Kerouac, Jack, 1922-1969 (primary contributor)' }),
    edition({ id: 'road-semicolon-contributors', title: 'On the Road', author: 'Jack Kerouac; Allen Ginsberg' }),
    edition({ id: 'road-comma-contributors', title: 'On the Road', author: 'Jack Kerouac, Allen Ginsberg, Editor Name' }),
    edition({ id: 'road-ampersand-contributors', title: 'On the Road', author: 'Jack Kerouac & Allen Ginsberg [Kerouac, Jack]' }),
    edition({ id: 'bums-canonical', title: 'The Dharma Bums', author: 'Jack Kerouac' }),
    edition({ id: 'bums-penguin', title: 'The Dharma Bums : (Penguin Classics Deluxe Edition)', author: 'Kerouac, Jack, 1922-1969 (primary contributor)' })
  ], { compareEditions: compareEdition });
  const road = works.find(work => canonicalWorkTitle(work.title) === 'on the road');
  const bums = works.find(work => canonicalWorkTitle(work.title) === 'the dharma bums');
  equal(road.editionCount, 6, 'Penguin labels and semicolon, comma, and ampersand contributor lists stay in one On the Road work');
  equal(bums.editionCount, 2, 'Bibliographic author years and primary-contributor labels stay in one Dharma Bums work');
  equal(applySearchIntent('Jack Kerouac', works).works.every(work => work.searchGroup === 'authored'), true, 'Bibliographic author forms remain authored for an author query');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'pdf', title: 'Best Edition', author: 'Selector', format: 'PDF', qualityScore: 4, _year: 2025 }),
    edition({ id: 'mobi', title: 'Best Edition', author: 'Selector', format: 'MOBI', qualityScore: 4, _year: 2024 }),
    edition({ id: 'epub-old', title: 'Best Edition', author: 'Selector', format: 'EPUB', qualityScore: 3, _year: 2019 }),
    edition({ id: 'epub-new', title: 'Best Edition', author: 'Selector', format: 'EPUB', qualityScore: 4, _year: 2023 })
  ], { compareEditions: compareEdition });
  equal(works[0].bestEdition.hash, 'edition-epub-new', 'The default is the best audiobook-suitable edition');
  equal(works[0].alternateEditions.length, 3, 'All alternate editions remain accessible');
})();

console.log('\n━━━ Search intent ━━━');

(() => {
  const works = buildSearchWorks([
    edition({ id: 'road', title: 'On the Road', author: 'Jack Kerouac', relevanceScore: 30 }),
    edition({ id: 'bums', title: 'The Dharma Bums', author: 'Jack Kerouac', relevanceScore: 25 }),
    edition({ id: 'decline', title: 'Jack Kerouac and the Decline of the West', author: 'A Critic', relevanceScore: 500 })
  ], { compareEditions: compareEdition });
  const intent = applySearchIntent('Jack Kerouac', works);
  equal(intent.intent.kind, 'author', 'An author-name query is detected from result metadata');
  equal(intent.works.slice(0, 2).every(work => work.searchGroup === 'authored'), true, 'Works by that author lead related/about titles');
  equal(intent.works[2].searchGroup, 'related', 'Related title is placed in a separate group');
  equal(intent.works.some(work => work.isBestMatch), false, 'Author queries do not receive a Best Match badge');
  const surnameIntent = applySearchIntent('Kerouac', works);
  equal(surnameIntent.intent.kind, 'author', 'A distinctive surname query is also treated as author intent');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'sun-rises', title: 'The Sun Also Rises', author: 'Ernest Hemingway', relevanceScore: 30 }),
    edition({ id: 'hemingway-about', title: 'Hemingway: A Biography', author: 'Example Critic', relevanceScore: 20 })
  ], { compareEditions: compareEdition });
  const intent = applySearchIntent('Hemngway', works);
  equal(intent.intent.kind, 'author', 'A bounded surname typo is recognized as author intent when result metadata corroborates it');
  equal(intent.works[0].searchGroup, 'authored', 'Works by the corrected author remain ahead of related titles');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'andersen-work', title: 'Fairy Tales', author: 'Hans Andersen' }),
    edition({ id: 'anderson-work', title: 'Collected Essays', author: 'John Anderson' })
  ], { compareEditions: compareEdition });
  equal(applySearchIntent('Andersan', works).intent.kind, 'general', 'An ambiguous fuzzy surname does not select an author intent');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'habits-reversed-metadata',
      title: 'Stephen R. Covey',
      author: '7 Habits Of Highly Effective People'
    }),
    edition({
      id: 'habits-real-title',
      title: 'The 7 Habits of Highly Effective People',
      author: 'Stephen R. Covey'
    })
  ], { compareEditions: compareEdition });
  const intent = applySearchIntent('7 habits of highly', works);
  equal(intent.intent.kind, 'general', 'A title stored in a malformed author field cannot create author intent');
  equal(intent.works.every(work => work.searchGroup === 'results'), true, 'Malformed reversed metadata cannot push the real title into Related');
})();

(() => {
  const works = buildSearchWorks([
    edition({
      id: 'prometheus-filename-metadata',
      title: 'tmpD362.htm',
      author: 'Rising, Prometheus'
    }),
    edition({
      id: 'prometheus-real-title',
      title: 'Prometheus Rising',
      author: 'Robert Anton Wilson'
    })
  ], { compareEditions: compareEdition });
  const intent = applySearchIntent('Prometheus Rising', works);
  equal(intent.intent.kind, 'title', 'An exact title outranks a filename record whose author field contains the query');
  equal(intent.works.every(work => work.searchGroup === 'results'), true, 'Filename metadata cannot push the exact title into Related');
  equal(intent.works.find(work => work.title === 'Prometheus Rising')?.isBestMatch, true, 'The exact Prometheus Rising work receives Best Match');
})();

(() => {
  const works = buildSearchWorks([
    edition({ id: 'title-match', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', relevanceScore: 20 }),
    edition({ id: 'about-title', title: 'Reading The Left Hand of Darkness', author: 'A Critic', relevanceScore: 40 })
  ], { compareEditions: compareEdition });
  const intent = applySearchIntent('The Left Hand of Darkness', works);
  equal(intent.intent.kind, 'title', 'Exact title query is recognized');
  equal(intent.works.filter(work => work.isBestMatch).length, 1, 'Only one exact title work receives Best Match');
})();

console.log(`\nSearch work group tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
