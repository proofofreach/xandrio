# Server and search performance verification

Use Node 24 and the installed Playwright Chromium and WebKit browsers. These
checks use local HTTP and filesystem fixtures. They do not load production or
call external catalog or narration providers.

```sh
npm test
SERVER_READ_PHASE=release npm run verify:server-read-efficiency
npm run verify:search-resource-lifecycle -- --phase release
SEARCH_REQUEST_PHASE=release-chromium npm run verify:search-request-lifecycle
SEARCH_REQUEST_BROWSER=webkit SEARCH_REQUEST_PHASE=release-webkit npm run verify:search-request-lifecycle
```

Reports and browser traces are saved under `output/server-performance/`.
Keep failing baseline reports beside passing verification reports. Performance
claims should use request, filesystem-read and lock counts. Local timings are
supporting evidence, not production latency estimates.

## Required behavior

- Repeated Enter presses submit one request for the same pending search.
  Changing the query or language, or clearing the query, closes the obsolete
  browser request. Loading indicators clear, stale responses cannot replace
  current results, and failed searches remain retryable.
- Search cards show import status only while an import is active.
- Candidate editions with identical catalog-identity inputs share one lookup
  within that response. Distinct inputs retain their lookup and result behavior.
  Requests do not share a persistent cache or retain failed lookups across searches.
- Cover downloads enforce the existing 8 MiB body limit while streaming, so an
  oversized response is canceled before the entire body is buffered.
- Unchanged book-detail reads and already-canonical cached covers avoid
  whole-library writer locks. Genuine chapter changes, pending repairs and
  cover-path backfills retain their locked update paths. Profile-specific shelves
  and concurrent metadata changes remain intact.

## Limits

The library fixture has 501 books and measures 30 warm requests per path. It
uses real library routes and the critical JSON store, with local chapter and
cover adapters. It does not measure production authentication or image decoding.

Canceling a browser request closes that HTTP connection. Existing upstream
search providers may continue work until their own completion or timeout.
Catalog deduplication applies only to identical inputs in one search response;
distinct candidates retain the existing maximum of eight parallel lookups.

Browser verification covers Chromium and WebKit desktop engines and phone-sized
viewports. It does not replace testing on physical phones or a production load
test. Frontend asset and offline-worker versions must stay synchronized.
