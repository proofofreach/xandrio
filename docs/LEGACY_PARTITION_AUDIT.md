# Legacy partition audit

Run on Node 24:

```sh
node scripts/audit-legacy-partition.js
node scripts/audit-legacy-partition.js --data-dir /path/to/library/data --output /path/to/new-report.json
```

The command reads retained EPUBs and their persisted `.chapters.json` caches.
It does not rebuild, repair, migrate, or delete anything in the library. It
makes no external requests. Reports default to a new file under
`output/playback-processing/`; the same report is printed to standard output.
Reports contain opaque book IDs and counts, without book metadata, private
paths, prose, or content hashes.

The command refuses report destinations inside the library data directory,
source/cache directories, or symlinks into those directories. Existing files
are never overwritten. Keep reports outside library storage.

| Classification | Meaning |
| --- | --- |
| `source-preserved` | Cached normalized text equals fresh extracted source, with matching ordered chapter/part identities. |
| `known-legacy-rewrite` | Every cached part and the complete normalized stream exactly match the reviewed historical partitioner, and differ from fresh source. This identifies the old rewrite; it does not prove that repair can preserve playback positions. |
| `unexplained-mismatch` | Source text, ordering, part metadata, or cache structure does not meet that proof. This is not a diagnosis of a current processing defect. Other historical extraction changes can also produce differences. |
| `source-unavailable` | The retained EPUB is missing/unreadable, or its persisted cache is missing. |
| `unsupported-transform` | The current speech helpers no longer match the reviewed implementation fingerprints. Historical replay is disabled. |

The historical reference is commit
`6cc4d30e5cd445020aa45351c276720bd6afee95`, immediately before the partitioning
fix. The detector uses the reviewed current `splitOversizedText`, whose
preparation is equivalent to that historical implementation. It pins the
complete speech helper files and their numeric/legal dependencies. A future
change requires review before updating those pins. `prepareTtsText` is not an
equivalent substitute: it also applies scaled-amount and prose-year changes.

Text equality means NFKC normalization and collapsed whitespace. It does not
verify original HTML layout, verse line breaks, extraction correctness, or
speech quality. EPUB source identities, complete part numbering, per-part
text, and whole-stream text must all match before identifying a historical
rewrite. Kindle/PDF artifacts are outside this command's scope. An input
change detected during extraction produces an inconclusive result.

Exit status 0 means the audit completed, even when it found mismatches. Exit
status 2 means an incomplete audit, unsupported transformation, or unsafe
report destination. The command does not mark anything repaired. A future
repair needs its own proof for saved positions, bookmarks, stale client
writes, audio replacement, and transaction recovery.

Repeat the CLI E2E checks with:

```sh
node scripts/verify-legacy-partition-audit-e2e.js
```

The E2E harness uses valid synthetic EPUBs, actual persisted chapter caches,
and an independent historical oracle loaded from the immutable Git revision.
It checks rewrite detection, same-length changes, missing/reordered parts,
identities, unavailable sources, fingerprint drift, report privacy, protected
destinations, and unchanged library/state/audio bytes. A network guard blocks
external requests. These fixtures do not count as real-book coverage.

Before/after E2E evidence is saved as
`output/playback-processing/legacy-partition-audit-before.json` and
`legacy-partition-audit-after.json`. The final rerun, including file/directory
modification checks, is `legacy-partition-audit-final.json`. The read-only local-library run is saved
as `legacy-partition-audit-library-20260930.json`. That run found one exact
historical rewrite. The other EPUB cache with oversized parts failed the
historical proof and remains an unexplained mismatch. No book was changed.
