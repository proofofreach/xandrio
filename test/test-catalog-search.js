/**
 * Catalog Search Tests
 *
 * Exercises the production catalog-search interface used by /api/search.
 * Run: node test/test-catalog-search.js
 */

const { buildCatalogSearchResponse } = require('../lib/catalog-search');
const { resolveOpenLibraryIdentity } = require('../lib/metadata-service');
const hemingwayCrossSourceResults = require('./fixtures/hemingway-cross-source-results.json');

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
  assert(actual === expected, `${message}${actual === expected ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

function result(overrides = {}) {
  return {
    title: 'Default Title',
    author: 'Default Author',
    format: 'EPUB',
    size: '2 MB',
    hash: `hash-${Math.random().toString(36).slice(2)}`,
    publisher: 'Test Press, 2023',
    language: 'en',
    source: 'annas',
    ...overrides
  };
}

async function run() {
section('1. grouped ranked catalog response');

await (async () => {
  const sourceStatus = { annas: { id: 'annas', label: "Anna's Archive", ok: true, count: 3 } };
  const response = await buildCatalogSearchResponse({
    query: 'Dune',
    results: [
      result({ title: 'Dune', author: 'Frank Herbert', hash: 'dune-epub', size: '2 MB' }),
      result({ title: 'Dune', author: 'Frank Herbert', hash: 'dune-mobi', format: 'MOBI', publisher: 'Test Press, 2024' }),
      result({ title: 'Dune: A Study Guide', author: 'Reader Notes', hash: 'dune-guide', size: '1 MB' })
    ],
    sourceStatus,
    projectEdition: edition => ({ ...edition, coverUrl: `/covers/${edition.hash}` })
  });

  assertEqual(response.totalWorks, 2, 'Groups same-title editions into one work');
  assertEqual(response.totalEditions, 3, 'Keeps every selectable edition');
  assertEqual(response.recommended.title, 'Dune', 'Ranks the exact title first');
  assertEqual(response.recommended.editionCount, 2, 'Exposes grouped edition count to legacy clients');
  assertEqual(response.works[0].bestEdition.format, 'EPUB', 'Prefers EPUB as the selectable edition');
  assertEqual(response.works[0].coverUrl, '/covers/dune-epub', 'Projects covers onto work display fields');
  assertEqual(response.results.length, 3, 'Keeps flattened edition results for older clients');
  assert(response.sourceStatus === sourceStatus, 'Preserves provider source status');
})();

section('2. language filtering preserves PDF fallback');

await (async () => {
  const response = await buildCatalogSearchResponse({
    query: 'Archive Book',
    language: 'English',
    results: [
      result({ title: 'Archive Book', hash: 'english-pdf', format: 'PDF', language: 'en', size: '20 MB' }),
      result({ title: 'Archive Book', hash: 'italian-epub', language: 'it', size: '2 MB' })
    ],
    sourceStatus: {}
  });

  assertEqual(response.recommended.format, 'PDF', 'Returns PDF when language filtering leaves no ebook');
  assertEqual(response.results.length, 1, 'Filters editions to the requested language before format selection');
})();

section('3. unusable editions return the established quality response');

await (async () => {
  const sourceStatus = { annas: { id: 'annas', ok: true, count: 1 } };
  const response = await buildCatalogSearchResponse({
    query: 'Unreadable Book',
    results: [result({ title: 'Unreadable Book', format: 'TXT', size: '10 KB', author: 'Unknown', publisher: '' })],
    sourceStatus
  });

  assertEqual(response.error, 'No quality versions found, try different search', 'Retains the quality-filter error message');
  assertEqual(response.recommended, null, 'Does not recommend an unusable edition');
  assertEqual(response.results.length, 0, 'Returns the legacy empty results array for quality filtering');
  assert(response.sourceStatus === sourceStatus, 'Keeps source status on the quality-filter response');
})();

section('4. canonical variants group through bounded Open Library identity enrichment');

await (async () => {
  const resolverCalls = [];
  const response = await buildCatalogSearchResponse({
    query: 'The Great Gatsby',
    results: [
      result({ title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', hash: 'gatsby-canonical' }),
      result({ title: 'Gatsby: The Authorized Text', author: 'F. Scott Fitzgerald', hash: 'gatsby-authorized' }),
      ...Array.from({ length: 8 }, (_, index) => result({
        title: `Unrelated Result ${index + 1}`,
        author: `Author ${index + 1}`,
        hash: `unrelated-${index + 1}`
      }))
    ],
    sourceStatus: {},
    resolveOpenLibraryIdentity: async input => {
      resolverCalls.push(input);
      if (input.title === 'The Great Gatsby' || input.title === 'Gatsby: The Authorized Text') {
        return {
          openLibraryWorkKey: '/works/OL123W',
          confidence: { score: 0.98, level: 'high' }
        };
      }
      return { confidence: { score: 0, level: 'low' } };
    }
  });

  assertEqual(response.totalWorks, 9, 'Groups canonical title variants under their shared Open Library work');
  assertEqual(response.works[0].editionCount, 2, 'Keeps both canonical variants selectable as editions');
  assertEqual(response.works[0].workIdentity, 'openlibrary:works/ol123w|lang:en|creator:f fitzgerald scott', 'Exposes the shared canonical work identity in the playable language and creator partition');
  assertEqual(resolverCalls.length, 9, 'Resolves the query plus only the top eight candidates');
})();

section('5. legacy alternatives begin with the recommended work editions');

await (async () => {
  const response = await buildCatalogSearchResponse({
    query: 'Dune',
    results: [
      result({ title: 'Dune', author: 'Frank Herbert', hash: 'dune-primary', format: 'EPUB' }),
      result({ title: 'Dune', author: 'Frank Herbert', hash: 'dune-alternate', format: 'MOBI' }),
      result({ title: 'Dune Companion', author: 'Reader Notes', hash: 'dune-companion', format: 'EPUB' }),
      result({ title: 'Dune: A Study Guide', author: 'Reader Notes', hash: 'dune-alternate', format: 'EPUB' })
    ],
    sourceStatus: {}
  });

  assertEqual(response.works[0].alternateEditions[0].hash, 'dune-alternate', 'Retains alternate editions in the grouped work');
  assertEqual(
    response.alternatives.map(edition => edition.hash).join(','),
    'dune-alternate,dune-companion',
    'Projects recommended work editions before other works without duplicate editions'
  );
})();

section('6. cross-source aliases retain clean work metadata');

await (async () => {
  const response = await buildCatalogSearchResponse({
    query: 'Complete Works of Ernest Hemingway',
    results: hemingwayCrossSourceResults,
    sourceStatus: {}
  });
  const collection = response.works.find(work => work.versionCount === 6);
  assertEqual(response.totalWorks, 2, 'Resolves clear collection aliases while retaining the constituent volume');
  assertEqual(collection?.title, 'Complete Works of Ernest Hemingway', 'Keeps the clean resolved title independent of the selected version');
  assertEqual(collection?.sourceCount, 2, 'Projects the complete source set');
  assertEqual(collection?.editions.every(item => item.fallbackGroupId?.startsWith('fallback-')), true, 'Projects opaque fallback groups on every version');
})();

await (async () => {
  const response = await buildCatalogSearchResponse({
    query: 'Complete Works of Ernest Hemingway',
    results: [
      result({ title: 'Delphi Complete Works of Ernest Hemingway', author: 'Ernest Hemingway', source: 'zlibrary', publisher: 'Delphi Classics, 2025', isbn: ['9781786560360'], hash: 'noisy-best', format: 'EPUB' }),
      result({ title: 'Complete Works of Ernest Hemingway', author: 'Ernest Hemingway', source: 'annas', publisher: 'Delphi Classics', isbn: ['9781786560360'], hash: 'clean-mobi', format: 'MOBI' })
    ],
    sourceStatus: {}
  });
  assertEqual(response.works[0].bestEdition.hash, 'noisy-best', 'Still selects the best downloadable version');
  assertEqual(response.works[0].title, 'Complete Works of Ernest Hemingway', 'Does not replace the clean work title with the selected version title');
})();

section('7. author-query identity cannot leak across provider results');

await (async () => {
  const openLibraryResolver = input => resolveOpenLibraryIdentity(input, {
    fetchImpl: async url => {
      const q = new URL(url).searchParams.get('q');
      return {
        ok: true,
        async json() {
          return {
            docs: /Slaughterhouse-Five|^kurt vonnegut$/i.test(q)
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
  const response = await buildCatalogSearchResponse({
    query: 'kurt vonnegut',
    language: 'en',
    results: [
      result({
        hash: 'tribute-ginsberg',
        title: 'KURT VONNEGUT: Tribute to Alan Ginsberg',
        author: 'Chris Huber (Durham, NC USA); KURT VONNEGUT',
        source: 'annas'
      }),
      result({
        hash: 'vonnegut-letters',
        title: 'Kurt Vonnegut: Letters',
        author: 'Kurt Vonnegut',
        source: 'zlibrary'
      })
    ],
    sourceStatus: {},
    resolveOpenLibraryIdentity: openLibraryResolver,
    projectEdition: edition => ({ ...edition, coverIdentity: edition.openLibraryWorkKey || null })
  });
  const tribute = response.works.find(work => work.title === 'KURT VONNEGUT: Tribute to Alan Ginsberg');
  assertEqual(response.totalWorks, 2, 'Unrelated Vonnegut-related listings remain separate works');
  assertEqual(tribute?.bestEdition.openLibraryWorkKey, undefined, 'Tribute listing does not inherit the query work identity');
  assertEqual(tribute?.bestEdition.coverIdentity, null, 'Cover projection cannot use the unrelated query work identity');
})();

section('8. corrected searches retain explicit response metadata');

await (async () => {
  const searchCorrection = {
    originalQuery: 'Slaugterhouse-Five',
    correctedQuery: 'Slaughterhouse-Five',
    kind: 'title',
    source: 'openlibrary',
    confidence: 'high'
  };
  const response = await buildCatalogSearchResponse({
    query: 'Slaughterhouse-Five',
    requestedQuery: 'Slaugterhouse-Five',
    searchCorrection,
    results: [result({ title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut' })],
    sourceStatus: {}
  });
  assertEqual(response.searchCorrection, searchCorrection, 'Exposes the applied correction instead of silently changing the query');
  assertEqual(response.searchIntent.kind, 'title', 'Ranks corrected results against the effective canonical title');
})();

section('9. provider-returned typo matches rank as title intent');

await (async () => {
  const response = await buildCatalogSearchResponse({
    query: 'Slaugterhouse-Five',
    results: [
      result({ title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut', hash: 'canonical-slaughterhouse' }),
      result({ title: 'Slaughterhouse Reader', author: 'Example Author', hash: 'reader-slaughterhouse' })
    ],
    sourceStatus: {}
  });
  assertEqual(response.recommended.hash, 'canonical-slaughterhouse', 'A bounded typo match ranks the intended canonical title first');
  assertEqual(response.searchIntent.kind, 'title', 'A bounded typo match is recognized as title intent');
  assertEqual(response.works.filter(work => work.isBestMatch).length, 1, 'Only the intended typo-tolerant title receives Best Match');
})();

section('10. trusted catalog title is independent from provider editions');

await (async () => {
  const response = await buildCatalogSearchResponse({
    query: 'Gatsby',
    results: [
      result({ title: 'Gatsby: The Authorized Text', author: 'F. Scott Fitzgerald', hash: 'gatsby-authorized-only' }),
      result({ title: "Fitzgerald's Gatsby", author: 'F. Scott Fitzgerald', hash: 'gatsby-prefixed-only', source: 'zlibrary' })
    ],
    sourceStatus: {},
    resolveOpenLibraryIdentity: async input => input.title === 'Gatsby'
      ? { confidence: { score: 0, level: 'low' } }
      : {
          title: 'The Great Gatsby',
          author: 'Francis Scott Fitzgerald',
          openLibraryWorkKey: '/works/OL468431W',
          confidence: { score: 0.9, level: 'high' }
        }
  });
  assertEqual(response.totalWorks, 1, 'Trusted catalog identity groups provider title variants');
  assertEqual(response.works[0].title, 'The Great Gatsby', 'The clean catalog title is displayed independently from the selected edition');
  assertEqual(response.works[0].author, 'Francis Scott Fitzgerald', 'The trusted catalog author is displayed independently from the selected edition');
})();

console.log(`\n${'═'.repeat(50)}`);
console.log(`Catalog search tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All catalog search tests passed! ✅');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
