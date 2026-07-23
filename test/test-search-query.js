/**
 * Search Query Tests
 *
 * Exercises the route-facing search orchestration interface.
 * Run: node test/test-search-query.js
 */

const { searchCatalogQuery } = require('../lib/search-query');
const { resolveSearchQueryCorrection } = require('../lib/metadata-service');

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

function equal(actual, expected, message) {
  assert(actual === expected, `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function run() {
  console.log('\n━━━ Typo-tolerant catalog queries ━━━');

  const calls = [];
  const correctedResult = { title: 'Slaughterhouse-Five', author: 'Kurt Vonnegut', source: 'annas' };
  const response = await searchCatalogQuery({
    query: 'Slaugterhouse-Five',
    context: { language: 'en', sources: ['annas'] },
    search: async query => {
      calls.push(query);
      return query === 'Slaughterhouse-Five'
        ? { results: [correctedResult], sourceStatus: { annas: { ok: true, count: 1 } } }
        : { results: [], sourceStatus: { annas: { ok: true, count: 0 } } };
    },
    resolveCorrection: async () => ({
      title: 'Slaughterhouse-Five',
      author: 'Kurt Vonnegut',
      openLibraryWorkKey: '/works/OL1W'
    })
  });

  equal(JSON.stringify(calls), JSON.stringify(['Slaugterhouse-Five', 'Slaughterhouse-Five']), 'A validated title typo triggers one corrected provider retry');
  equal(response.results[0], correctedResult, 'The successful retry supplies the catalog results');
  equal(response.effectiveQuery, 'Slaughterhouse-Five', 'Ranking uses the corrected canonical query');
  equal(response.searchCorrection?.originalQuery, 'Slaugterhouse-Five', 'The response retains the user query for disclosure');

  const discovered = await resolveSearchQueryCorrection({ query: 'Slaugterhouse-Five', language: 'en' }, {
    fetchImpl: async url => {
      const parsed = new URL(url);
      return {
        ok: true,
        async json() {
          if (parsed.hostname === 'en.wikipedia.org') {
            return { query: { searchinfo: { suggestion: 'slaughterhouse five' } } };
          }
          return { docs: [{
            key: '/works/OL98459W',
            title: 'Slaughterhouse-Five',
            author_name: ['Kurt Vonnegut'],
            language: ['vie', 'eng'],
            edition_key: ['OL1M']
          }] };
        }
      };
    }
  });
  equal(discovered.openLibraryWorkKey, '/works/OL98459W', 'Correction discovery validates a spelling suggestion against a book catalog authority');
  equal(discovered.spellingSuggestion, 'slaughterhouse five', 'Correction discovery exposes the bounded suggestion it validated');
  equal(discovered.language, 'en', 'Catalog validation retains the requested language when the work is multilingual');

  const exactCalls = [];
  const exact = await searchCatalogQuery({
    query: 'The Shack',
    search: async query => {
      exactCalls.push(query);
      return { results: [{ title: 'The Shack', author: 'William P. Young' }], sourceStatus: {} };
    },
    resolveCorrection: async () => {
      throw new Error('Correction lookup must not run for a successful search');
    }
  });
  equal(JSON.stringify(exactCalls), JSON.stringify(['The Shack']), 'A successful exact search is never broadened or retried');
  equal(exact.searchCorrection, undefined, 'An unchanged search has no correction disclosure');

  const unsafeCalls = [];
  const unsafe = await searchCatalogQuery({
    query: 'The Shock',
    search: async query => {
      unsafeCalls.push(query);
      return { results: [], sourceStatus: { annas: { ok: true, count: 0 } } };
    },
    resolveCorrection: async () => ({
      title: 'The Shack',
      author: 'William P. Young',
      openLibraryWorkKey: '/works/OL2W'
    })
  });
  equal(JSON.stringify(unsafeCalls), JSON.stringify(['The Shock']), 'A short real-word substitution is not treated as a safe query correction');
  equal(unsafe.searchCorrection, undefined, 'An unsafe suggestion remains undisclosed and unapplied');

  let outageCorrectionCalls = 0;
  const outage = await searchCatalogQuery({
    query: 'Slaugterhouse-Five',
    search: async () => ({
      results: [],
      sourceStatus: { annas: { ok: false, count: 0, errorCode: 'ANNAS_SEARCH_UNAVAILABLE' } }
    }),
    resolveCorrection: async () => {
      outageCorrectionCalls++;
      return { title: 'Slaughterhouse-Five', openLibraryWorkKey: '/works/OL1W' };
    }
  });
  equal(outageCorrectionCalls, 0, 'A provider outage is not misdiagnosed as a spelling problem');
  equal(outage.sourceStatus.annas.errorCode, 'ANNAS_SEARCH_UNAVAILABLE', 'The original provider failure remains visible');

  const authorCalls = [];
  const authorSearch = await searchCatalogQuery({
    query: 'Hemngway',
    context: { language: 'en' },
    search: async query => {
      authorCalls.push(query);
      return query === 'hemingway'
        ? { results: [{ title: 'The Sun Also Rises', author: 'Ernest Hemingway' }], sourceStatus: { annas: { ok: true, count: 1 } } }
        : { results: [], sourceStatus: { annas: { ok: true, count: 0 } } };
    },
    resolveCorrection: async () => ({
      title: 'The Sun Also Rises',
      author: 'Ernest Hemingway',
      openLibraryWorkKey: '/works/OL3W',
      language: 'mul'
    })
  });
  equal(JSON.stringify(authorCalls), JSON.stringify(['Hemngway', 'hemingway']), 'A misspelled surname can retry as a corrected author search');
  equal(authorSearch.searchCorrection?.kind, 'author', 'The correction identifies author intent');

  const languageCalls = [];
  await searchCatalogQuery({
    query: 'Slaugterhouse-Five',
    context: { language: 'en' },
    search: async query => {
      languageCalls.push(query);
      return { results: [], sourceStatus: { annas: { ok: true, count: 0 } } };
    },
    resolveCorrection: async () => ({
      title: 'Slaughterhouse-Five',
      openLibraryWorkKey: '/works/OL4W',
      language: 'fr'
    })
  });
  equal(JSON.stringify(languageCalls), JSON.stringify(['Slaugterhouse-Five']), 'A conflicting known catalog language blocks a corrected retry');

  console.log(`\nSearch query tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
