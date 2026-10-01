# Real processing benchmark

Run on Node 24 with the pinned public-domain sources present locally:

```sh
npm run benchmark:processing-real
npm run verify:processing-real
```

The first command runs six genuine books through the production importer in
temporary storage. It checks EPUB disk caches and MOBI/PDF XBook artifacts, then
reads them in a fresh process. It does not use the live library, download sources,
call models, or update reference fingerprints. The importer evaluator persists
book records in memory and artifacts on disk; this is processing E2E evidence,
not an HTTP or browser interaction test.

The frozen manifest is [processing-real-corpus.json](../test/fixtures/processing-real-corpus.json).
It records source URLs, rights, checksums, language, format, baseline fingerprints
and separately verified source assertions. Place each file at its manifest path.
The EPUB/MOBI and scanned PDF sources already used by prior assessments are
reused. Original German Kafka and French Maupassant EPUBs add missing language
coverage. Their Project Gutenberg source pages are linked in the manifest.

| Case | Format | Language | Specific source check |
| --- | --- | --- | --- |
| Kafka | EPUB | German | Ordered passages with authored punctuation and diacritics |
| Maupassant | EPUB | French | Original prose with accented letters |
| Leaves of Grass | EPUB | English | Exact consecutive verse lines from authored `<pre>` markup |
| Huckleberry Finn | MOBI | English | Authored chapter marker and its opening prose |
| Meditations | MOBI | English | A source note appears exactly once in the Notes chapter |
| Walden | Scanned PDF | English | A visually checked passage belongs to source page 9 |

Normalized whole-book hashes allow NFKC and whitespace normalization. Separate
exact text hashes detect formatting changes, and verse assertions compare
individual consecutive lines. Both the source markup/page and persisted output
must satisfy the references. A fresh-process artifact round trip must retain
the same text and chapter count. Networking is disabled in the runner and its
artifact reader.

Whole-book hashes were frozen from deployed source revision
`38ec736ab87cd62ef8692b75de71aacd9ff9075e` before evaluating this change. They are
regression fingerprints, not independent proof that every word was extracted
correctly. The source assertions prove only their recorded passages. The scanned
PDF's complete OCR text is not independently transcribed. This small selection
does not establish accuracy across all languages or layouts. Authored Unicode
joiners remain covered by the separate targeted synthetic import regressions;
this real-book selection does not contain a verified Indic/Persian joiner case.

Source bytes are kept under ignored `data/benchmarks/`. Sources may change at
their public URLs. A checksum mismatch or missing file fails explicitly; it must
not silently replace a pinned edition or update expectations. Reacquiring a
changed edition requires a separate reviewed manifest change. No source is
downloaded during this gate, and unavailable cases cannot count as passed.

The CLI accepts `--manifest`, `--source-root`, `--case`, and `--output`. A selected
case is reported as a partial selection. It never claims the full corpus passed.
Default JSON evidence is a new `output/playback-processing/real-processing-*.json` file;
CLI gate evidence is `real-processing-gates.json`. Reports record the manifest
hash, source revision, dirty-worktree flag, implementation hashes and each
failed check. Existing files and destinations inside source/library/test storage
are refused, including symlink aliases. Each run writes a new report. Keep
output outside source/library storage.

The CLI E2E checks were written before the runner. They exercise real books and
altered manifest controls for checksum drift, unavailable sources, missing
provenance, punctuation/diacritic/joiner disagreement, missing or reordered
passages, exact-text drift despite normalized equality, verse loss, duplicated
notes, incorrect scanned-page references and empty runs. These fault controls
are distinct from naturally observed extraction failures.
