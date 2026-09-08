# Retain completed offline audio across upgrades

An implementation-version change could reset an offline title to chapter zero,
even when the server already held a complete compact package. A production title
with 46 chapters had two complete older package sets but was preparing chapter 9
again. Three chapters were empty dividers; each completed set contained all 43
narrated chapters. The preparation gate prevented the iOS transfer from starting.

Completed packages now have a managed per-book ready catalog. Selection requires:

- The same library entry (`addedAt`), normalized language, ordered effective
  pronunciation-transformed text, and empty chapter layout.
- The same explicit voice and audio profile. Only implementation `prepN` and
  `audioN` segments are omitted from the compatibility key. Voice references,
  chunk size, output format, bitrate, pause, and other profile choices remain.
- Every committed package sidecar still resolves to its recorded artifact ID.

Selection reads metadata; it does not hash audio bodies or generate speech.
Retained manifests keep the original package identity and derive source identity
from the catalog's semantic revision and ordered artifact IDs. They do not
re-evaluate an old recording against the latest narration recipe.

Incomplete recipes are not pinned to old implementations. Ordinary preparation
first checks for an existing compact legacy file and validates it before asking
for a stitched source. Thus reclaiming an old stitched file cannot force
unnecessary TTS when its compact download already exists.

The coordinator captures semantic identity at admission and checks it through
the last chapter and ready publication. Switching to a complete retained package
persists the replacement intent before aborting and discarding the obsolete
request's claims. Existing rendered bytes and other consumers' claims remain.

Ready-catalog publication is awaited inside the preparation worker. Its atomic
rename checks the request, narration input, and cancellation state. Deletion waits
for that worker before removing the managed catalog and audio artifacts.

## Operator recovery of an older package

Earlier packages lack a catalog. Recovery requires the exact original source
variant and an explicit operator assertion that the selected set belongs to the
book and voice. This assertion is not proof of the historical narration recipe.
Recovered bytes remain `legacy-unverified`; the catalog records
`associationSource: "operator"`.

Run on the server, using its existing environment file:

```sh
node --env-file=.env scripts/recover-offline-package.js \
  --book BOOK_ID \
  --voice ORIGINAL_VOICE \
  --source-variant ORIGINAL_VARIANT \
  --accept-unverified-source-association
```

The CLI authenticates to the loopback server with `XANDRIO_TOKEN`. It does not
edit the live generation journal. The admin-only recovery endpoint uses the same
book lifecycle lock as deletion and reimport, admits one recovery at a time, and
validates at most two chapters concurrently. Every nonempty chapter must exist
before validation starts. Validation checks decoding, format, and byte integrity,
then publishes immutable artifacts without TTS or transcoding. On failure, sibling
validation is aborted and awaited before the lock is released. Client disconnect
and server shutdown also cancel the operation.

The final receipt includes the original package variant, validated byte count,
legacy provenance, and server preparation state. An incomplete set never receives
a ready catalog. Recovery does not prove that a physical iPhone has completed its
device transfer; that remains a separate verification step.

## Review record

The independent Sol xhigh design review accepted completed-only retention with
seven required amendments. All were checked against the code and accepted:

| Finding | Amendment |
| --- | --- |
| Detached ready notification work could publish after deletion. | Await catalog publication in `beforeReadyCommit`, with a guard before atomic rename. |
| Historical source identity still entered current recipe comparison. | Use explicit retained identity and require the catalog's exact artifact IDs. |
| Raw text omitted semantic inputs and reimport identity. | Include effective pronunciation text, language, empty topology, and `addedAt`. |
| Independent identity resolution could disagree across API surfaces. | Pass the resolved identity through status and manifest inspection; retained windows use the same resolver. |
| Replacement waited behind a stalled old chapter. | Persist the replacement, then abort its predecessor and remove only predecessor claims. |
| A legacy association could be mistaken for recipe proof. | Preserve legacy provenance and require an explicit operator association flag. |
| A standalone recovery writer could race deletion or reimport. | Route recovery through the authenticated server and its book lifecycle lock. |

Regression coverage includes version upgrades, explicit voice/profile changes,
semantic changes, missing/replaced artifacts, cancelled publication, authorization,
deletion locking, sibling cancellation, and shutdown. A real-server integration
fixture validates compact MP3s with absent stitched sources, exercises recovery,
and checks consistent preparation/manifest identity and exact HTTP range bytes.

The implementation review found a same-package transition gap. This finding was
accepted and verified: the coordinator compared package and semantic revisions,
but did not compare retained catalog identity. The catalog revision now hashes the
semantic revision, package variant, and ordered artifact IDs. Admission compares
that revision, including its absence, and cancels the old worker when a catalog
appears, disappears, or changes. A regression covers all three transitions.
Retained ready passes preserve the original catalog and operator association.
The real-server fixture checks that association after readiness.

Validation before this amendment passed all 3,406 tests across 179 suites and the
browser smoke check. After the amendment, the catalog tests passed 6/6,
coordinator tests 33/33, and real-server integration tests 4/4. The production
release command runs the full required gates again against the committed revision.

Ratification caught a completion mismatch introduced by the catalog comparison.
The ready hook now returns its published identity. The coordinator adopts that
exact catalog revision into the same request before persisting ready, then checks
it against the resolver. A deterministic regression verifies normal preparation
stays ready after publishing its catalog and generates the chapter only once.

Final independent ratification: ENDORSED, verdict SHIP. All seven design findings
are retired. Independent focused checks passed 33 coordinator, 6 catalog,
6 recovery, and 4 real-server integration tests. No blocker remains.

## Ready size and repeated admission

The production WebKit check exposed a second metadata problem. Revalidating an
already ready title persisted the byte count of the chapters checked so far while
keeping `state: ready`. Napoleon's 807 MB package appeared as about 1 MB, and the
client reached 98 percent long before the transfer finished.

Ready revalidation now preserves the previous complete byte count until all
chapters have been checked. Retained selection also returns the exact sum of its
validated artifact sizes. A request for the same retained ready package updates
its owners and byte count without scheduling another chapter scan. Selection
still checks every recorded artifact first; a missing catalog, changed artifact,
or changed narration input takes the normal replacement and repair path.

Regression tests hold the last chapter during revalidation, check stable complete
bytes, verify owner updates without repeated chapter scans, and exercise repeated
real-server preparation requests with exact total sizes.

Independent Sol xhigh review of this amendment returned SHIP with no blockers.
It verified the retained shortcut still checks exact artifacts, identity changes
still cancel and schedule repair, and completed workers cannot restore partial
byte counts. Focused checks passed 35 coordinator, 6 catalog, and 4 real-server
integration tests.
