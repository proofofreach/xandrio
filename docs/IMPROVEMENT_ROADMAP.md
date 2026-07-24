# Improvement Roadmap

Updated 2026-07-24. This replaces the completed parts of
`HANDOFF-STRUCTURAL-DEBT.md` as the next engineering sequence.

## Current baseline

- `public/app.js` is 1,442 lines; the earlier frontend extraction target is
  effectively complete.
- `server.js` is 3,785 lines and still owns several domain-heavy handlers.
- Playback routes have been extracted, and the application shell test derives
  the frontend import graph.
- The full suite passes: 1,830 tests in 68 suites.

The next work should reduce failure coupling and improve recovery. Line-count
reduction is a consequence, not the goal.

## 1. Extract book lifecycle services

**Why first:** deletion and metadata refresh combine HTTP concerns, persistence,
cache cleanup, authorization, provider calls, and response shaping. Moving the
handlers verbatim would only replace local coupling with oversized factories.

Build these seams in order:

1. `lib/book-deletion.js`
   - Accept a book id and authenticated actor.
   - Decide authorization and ownership in one place.
   - Remove the library record, shelf references, source artifact, cover, and
     generated audio through explicit collaborators.
   - Return a typed result; do not write HTTP responses.
2. `lib/book-metadata-refresh.js`
   - Load the book, select metadata sources, normalize updates, refresh the
     cover, persist the result, and report partial provider failures.
   - Keep provider policy and field precedence testable without booting Express.
3. Extract thin library/book routes only after those services exist.

**Acceptance:** route handlers perform validation, call one service, and map its
result to HTTP; fault-injection tests cover failure after every destructive or
persistent step; existing route responses remain contract-compatible.

## 2. Make persistence durable and recoverable

The JSON store now prevents truncation and quarantines corrupt content, but it
does not yet provide an operator recovery path or power-loss durability.

- Remove settled per-file lock tails from the lock map without allowing a newer
  lock to be deleted by an older completion.
- Flush the temporary file before rename and the parent directory after rename
  on platforms that support it.
- Add bounded backup rotation for critical stores before replacement.
- Validate the top-level shape of critical stores before accepting them.
- Add a CLI that lists quarantined copies and restores one only after validating
  it and preserving the current file.

**Acceptance:** tests cover process failure before write, before rename, after
rename, and during quarantine; lock-map size returns to baseline; a documented
restore drill recovers a fixture library without data loss.

## 3. Standardize cancellable browser lifecycles

Recent defects came from the same underlying pattern: listeners, timers, and
promises outliving the operation or initialization that created them.

- Add a small disposable scope for event listeners, intervals, timeouts, and
  abort controllers.
- Add one cancellable media-event wait helper with timeout and generation/abort
  handling.
- Migrate both chapter players, queue polling, sleep timer restoration, and
  view re-initialization to these primitives.
- Require teardown to be idempotent.

**Acceptance:** repeated initialization leaves listener and timer counts
unchanged; superseded loads reject promptly; stalled media resolves to a visible
recoverable error; tests use fake time rather than real waits.

## 4. Add operator diagnostics and repair

Expose useful recovery state without exposing credentials or library contents.

- Expand health diagnostics with storage writability, quarantined-store count,
  queue state, engine availability, and cache-space warnings.
- Add an admin-only diagnostics view with copyable, redacted output.
- Link corrupt-store findings to the recovery CLI instructions.
- Provide safe actions for retrying a failed engine probe and rebuilding stale
  derived metadata; do not offer destructive cache clearing as a first resort.

**Acceptance:** trusted-LAN and authenticated modes enforce the intended access;
redaction tests cover tokens, provider keys, paths, titles, and user data; each
reported fault names a concrete next action.

## 5. Make offline audio self-repairing

Cold offline boot is protected by import-graph precaching, but downloaded audio
can still become incomplete or stale without a clear repair path.

- Persist a per-book offline manifest with expected chapters, variants, sizes,
  and content identifiers.
- Resume interrupted downloads and verify each entry before marking the book
  available offline.
- Show `ready`, `incomplete`, `stale`, and `repairing` states.
- Repair only missing or invalid entries and preserve usable audio.

**Acceptance:** browser tests interrupt downloads at several boundaries, corrupt
one cached response, change a voice variant, and verify targeted recovery while
offline playback continues for intact chapters.

## 6. Strengthen boundary and fault tests

- Derive and compare the full Express route contract before and after each route
  extraction.
- Add stream-reset, file-disappearance, disk-full, permission, and abort
  injection at I/O boundaries.
- Run a focused mobile PWA smoke test for cold offline boot, background/resume,
  chapter replacement, and lock-screen controls.
- Keep the full suite as the merge gate; add focused suites beside the module
  they protect.

**Acceptance:** each production failure class above has a deterministic
regression test, and tests fail for the intended reason when the guard is
temporarily removed.

## Delivery order

Use small, independently reversible commits:

1. Characterization tests for book deletion and metadata refresh.
2. Book deletion service and thin route.
3. Metadata refresh service and thin route.
4. JSON-store durability and recovery CLI.
5. Browser lifecycle primitives and migrations.
6. Diagnostics endpoint and admin view.
7. Offline manifest and targeted repair.
8. Remaining route extraction, one cohesive route group at a time.

Do not combine route moves with behavior changes. Do not start a broad state
management rewrite, database migration, framework conversion, or service split
until these boundaries exist and measured needs justify the added machinery.
