# Cross-source work resolution plan

Status: implemented and release-verified on 2026-07-12

## Outcome

Search should show one card for one clearly identified work while preserving every
usable provider version and its acquisition route. For the current Hemingway
fixture, these three groups:

- `Delphi Complete Works of Ernest Hemingway`
- `Complete Works of Ernest Hemingway`
- `Complete Works of Ernest Hemingway (Delphi Classics)`

should resolve to one clean `Complete Works of Ernest Hemingway` card containing
six selectable versions from Anna's Archive and Z-Library. `The Sun Also Rises
(The Complete Works of Ernest Hemingway, Volume 2 of 21)` must remain a separate
work.

False merges are more damaging than missed merges. Search versions are also used
as automatic import fallbacks, so a false merge can import the wrong book rather
than merely produce an untidy card.

## Product rules

1. Merge only deterministic, explainable, high-confidence matches.
2. Keep medium-confidence similarities as separate cards.
3. Never use general fuzzy-title distance as an automatic merge rule.
4. Never discard source, rights, license, file, or download metadata.
5. Select the card's display title independently from the best downloadable
   version.
6. Treat a search work as the same intellectual work in a compatible language,
   not as a formal bibliographic claim covering every translation or adaptation.
7. Allow the user to select any grouped version, but automatically retry only a
   semantically compatible fallback version.
8. Perform result resolution locally and synchronously. It must not fetch covers
   or add external requests while clustering returned records. Query spelling
   recovery is a separate route-orchestration step: after a healthy zero-result
   search only, it may validate one bounded suggestion and retry once.

## Terminology

- **Provider result**: one raw listing returned by Anna's Archive, Z-Library,
  Standard Ebooks, Project Gutenberg, Internet Archive, or OPDS.
- **Work**: the card-level intellectual work shown in search.
- **Version**: a selectable provider result for that work. The existing API keeps
  the `editions` field for compatibility, while the UI uses the more accurate
  word “versions.”
- **Acquisition route**: the provider-specific information needed to download a
  version.
- **Resolution evidence**: normalized identifiers and metadata that support a
  merge.
- **Conflict**: metadata that prevents a merge even when another signal matches.
- **Fallback profile**: the language and content-form constraints that determine
  whether one version may be tried automatically after another fails.

## Current state and failure

The current path is:

`provider results -> score/enrich -> buildSearchWorks -> project covers -> UI`

`lib/search-work-groups.js` is already the correct central seam. It groups by a
trusted Open Library work key when available, otherwise by exact canonical title
and primary creator. The Hemingway variants escape because their fallback keys
are different:

- `delphi complete works of ernest hemingway|ernest hemingway`
- `complete works of ernest hemingway|ernest hemingway`
- `complete works of ernest hemingway delphi classics|ernest hemingway`

The data also demonstrates why ISBN must not be decisive by itself: the same
Delphi ISBN appears on both the complete collection and the individual
`The Sun Also Rises ... Volume 2 of 21` listing.

The current UI and import behavior introduce two additional requirements:

- The work title currently comes from the highest-ranked file. After merging,
  that could leave the noisy `Delphi ...` title on the card.
- Every version in a work is currently offered to the importer as an automatic
  fallback. Resolution and fallback safety therefore need a shared, stricter
  definition.

## Architecture

Add a deep, provider-agnostic module at `lib/search-work-resolution.js`. Its small
interface should hide normalization, evidence evaluation, conflict detection,
deterministic clustering, and fallback profiles:

```js
resolveSearchWorkClusters(results)
// -> [{ workIdentity, resolution, editions }]

fallbackCompatibility(selected, candidate)
// -> { safe, reason }
```

`lib/search-work-groups.js` remains the caller-facing grouping and ranking module.
It uses the resolver, chooses display metadata, removes exact duplicate provider
listings, ranks selectable versions, and returns the existing work response
shape. `server.js` uses the same `fallbackCompatibility` interface to re-check
client-supplied automatic alternatives.

Do not put publisher rules in provider adapters, repeat matching logic in the
browser, or make cover availability part of identity resolution. One resolver
keeps matching behavior and its tests local.

## Resolution facts

For each provider result, privately derive an immutable facts record:

- original and canonical title;
- safe publisher-reduced title candidates;
- normalized primary creator and contributors;
- normalized publisher/imprint with publication years removed;
- normalized language;
- validated Open Library work key and its confidence;
- checksum-valid ISBN-10/ISBN-13 values;
- source and stable provider item identity;
- semantic qualifiers such as volume/part number, abridgement, adaptation,
  commentary/study guide, manuscript/textual version, and collection scope;
- file format, size, year, and any documented content hash.

Normalization must be Unicode-safe and deterministic. Preserve semantic words
such as `complete`, `selected`, `volume`, `part`, `study guide`, and `adapted`.
Edition labels may be removed from the comparison title only after recording them
in the fallback profile.

### Publisher normalization

Normalize `Delphi Classics, 2016` and `Delphi Classics` to the same publisher.
Remove only clearly non-identifying date/punctuation noise; do not maintain a
large hard-coded publisher catalog.

Produce a publisher-reduced title only under a bounded rule:

1. Remove the exact normalized publisher phrase when it appears as a delimited
   prefix, suffix, or parenthetical label.
2. A single publisher head word such as `Delphi` may be removed only when all of
   the following hold:
   - both candidate groups have the same normalized multi-word publisher;
   - the word is distinctive, at least five characters long, and occurs at a
     title edge;
   - removing it makes the titles exactly equal;
   - the candidates come from different sources; and
   - another strong signal corroborates the match, such as an overlapping valid
     ISBN plus compatible title scope.

This resolves the Hemingway fixture without turning arbitrary publisher/title
word overlap into a merge rule.

## Evidence levels

Evaluate named rules rather than an opaque numeric similarity score.

### Authoritative

- Same medium/high-confidence Open Library work key, with no conflicting known
  creator, language, volume, or content-form metadata.
- Different medium/high-confidence Open Library work keys may represent
  duplicate authority records only when each candidate group has exactly one
  trusted canonical title and primary creator and both values match exactly.
  Provider creators, language, volume, collection scope, and derivative or
  adaptation state must also remain compatible.

### Exact

- Same canonical title and same known primary creator, with no hard conflict.
- Primary-creator aliases may use compatible given-name initials, surname-first
  order, or a bounded conventional bibliographic abbreviation. Conflicting full
  given or middle names remain a hard conflict, and secondary contributors do
  not establish work identity.
- An official `Title: Subtitle` listing may match an otherwise unsuffixed title
  for a compatible primary creator. Two different sibling subtitles do not
  match one another through their shared primary-title prefix.
- Existing narrow edition-label variants such as `illustrated`, `annotated`, or
  `original scroll` may share a work, but their qualifiers remain available for
  fallback decisions.

### Corroborated alias

- Same known primary creator and compatible language;
- publisher-reduced titles are exactly equal;
- publisher/imprint metadata satisfies the bounded rules above;
- candidates have independent cross-source support; and
- no hard conflict exists.

An overlapping, checksum-valid ISBN strengthens this rule but never creates a
work match on its own. Year, file size, format, cover, and source popularity are
not work-identity evidence.

### Bounded typo

- Candidate generation may use contextual one-deletion signatures, but candidate overlap never
  decides a merge.
- Across different sources, exact compatible creator metadata may support one
  one-edit title token. Short-token changes, multiple changed tokens, and hard
  semantic conflicts are rejected.
- An exact title may support one missing character or adjacent transposition in
  a primary-creator token. Creator substitutions are rejected.
- Title and creator typo evidence cannot be combined for the same pair.

### Possible duplicate

Similar titles with incomplete evidence are not merged. Keep the cards separate.
Record the rejected candidate only in opt-in local diagnostics; do not add a
visible warning or badge to the normal UI.

## Hard conflicts

Reject a candidate merge when any of these are known and incompatible:

- different primary creators, unless the exact-title bounded-typo rule accepts
  one missing/transposed character or an authoritative identity explains a
  missing—not conflicting—creator;
- different normalized languages;
- different medium/high-confidence Open Library work keys, unless the strict
  duplicate-authority identity rule above applies; when neither side has any
  trusted authority title or creator, the existing narrow recognized-edition
  label rule may still resolve an exact provider title/creator alias;
- different explicit volume, book, part, tome, or series numbers;
- complete collection versus a constituent volume or individual title;
- original work versus summary, study guide, workbook, commentary, or analysis;
- original work versus adaptation, retelling, dramatization, or graphic version;
- abridged versus explicitly unabridged for automatic fallback;
- incompatible manuscript/textual versions for automatic fallback.

Missing metadata is not a conflict, but it cannot satisfy a corroborated alias
rule that requires that field.

## Deterministic clustering

1. Build candidate indexes from authoritative keys, exact title/creator keys,
   contextual one-deletion signatures, and bounded publisher-reduced title/creator keys.
2. Evaluate candidates in fixed evidence order: authoritative, exact, bounded
   typo, then corroborated alias.
3. Merge clusters only when every existing member is compatible with every member
   of the candidate cluster. This complete-link check prevents transitive
   “A matches B, B matches C, therefore A matches C” poisoning.
4. Sort all facts and evidence before choosing a root so provider response order
   cannot change the result.
5. Prefer a trusted Open Library identity for `workIdentity`; otherwise derive it
   from the clean resolved title, primary creator, and normalized language.
6. Hash that identity through the existing stable work-ID mechanism.

Search IDs remain response-scoped, but identical input sets in any order must
produce identical IDs, titles, grouping, and version order.

## Display metadata and version selection

Choose these independently:

- **Display title**: trusted authority title when available; otherwise the
  cleanest supported title, preferring the title without publisher/imprint and
  edition noise. Do not blindly choose the shortest string.
- **Display author**: trusted or most consistently represented creator display.
- **Selected version**: keep the existing audiobook-suitability ordering—format,
  source-file penalties, edition penalties, year, and size.
- **Cover**: choose from the normal durable cover pipeline independently of work
  identity. A missing or matching cover must not affect grouping.

Do not collapse two cross-source listings merely because their ISBN, format, and
size look alike. They may provide valuable acquisition redundancy. Collapse only
the same provider item repeated in its own response, or a documented identical
content hash where the hash semantics are known for both sources.

## Automatic fallback safety

Each version receives a private fallback profile containing at least:

- normalized language;
- full/abridged/unknown state;
- original/adapted/derivative state;
- volume/part identity;
- textual-version qualifiers.

The resolver returns fallback-safe subgroups within a displayed work. The API can
represent these with an opaque `fallbackGroupId` on each version. The browser
offers automatic alternatives only from the selected version's fallback group.
The server then recomputes `fallbackCompatibility` and rejects unsafe candidates;
it must not trust the client-provided group ID.

Replace the current broad title-token-overlap fallback check in `server.js` with
the shared resolver rule. Send each alternative's own language, publisher, ISBN,
Open Library identity, and qualifiers instead of applying the selected search
filter language to every alternative.

Source policy remains independent. Every automatic candidate must also pass the
existing operator-policy filter, provider configuration checks, file validation,
and bounded attempt limit.

## Response contract

Keep all existing fields for compatibility:

- `works`, `bestEdition`, `editions`, `alternateEditions`;
- `recommended`, `alternatives`, and flattened `results`;
- source-specific acquisition and provenance fields.

Add to each work:

```json
{
  "sourceCount": 2,
  "sources": ["annas", "zlibrary"],
  "versionCount": 6,
  "resolution": {
    "confidence": "corroborated",
    "method": "confirmed-publisher-alias"
  }
}
```

Add an opaque `fallbackGroupId` to each projected version. Do not expose raw
evidence values or a global confidence percentage. Keep `editionCount` as an
alias of `versionCount` until a future breaking API version.

Document that `workId` and `workIdentity` identify a resolved search group, not a
permanent globally authoritative bibliographic record.

## UI behavior

The Hemingway result becomes one card titled `Complete Works of Ernest
Hemingway`.

- The disclosure summary reads `6 versions · 2 sources`.
- The card footer continues to show the selected version's format and source.
- Expanded rows show format, year, publisher, source, size, and language only
  when it distinguishes versions. Show meaningful qualifiers such as `Abridged`.
- Keep the best version selected first and allow direct Add actions for every
  version.
- Do not show merge confidence, duplicate, rights-verification, or source-warning
  pills on the card.
- Preserve rights/license/source data on each version and enforce acknowledgement
  when that version is selected.
- Results count continues to show resolved works plus total selectable versions.
- Source sorting uses the work's source set deterministically rather than only
  the currently selected version.
- The disclosure must remain keyboard-operable, have an accurate accessible
  label, and fit the existing mobile single-column layout.

## Implementation sequence

### 1. Lock the behavior with fixtures

- Add a static multi-source Hemingway fixture based on the current provider
  metadata, including the misleading shared ISBN on `The Sun Also Rises`.
- Add representative fixtures from Standard Ebooks, Gutenberg, Internet Archive,
  and OPDS so the resolver is not accidentally tailored to Anna/Z-Library.
- Record expected work count, version count, selected version, clean display
  title, source set, and automatic fallback groups.

### 2. Build the resolver module

- Add `lib/search-work-resolution.js` with private fact extraction,
  normalization, qualifier extraction, evidence rules, conflict rules,
  deterministic complete-link clustering, and fallback compatibility.
- Validate ISBN checksums and normalize ISBN-10/ISBN-13 representations.
- Keep the implementation pure: no filesystem, network, cache, clock, or global
  configuration dependencies.
- Add an optional diagnostic collector used only by tests and debug logging.

### 3. Integrate work construction

- Refactor `lib/search-work-groups.js` to consume resolved clusters.
- Preserve existing exact grouping behavior while adding corroborated aliases.
- Choose clean display metadata independently from `bestEdition`.
- Add source/version counts, resolution metadata, and fallback group IDs.
- Preserve deterministic ranking and all provider acquisition fields.
- Keep the existing exported normalizers temporarily if other tests/callers need
  them; remove duplication only after imports are migrated.

### 4. Harden automatic import fallback

- Replace the loose fallback matching helpers in `server.js` with
  `fallbackCompatibility` from the resolver.
- Update the browser request to send complete alternative identity metadata and
  only fallback-group-compatible alternatives.
- Keep the server-side check authoritative and retain the existing three-attempt
  bound and operator-policy filtering.
- Make progress copy report the actual filtered fallback count.

### 5. Update the search UI

- Render `versions · sources` in the disclosure summary.
- Improve row labels so users can distinguish versions without repeated generic
  “Edition” text.
- Use work display metadata for the card and selected-version metadata for the
  footer and Add action.
- Update source sorting, accessible names, mobile layout, and empty/count states.
- Do not add a merge badge or manual merge control.

### 6. Document and release

- Update `docs/API.md`, `docs/CHANGELOG.md`, and `docs/FEATURE_MATRIX.md`.
- Add `SEARCH_WORK_GROUPING_MODE=exact` as a temporary one-release escape hatch;
  default to `conservative` after the acceptance corpus passes. Remove the flag
  after a documented soak period if it is unused.
- Add opt-in `SEARCH_GROUP_DEBUG=1` structured local logs containing work IDs,
  methods, source IDs, and conflict codes. Do not send telemetry.
- Bump app-shell asset versions if browser files change.

## Test plan

### Resolver unit tests

Positive cases:

- exact Open Library identity;
- duplicate Open Library records with different keys and one exact shared
  trusted title/creator identity;
- exact normalized title and reordered creator name;
- narrow edition labels;
- one long-token title typo across sources with an exact compatible creator;
- one missing/transposed creator character across sources with an exact title;
- exact publisher phrase in prefix, suffix, and parentheses;
- the three Hemingway complete-work groups resolve to one six-version work;
- year and format differences remain versions of the same work;
- input permutations produce byte-for-byte equivalent resolution output.

Negative cases:

- `The Sun Also Rises ... Volume 2 of 21` remains separate despite sharing the
  Delphi publisher, author, and ISBN;
- same title with different creators;
- different explicit volume/part numbers;
- complete collection versus selected work;
- original versus study guide, summary, adaptation, or retelling;
- incompatible known languages;
- conflicting trusted Open Library work keys without one exact, unambiguous
  shared trusted title/creator identity;
- unknown creator plus publisher-title resemblance;
- same publisher with merely similar titles;
- short-title edits, author substitutions, two changed title tokens, and
  simultaneous title/creator typos;
- a transitive A-B/B-C match with an A-C conflict does not merge all three;
- cover equality, year, file size, or ISBN alone never causes a merge.

Fallback cases:

- EPUB/MOBI/AZW3 versions of the same full text may be tried automatically;
- explicitly abridged and unabridged versions display together but occupy
  different fallback groups;
- individual collection volumes never enter the collection fallback group;
- alternatives in a different language are rejected;
- a tampered client `fallbackGroupId` does not bypass the server check;
- disabled/unacknowledged sources remain filtered.

### Integration tests

- Extend `test/test-search-work-groups.js` for resolver behavior and stable IDs.
- Extend `test/test-catalog-search.js` for response shape, clean display metadata,
  source/version counts, legacy fields, and flattened results.
- Extend `test/test-server.js` for server-side alternative rejection and source
  policy composition.
- Confirm Open Library enrichment remains bounded to its existing candidate limit
  and provider failures still degrade independently.

### Browser tests

- Extend `scripts/smoke-browser.js` with a deterministic search response showing
  one Hemingway card, `6 versions · 2 sources`, and all selectable rows.
- Verify Add uses the chosen version and automatic fallback uses only the matching
  fallback group.
- Verify keyboard disclosure, screen-reader names, source sorting, responsive
  layout, counts, and cover fallback behavior.

### Performance and regression gates

- Result resolution adds no network calls. The separate zero-result correction
  path is bounded to one suggestion lookup, one catalog validation, and one
  retry of the same selected providers.
- Benchmark 150 provider results; target under 10 ms on the existing development
  hardware and no worse than quadratic behavior over an unindexed all-pairs scan.
- `npm test`, `npm run test:browser`, `npm run release:verify`, app-shell version
  checks, and `git diff --check` all pass.

## Acceptance criteria

1. The saved Hemingway response resolves the three complete-work cards into one
   work with six versions and two sources.
2. The clean card title is `Complete Works of Ernest Hemingway` regardless of
   which version ranks first.
3. `The Sun Also Rises ... Volume 2 of 21` remains a separate card and is never an
   automatic fallback for the collection.
4. Every grouped version retains its provider, acquisition fields, rights/license
   metadata, format, size, publisher, year, language, and cover descriptor.
5. Users can manually select every grouped version.
6. Automatic fallback crosses neither language nor content-form/volume conflicts,
   and the server revalidates every alternative.
7. Existing API consumers continue to receive `recommended`, `alternatives`,
   `results`, `editions`, and `editionCount`.
8. Results and IDs are deterministic across provider response order.
9. No cover lookup, image comparison, or new remote metadata request is required
   for grouping.
10. All release verification gates pass with the conservative resolver enabled by
    default.

## Deliberately deferred

- General fuzzy matching or machine-learned entity resolution.
- Perceptual cover hashing on the search critical path.
- A normal-user merge/split correction UI.
- A persistent global bibliographic database or FRBR-style edition model.
- Collapsing cross-source acquisition routes based only on ISBN/format/size.

These additions would increase false-positive risk or interface complexity without
being necessary to resolve the clear duplicates currently visible.
