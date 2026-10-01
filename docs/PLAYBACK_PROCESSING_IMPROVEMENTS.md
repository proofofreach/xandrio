# Reviewed playback and processing improvements

The five suggestions were reviewed against deployed source `38ec736` by a fresh
`gpt-6-astra` agent with `xhigh` reasoning. The accepted scope adds processing
safeguards and developer verification without new player controls, settings,
notices or background migration.

| Suggestion | Review decision | Result |
| --- | --- | --- |
| Real iPhone validation | Accept as a physical-device gate | Extended the existing iPhone checklist for Bluetooth, explicit Pause after interruptions, and pending/rapid book selection. Added a build/device evidence template. Physical validation remains pending. |
| Runtime source conservation | Accept | Structure transformations compare normalized text before and after splitting/sequence normalization. Unexpected changes fail before cache publication. Chapter copies prevent failed in-place transformations from corrupting shared read caches. EPUB, XBook and the first Kindle partition inside the parser worker are covered. |
| Repair older imports | Narrow to read-only detection | A maintenance command identifies only exact historical rewrites. It refuses unexplained mismatches and never changes books or state. Repair is deferred until an explicit durable position mapper is verified. |
| Sentence timing | Defer | Current saved offsets are already marked approximate. Audio engines lack a shared source-alignment contract. More ratio estimates would not justify a precision claim. |
| Real-book processing benchmark | Accept a bounded extension | Six pinned genuine books cover three languages, EPUB/MOBI/scanned PDF, poetry and notes. Source assertions and fresh-process disk artifact round trips are checked offline. |

Before implementing the runtime guard, the E2E harness reproduced substitutions,
same-length replacements, deletion, duplication, reordering, empty output,
boundary loss, in-place mutation and text loss during sequence normalization.
Those checks must reject without publishing a cache, retain existing artifacts,
and allow a clean retry. Legitimate normalized Unicode/whitespace and ordinary
partitioning remain accepted. No cache version bump reprocesses existing books.

Read [the legacy detector documentation](LEGACY_PARTITION_AUDIT.md),
[real-book benchmark contract](REAL_PROCESSING_BENCHMARK.md), and
[iPhone checklist](../IPHONE-TEST.md) for repeat commands and evidence limits.

The legacy detector found one exact historical rewrite in the local library.
That finding does not make automated correction safe: stored offsets, old-client
writes and generated audio refer to the previous narration. Existing rebuild
transactions intentionally reject unequal narration. A future correction must
map arbitrary old coordinates, preserve unaffected state and replace audio only
under the fingerprint contract. That change was not approved for this pass.

Physical iOS verification remains an external requirement. Desktop Chromium,
WebKit and device profiles cannot substitute for an actual iPhone result tied
to the exact build.

## Verification of this implementation

The existing repository suite passed all 3,500 tests across 184 suites. Native
Chromium checks passed 30 playback/processing scenarios and four book-switch
scenarios. The partition guard passed 43 E2E scenarios; the legacy detector
passed 22; the real-processing benchmark gate passed 21. All six genuine-book
imports passed source assertions and fresh-process artifact reads.

The Kindle worker checks the first partition before candidate selection. Nine
real-MOBI scenarios verify rejection of eight injected text faults before cache
publication and a clean retry with the original pinned narration fingerprint.

An independent `gpt-6-sol` review with `xhigh` reasoning found no remaining
blocker after the benchmark report writer was protected against overwriting
sources, library files, existing reports and source-directory symlink aliases.
Reports and traces are under `output/playback-processing/`; the evidence index
is `IMPROVEMENTS_VERIFICATION.md`. These checks verify the local implementation.
These results were recorded before production promotion. Physical iPhone checks
remain unrun; opening the installed app through Mirroring did not verify playback.
