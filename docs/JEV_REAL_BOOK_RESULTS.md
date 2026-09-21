# Jev on real books

Jev through **Vercel AI Gateway**, model `typesafe-ai/jev`, produced a small text-quality benefit. It does not make the existing local heuristics faster or cheaper. The integration is experimental and disabled by default.

## What was tested

Four public-domain works: Alice, On the Origin of Species, Walden, and Frankenstein. Actual Gutenberg EPUB/AZW3 files plus genuine scanned PDFs of Darwin 1859, Walden 1854 and Frankenstein 1831. Download manifests record URLs and SHA-256 values in `data/benchmarks/real-books/`. All formats of a work share its split: Darwin/Alice development, Walden/Frankenstein challenge. No manufactured corruptions count as real cases.

The first frozen run contains 100 cases. A second frozen run adds 18 Frankenstein repair cases. Prompts and labels were frozen before inference. Repair labels match three words on either side of the split word to the same-work EPUB transcription; these are **silver references**, not independently human-labeled gold. Two source pages were also visually inspected. The repair sample deliberately balances joined words and compounds and does not estimate natural prevalence. Frankenstein has 12 join cases and 6 eligible preserved-hyphen cases, rather than 12 each.

| Decision | Cases | Local correct | Confidence-gated correct | Consequence |
| --- | ---: | ---: | ---: | --- |
| Word repair, three scans | 66 | 35 | 47 | 12 diagnostic corrections, no observed regressions |
| Chapter type, EPUB | 26 | 20 | 25 | Four license appendices plus one detailed contents section |
| Running-header cleanup | 12 | 12 | 12 | No added benefit; no authored-refrain controls |
| Kindle candidate selection | 4 | 1 | 1 | Three files have no usable candidate; Jev cannot recover missing chapters |
| Extraction review warnings | 10 | 10 | 10 | No added benefit |

Confidence threshold 0.90 was fixed. Raw model answers are worse than the gated result on some categories. Rejection/low confidence keeps local processing. The Gateway alias does not identify an immutable Jev version.

## What changed

- Standalone Gutenberg licenses now receive `copyright` metadata using exact license markers. All four actual EPUBs pass before/after checks: text and unrelated chapter types remain identical. This correction uses deterministic code, with no API charge or latency.
- An optional PDF import pass can preserve a genuine hyphen that the local line-wrap normalizer would remove. It asks only about fixed alternatives from the original text. It never generates prose, removes extra text or chooses an extraction candidate.
- Cleanup, extraction selection, broad classification and quality-warning AI integration were not added: these tests did not establish a worthwhile application benefit for them.

The **actual capped production path** sent 64 judgments per scanned book. It accepted 2 Darwin repairs, 1 Walden repair and 0 Frankenstein repairs. All 3 accepted changes match the reference. Each serialized artifact rebuilt exactly. The complete extraction/repair/rebuild runs took 12.2 s, 8.5 s and 7.6 s respectively; these are not an isolated API-overhead comparison. This modest result is distinct from the 12 corrections in the stratified diagnostic.

Gateway reported $0 for these runs under current pricing. That is an observed charge, not a future cost guarantee. The model adds network latency to otherwise local processing. No speed or cost-saving claim is supported.

## Operation and limits

For new imports only, set all three server environment variables:

```dotenv
XANDRIO_JEV_REPAIRS_ENABLED=true
XANDRIO_JEV_EXTERNAL_TEXT_ACKNOWLEDGED=true
AI_GATEWAY_API_KEY=<Vercel AI Gateway key>
```

A Vercel management access token is not the inference key. Keep credentials outside version control. See [Privacy and Data Flow](PRIVACY.md#experimental-jev-pdf-repairs) before enabling external text processing.

The pass is limited to 64 source spans, 800 context characters each, 4 global concurrent calls and a 15-second deadline. Only high-confidence preservation of an existing hyphen is applied. Any failed/invalid/timed-out pass discards all tentative edits. The reported-cost stop is best effort, not a provider-enforced budget. The original PDF and raw source evidence remain for every accepted repair. Playback, cache misses and artifact rebuilding use the local document service and make no repair requests.

The sample is too small to establish a general error rate or confidence calibration. Leave this experiment disabled for workflows requiring guaranteed fidelity. No service was restarted or deployed, and no flag was enabled by this work.

## Repeatable evidence

All outputs below are local ignored artifacts; they contain public-domain book excerpts and no credentials.

- `download-manifest*.json`, `*.download.json`, `environment.json`: source and runtime provenance.
- `frozen-cases.json`, `frozen-repairs-frankenstein.json`: pre-inference labels/source spans.
- `gateway-results.json`, `gateway-results-frankenstein.json`: 118 completed judgments, usage, actual reported costs and failures/fallbacks.
- `production-path-live.json`, `*.production-path.json`: actual bounded integration decisions and rebuilt text.
- `classification-e2e-before.json`, `classification-e2e-after.json`: four real EPUBs; red then green.
- `repair-e2e-applied.json`, `repair-e2e-final.json`: real PDF extraction/recovery with applied fixture decisions.
- `cache-migration-e2e.json`: a real Alice EPUB with a valid v30 cache regenerates under v31, correcting metadata without changing text.
- `restart-e2e.json`: fresh-process artifact reads, existing playback normalization and narration chunking, with zero network calls.
- `final-code-provenance.json`: final source-file hashes. Initial live runs did not capture a complete dirty-worktree snapshot; request-hash replay links the recorded 192 calls to the final request builder.
- `import-transaction-e2e.json`: actual importer/artifact-store transaction replaying validated live decisions in isolated scratch storage; originals retained for both changed books.
- `fallback-e2e.json`: real PDF extraction with missing acknowledgment, partial provider error, malformed routing and deadline; each must preserve all baseline text.

Reproduction uses Node 24 and the project dependencies. `scripts/collect-real-book-judgments.js` collects actual extraction output. `scripts/freeze-real-book-judgments.js` freezes the documented sample. `scripts/benchmark-real-book-judgments.js <corpus-dir> --live` runs through Gateway with `AI_GATEWAY_API_KEY` and `AI_GATEWAY_SDK_PATH` (for example the absolute path to `node_modules/ai/dist/index.js`). Add `--repairs-only=frankenstein` for the supplemental frozen set. `scripts/benchmark-jev-pdf-import.js --live` runs the capped integration on the three scans. Verification scripts are named `scripts/verify-real-book-classification.js`, `scripts/verify-jev-pdf-repair-e2e.js`, `scripts/verify-jev-import-transaction.js` and `scripts/verify-jev-fallback-e2e.js`. Preserve previous reports; scripts refuse to overwrite finished artifacts where supported.

The first real-case run stopped on a local SDK rejection of undefined optional metadata; it is retained separately as `gateway-results-incomplete-undefined-state.json`. JSON serialization fixed the request representation before the completed run. An initial replay test exercised no accepted repairs; it is retained as `repair-e2e.json`, and does not count as positive integration evidence. The later applied-repair and transaction artifacts do.

## Dependency and model provenance

The application dependency `ai@7.0.105` comes from the [Vercel AI SDK](https://github.com/vercel/ai) and declares Apache-2.0. Its exact resolved tree and integrity hashes are in `package-lock.json`; generated dependency notices include its transitive packages.

Jev is TypeSafe's hosted model, accessed only through Vercel's `typesafe-ai/jev` alias. No model weights are included or redistributed, and no open-weight licence is claimed. Access is governed by the operator's applicable [Vercel AI Product Terms](https://vercel.com/legal/ai-product-terms), [Vercel provider notices](https://vercel.com/legal/notices-and-license-information), and applicable [TypeSafe service agreement](https://typesafe.ai/legal/mca). The MIT licence on the TypeSafe agent skill does not license the hosted model. The Gateway alias does not expose a pinned underlying model version.
