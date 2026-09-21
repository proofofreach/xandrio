# Jev real-book evaluation

Goal: test existing processing on genuine books and implement only changes supported by measured benefit. All inference uses Vercel AI Gateway model `typesafe-ai/jev`. Existing deterministic processing is the baseline; no speedup is assumed.

## Evaluation before implementation

1. Acquire public-domain EPUB, Kindle, and scanned PDF sources. Record source URL, rights, SHA-256, extraction tools and versions. Keep original files and raw output in ignored benchmark data. Do not synthesize corruption and count it as a real example.
2. Run the actual import pipeline. Compare all actual extraction candidates where available. Sample classification, extraction selection, repeated-line cleanup, bounded OCR/hyphen repair and quality warnings. Include clean controls, and retain the source page/context needed to independently label each example.
3. Freeze source-based labels and book-separated development/evaluation assignments before evaluating Jev. Ambiguous source readings and equally valid candidates are ties or excluded with reasons. Measure stage accuracy, harmful overrides, end-to-end text preservation, latency, tokens and Gateway-reported cost. Reference pricing is separately labeled. Preserve every failure, fallback and excluded case.
4. Keep confidence threshold 0.90 initially. Do not tune on evaluation books. A category qualifies only with observed corrections on evaluation books and no destructive overrides in those cases. Small samples establish a bounded observed benefit, not a general reliability guarantee. If a category has no baseline failures or no accepted corrections, do not implement it merely because the synthetic benchmark looked good.

## Implementation constraints

After results, select the narrowest integration for qualifying categories. Use bounded inputs, typed decisions, explicit configuration and Vercel Gateway credentials. Never replace deterministic quality hard-fail safeguards with a model approval. Never rewrite prose freely. Retain baseline on timeout, invalid response, low confidence or missing credentials. Bound calls per book and concurrency. Store sufficient source and decision metadata so rebuild/cache/playback do not need network or produce different text. Verify artifact recovery invariants and existing import tests. Production source handling must remain understandable and reversible.

## Doubts for independent review

- Can labels for selection be reliable without page-aligned text and completeness checks?
- Where does chapter metadata normalization differ from actual EPUB classification?
- Can decisions be replayed without violating extraction-recovery proofs?
- How can a small corpus support a safe opt-in integration without overstating confidence calibration?
- Are synchronous normalizers a reason to place optional judgment after candidate generation instead of inside normalization?

## Review

Pending independent review before production implementation.

## Failure modes to verify before further implementation

- Synthetic metadata is accidentally attached to real cases, or an isolated classifier is presented as the full importer. Record the actual imported chapter type and selected candidate as baseline.
- An EPUB edition disagrees with the PDF spelling. Only label repair spans when local surrounding words align with the reference; exclude ambiguous joined/hyphenated alternatives.
- The normalizer changes unrelated whitespace and earns a false correction. Compare the exact target span in actual normalized page output; preserve all other text.
- Candidate samples omit missing chapters. Retain full candidate stats and source completeness checks; never equate a clean excerpt with a complete book.
- A model's broad category change has no product effect. Measure narration filtering/default start as well as metadata accuracy.
- Timeout, malformed output, missing confidence, wrong route, unknown billing or provider retry causes unsafe application or misleading success. Fail to baseline and preserve diagnostics.
- Reprocessing changes accepted text or calls the API again. Verify deterministic artifact roundtrip and offline reading.
- Prompts, source bytes, labels or thresholds drift between runs. Hash each and keep immutable reports. Group every format of a book in the same split.
- A small favorable set hides regressions. Preserve clean controls, excluded cases, raw model outcomes and all low-confidence fallbacks; do not claim population reliability.

Verification will use repeatable real-file end-to-end artifacts and existing tests. No new unit tests will be added after implementation.

## Independent review, 2026-09-21 — gpt-5.6-sol xhigh

Verdict: ship-with-changes for evaluation; production not yet justified.

1. **Accepted-verified:** Kindle candidates for Alice/Walden/Frankenstein contain no book prose. `neither` is a diagnostic result, not an implemented selection improvement. Track parser/completeness failure separately.
2. **Accepted-verified:** synthetic samples were not aligned or bounded. Real runner limits five chapter windows and 900 characters per paragraph, states that they are unaligned, and excludes PDF selection ties. Any deployed selection requires source-wide coverage evidence.
3. **Accepted-verified:** retained PDF pages are already normalized. A production repair must preserve raw source evidence and accepted span hashes, replay deterministically and retain the original for model-affected imports. No destructive post-hoc guessing.
4. **Accepted as risk judgment:** the original qualification threshold was too weak. Require benefit on at least two independent evaluation works, no harmful overrides or unrelated edits. Small-sample benefit can qualify only an explicit experimental opt-in, not default automatic text changes. Record uncertainty rather than calling confidence calibrated.
5. **Accepted-verified:** collector is an extractor/import-document diagnostic, not the importer transaction. Real reports now state this. Production qualification requires isolated importer/recovery E2E with tool versions and hashes.
6. **Accepted-verified:** final metadata subtype accuracy is insufficient. The frozen real cases use actual imported types and separately record filtering effects; deployment requires actual narration consequences.
7. **Accepted-verified:** current PDF repeated-line examples are all running furniture. Header cleanup is ineligible without authored-line controls and additional independent scans.
8. **Accepted-verified:** use Vercel only, dedicated `AI_GATEWAY_API_KEY`, one Typesafe provider attempt and explicit opt-in disclosure for external text. No application SDK/config changes until evidence qualifies a category.

Downloads named “extra” and “holdout” are acquisition batches, not evaluation splits. The frozen corpus assigns all Darwin/Alice formats to development and all Walden/Frankenstein formats to challenge. Repair labels are aligned EPUB silver references, not human gold labels. First live attempt stopped at a local SDK rejection of undefined optional metadata; preserved as `gateway-results-incomplete-undefined-state.json`. After JSON normalization, the separate run uses the same frozen labels.

## Narrow implementation decision

The third scan (Frankenstein, 1831) adds 18 frozen repair cases: 12/18 baseline, 14/18 confidence-gated hybrid, two corrections and no regressions. Across the three scans: 35/66 baseline, 47/66 hybrid, 12 corrections and no observed regressions. Evaluation works Walden and Frankenstein both improve. This supports only an experimental opt-in preserving ambiguous line-wrap hyphens, not arbitrary OCR rewriting or default automatic cleanup.

Implementation: generate proposals from the selected candidate's raw pages; only exact `letters-\nlowercase` spans that baseline joins are eligible. Ask the same narrow question/alternatives as evaluated. Apply only high-confidence preservation of the existing hyphen, never generated prose. Bound proposal context, calls per book, global concurrency and total duration. Rebuild selected candidate from repaired raw pages before creating the extraction result. Keep raw source pages, accepted source-span hashes and Gateway accounting; force retention of original PDF. Rebuild/playback use stored normalized source, never inference. Disabled unless both explicit external-text acknowledgment and experimental repair flag are set, with a dedicated Gateway key. Clean-up, selection and quality integration remain ineligible. Standalone Gutenberg legal appendix classification is fixed deterministically using exact markers.

Before implementation, E2E verification must exercise: disabled path makes no calls; enabled extraction changes only recorded spans; low-confidence/error/invalid response preserves baseline; original is retained even if recovery roundtrip matches; rebuilding serialized artifact uses no network and matches accepted text; actual Gateway attempts/metadata/cost recorded. Independent final review remains required.

## Implementation review amendments

- Accepted-verified: partial accepted repairs survived a later provider failure. The repair pass is now atomic: error, deadline or accounting stop discards all tentative edits and returns the baseline. Reports distinguish applied from discarded decisions.
- Accepted-verified: a released concurrency slot could be taken by a newcomer before a queued waiter resumed. Slots are now handed directly to queued waiters.
- Accepted-verified: the shared document service is also used for playback/cache misses. Repair injection now uses a separate import document service wired only to the importer.
- Opus code-gate attempt failed in the unrestricted host environment with `OAuth session expired and could not be refreshed`. No review was returned. A fresh gpt-5.6-sol review is used as the available independent fallback; record this gap, do not claim Opus approval.
- The capped production-path live run sent192 requests across3books and accepted3 repairs (Darwin2,Walden1,Frankenstein0), all matching the aligned EPUB reference; exact serialized rebuild matched every book. These are the production-path gains, distinct from12/66 gains in the stratified diagnostic.


Final review closure: cache version 31 invalidates stale version-30 EPUB chapter caches. A real Alice cache test failed before and passed after, preserving text. Retained raw PDF evidence now contains only pageNumber/text, avoiding duplicated bbox geometry. Fresh-process playback passes with zero network calls; playback uses its existing repairTextArtifacts normalization, so its hash is deliberately distinguished from raw artifact narration. Accepted compounds survive. Live validation now fails on reference mismatch, rebuild mismatch, incorrect source-retention proof or truncated passes. All 192 production request hashes match the replay; the claimed five-request eligibility drift was not reproduced.

Final verification limitation: git commands became unavailable because the host now requests Xcode license acceptance. No licence was accepted on the user's behalf. Earlier diff checks passed; final syntax, E2E and targeted tests are used with file hashes. The initial live run did not preserve a complete dirty-worktree snapshot; final code provenance is recorded separately and does not retroactively supply it.
