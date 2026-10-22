#!/usr/bin/env node
// Open Library identity searches run concurrently but must select exactly what
// the sequential resolver selected: same work, same matchedFrom, same warnings.

const { buildOpenLibrarySearches, resolveOpenLibraryIdentity } = require('../lib/metadata-service');

let passed = 0;
let failed = 0;

function test(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const input = { title: 'The Hobbit [retail]', author: 'J. R. R. Tolkien', isbn: '9780547928227' };
const hobbit = { key: '/works/OL1W', title: 'The Hobbit', author_name: ['J. R. R. Tolkien'], edition_key: ['OL1M'] };

// Every search returns the same equally scored work, so the winner is decided
// purely by search order. Later searches answer first to expose reordering.
function searchService({ failing = new Set() } = {}) {
  const state = { inflight: 0, maxInflight: 0, started: [] };
  const queries = buildOpenLibrarySearches(input).map(search => search.q);
  state.fetchImpl = async url => {
    const q = new URL(url).searchParams.get('q');
    state.started.push(q);
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    await new Promise(resolve => setTimeout(resolve, 10 + (queries.length - queries.indexOf(q)) * 15));
    state.inflight--;
    if (failing.has(q)) return { ok: false, status: 503, async json() { return {}; } };
    return { ok: true, async json() { return { docs: [hobbit] }; } };
  };
  return state;
}

(async () => {
  console.log('\n--- Open Library identity search concurrency ---');
  const searches = buildOpenLibrarySearches(input);
  test(searches.length >= 4, `fixture exercises several searches (${searches.length})`);

  const sequential = searchService();
  const sequentialResult = await resolveOpenLibraryIdentity(input, {
    lookupImpl: publicLookup, fetchImpl: sequential.fetchImpl, searchConcurrency: 1
  });
  const concurrent = searchService();
  const started = Date.now();
  const concurrentResult = await resolveOpenLibraryIdentity(input, {
    lookupImpl: publicLookup, fetchImpl: concurrent.fetchImpl
  });
  const concurrentMs = Date.now() - started;

  test(sequential.maxInflight === 1, 'searchConcurrency 1 keeps the sequential baseline');
  test(concurrent.maxInflight === 2, `default runs two searches at once (max ${concurrent.maxInflight})`);
  test(concurrent.started.join('|') === sequential.started.join('|'), 'searches start in the same priority order');
  test(JSON.stringify(concurrentResult) === JSON.stringify(sequentialResult),
    'concurrent resolution selects the identical identity, matchedFrom and warnings');
  test(concurrentResult.matchedFrom === 'isbn', 'ties still resolve to the earliest search');

  const failing = new Set([searches[0].q, searches[2].q]);
  const sequentialFailures = searchService({ failing });
  const concurrentFailures = searchService({ failing });
  const sequentialFailureResult = await resolveOpenLibraryIdentity(input, {
    lookupImpl: publicLookup, fetchImpl: sequentialFailures.fetchImpl, searchConcurrency: 1
  });
  const concurrentFailureResult = await resolveOpenLibraryIdentity(input, {
    lookupImpl: publicLookup, fetchImpl: concurrentFailures.fetchImpl
  });
  test(JSON.stringify(concurrentFailureResult) === JSON.stringify(sequentialFailureResult) &&
    concurrentFailureResult.warnings.length >= 2,
  'failed searches report the same warnings in the same order');
  test(concurrentFailureResult.matchedFrom === searches[1].matchedFrom,
    'the earliest successful search still wins after failures');

  const slowService = searchService();
  const slowStarted = Date.now();
  await resolveOpenLibraryIdentity(input, { lookupImpl: publicLookup, fetchImpl: slowService.fetchImpl, searchConcurrency: 1 });
  const sequentialMs = Date.now() - slowStarted;
  test(concurrentMs < sequentialMs * 0.75,
    `concurrent searches finish sooner (${concurrentMs} ms vs ${sequentialMs} ms sequential)`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
