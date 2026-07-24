# Search-cover reliability

## Baseline

The live baseline was **38 covers resolved from 53 search results**. This is a
cover-delivery problem, not a search-result count: the Anna CLI omits cover
metadata, unauthenticated Google Books requests can have zero quota, equivalent
editions caused duplicate lookups, the descriptor registry existed only in
memory, and a transient miss was held by the negative cache.

## Completed architecture

- Search results register a bounded, durable descriptor and expose only a
  same-origin `/api/search-cover/:key` URL.
- Resolution coalesces equivalent catalog identities and concurrent requests;
  it persists descriptors so a restart can continue a lookup.
- Anna editions can recover a cover from the configured Anna origin's exact
  `/md5/<hash>` page. Because those pages can expose Calibre-style generated
  title cards, the page image is used only after high-confidence Open Library
  and Google Books cover lookups miss. The configured origin is read when the
  fetch begins, rather than copied from a stale setting.
- A successful image is cacheable. A miss/error is `private, no-store` with a
  short `Retry-After`; `retry=1` permits one deliberate retry to bypass a
  transient negative entry.
- The browser leaves the existing book fallback visible after a failed image,
  then makes one delayed, cache-busted, same-origin retry while that image node
  is still connected.
- Shutdown flushes queued cover-descriptor writes before the process exits.

## Security invariants

- The client accepts only HTTP(S) same-origin cover URLs and retries only the
  exact search-cover route.
- Anna page requests require the current configured public HTTPS origin and an
  MD5-detail path; cover-image fetches remain subject to bounded reads, DNS
  public-address checks, redirect validation, image validation, and dimension
  limits.
- Descriptor keys are opaque. Remote URLs are never handed directly to the
  browser, and cover failures are not shared-cacheable.

## Verification

- Unit coverage verifies Anna page-origin enforcement, persisted descriptors,
  request coalescing, catalog-before-generated-fallback ordering, and explicit
  negative-cache retry behavior.
- The browser smoke test verifies the fallback path performs exactly one
  cache-busted `retry=1` request and that all rendered/retried cover requests
  stay on the app origin.
- App-shell version checks require the index and service-worker versions to
  move together when the client module changes.

## Residual risks

Provider pages, rate limits, and metadata ambiguity can still prevent a cover.
Google Books remains an unkeyed last-resort fallback rather than the baseline.
This release does not add a Google API-key setting: provider attribution and
cache-header requirements need dedicated support first.
