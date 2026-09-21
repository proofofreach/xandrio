# Jev assessment: EPUB, MOBI and existing model work

Status: main assessment complete; supplemental start-selection run blocked after 6/18 cases by repeated Gateway capacity limits. This assessment uses Vercel AI Gateway `typesafe-ai/jev`; it changes no production behavior. Earlier PDF results are in [the first report](JEV_REAL_BOOK_RESULTS.md).

## Supported findings

**The strongest measured opportunity is study-guide verification.** In the initial paired screening, both Jev and the configured GLM model answered all 48 controls correctly. Jev can supply the supported/unsupported decision directly. Median successful request latency was 0.523 seconds for Jev versus 5.366 seconds for GLM: 10.3× lower. Gateway reported $0 for these Jev calls. GLM’s reported tokens imply $0.0476 at its catalog list rates, not a verified bill. At the frozen conservative thresholds, Jev resolved 39/48 and escalated nine; this is a control-set result, not an estimate of production savings.

The two production-shaped 24-item Jev batches also answered all 48 controls correctly, with 37 resolved and 11 escalated under the same thresholds. They include 16 reused screening claims and 32 new composed guide fields, so the combined evidence is **80 unique verification controls**, not 96 independent claims. Prince completed in 0.535 seconds versus GLM's 11.613 seconds. Liberty completed in 0.945 seconds after a retained Gateway capacity failure; GLM returned invalid/truncated JSON at its production 1,500-token output cap. A separate 6,000-token GLM control answered Liberty 24/24 in 14.312 seconds. That control uses a different budget and is not a production-setting speed comparison.

Across these verification controls there were no confident false accepts or false rejects. The total guide-generation speedup is unmeasured: extraction, prose generation, repair, retries and network availability remain outside that claim.

**EPUB and MOBI were tested.** On the primary section-role sample, accepted Jev decisions improved correctness from 71/106 to 97/106: EPUB 48/62 to 56/62, MOBI 23/44 to 41/44. There were 26 corrections and no accepted regressions. The original sample has 107 roles; one overlapping rights/auxiliary label was excluded after review, with its raw result retained. This is a purposive diagnostic, not a random accuracy survey.

Replaying those type decisions did **not** change either playback-start selector in any of the 12 book/format combinations in that probe. Playback still includes all nonempty chapters. Guide input fell by four segments each for Liberty, Prince and Souls in MOBI, but rose by two for Meditations EPUB and one for Prince EPUB. Labels alone are therefore not a complete integration design. They can admit unwanted material as well as exclude it.

The first 20 boundary probes produced no accepted joins at the frozen 0.95 merge threshold. Raw answers identified the one real continuation, but its confidence was below the gate. That result proves no accepted chapter-repair gain.

The subsequent exhaustive Carol check covered all 32 adjacent pairs, including seven true continuations. Raw answers were correct on 29/32, but none of the seven joins passed the frozen confidence threshold. EPUB remained nine narrative chunks and MOBI eight, instead of five authored staves. There were zero wrong merges and zero accepted repairs. This is evidence against deploying the tested automatic-merge policy; lowering its threshold would require a separate validation set.

A supplemental **direct reading-start** diagnostic completed 6/18 planned book/format cases before repeated Gateway capacity failures, including a retry after a 60-second pause. Raw selections matched all six references; the frozen confidence gate improved both actual start selectors from 2/6 to 4/6 with two corrections and no regressions. It corrected the license-notice start in Huckleberry MOBI and the skipped early poems in Leaves EPUB. Both corrections were also made by the frozen deterministic comparator. That comparator scored 3/6 on this subset; Jev's hybrid advantage came from retaining an already-correct baseline on Meditations EPUB, not an additional model correction. Therefore this partial test does not establish a unique Jev advantage over improved rules. The remaining 12 cases are explicitly untested, and the 14/18 full-set rule score must not be compared against six Jev cases. This was an adaptive diagnostic, not an independent holdout.

Two processing defects have a better first remedy in code: Huckleberry MOBI contains 43 explicit chapter markers within 16 extracted narrative chunks, and deterministic reconstruction recovers all 43 without changing narration text. Leaves EPUB contains 400 preformatted blocks whose line breaks are lost by the current sanitizer. Preserve those source boundaries; adding model calls is unnecessary for these cases. Audio quality was not tested.

## Coverage

Eight additional public-domain works, each as EPUB and standalone MOBI6: Huckleberry Finn, Leaves of Grass, Moby-Dick, The Adventures of Sherlock Holmes, Meditations, On Liberty, The Prince, and The Souls of Black Folk. Source binaries, download failures/retries, SHA-256 hashes and extraction snapshots are retained locally in `data/benchmarks/jev-expanded/`. Pride and Prejudice downloads failed; Huckleberry Finn replaced it before its diagnostic. File-header checks confirm all eight MOBIs are version 6, not renamed AZW3 files.

A ninth work, A Christmas Carol, adds a separate whole-book operational check: every adjacent section pair in both formats, 32 total. Its original five-stave contents are included as legitimate model state, and labels were frozen before inference.

A separate local-only inventory examined 33 unique EPUBs and one MOBI from the existing library. That MOBI fails extraction. No private book excerpts were sent to a model. The library has more varied publisher layouts than Gutenberg, so public-corpus results are not a library-wide error estimate.

Frozen live probes: 107 source-section roles and 20 adjacent-section boundary decisions across seven works; 48 authored evidence-verification probes over six nonfiction works. Huckleberry and verse-markup diagnostics use deterministic source recovery. Role/boundary probes are purposive and agent-adjudicated, not independently human-labeled gold. Verification probes deliberately include 24 unsupported mutations and 24 supported paraphrases; an additional production-shaped comparison uses two 24-item same-book batches, with 16 reused claims and 32 new composed fields/questions passed through actual materialVerificationItems; this is not the natural error distribution of generated guides. Source and span hashes were checked before interpretation.

## Existing functionality map

| Existing path | What Jev could do | Assessment method / constraint |
| --- | --- | --- |
| EPUB/MOBI section types | Distinguish narrative, auxiliary notes, navigation, rights and empty dividers from content |107 live judgments; replay actual preferred-start and study-guide segment consumers. One ambiguous rights/aux case is excluded from primary accuracy after independent review, with both denominators retained. A type change alone does not prove narration exclusion. |
| Preferred reading start | Select the first substantive authored section using titles and openings |6/18 live cases completed; two accepted fixes also solved by deterministic rules. Repeated Gateway capacity failures blocked the remaining 12. |
| Chapter continuity | Identify accidental splits while preserving authored short poems and notes |20 real adjacent-section probes; one EPUB-confirmed natural MOBI split. Exact narration hash must survive any merge. |
| Missing chapter boundaries | Select source headings and reconstruct chapters |Huckleberry has43 explicit chapter markers; local reconstruction succeeds without inference. |
| Paragraph/verse continuity | Recover lost semantic formatting |Leaves has explicit preformatted line breaks.400 pre blocks lose line breaks through current stripHTML; source preservation is a deterministic fix. No audio-quality gain is claimed from this diagnostic. |
| Study-guide claim verification | Replace or precede a generative model's supported/unsupported decision |48 paired source-grounded probes against the configured GLM model, plus conservative Jev escalation. Existing 200-claim certification remains unmet. |
| Study-guide extraction/composition/repair | Select evidence or verify statements |Current stages generate statements, guide prose and field repairs; Jev is not a drop-in generator. Exact evidence anchoring stays in code. Verification is assessed separately. |
| Search/work grouping, metadata and download fallback | Semantic edition/identity matching or reranking |Current code uses catalog evidence and compatibility rules. No frozen real retrieval-failure corpus was available in this run, so no measured Jev benefit is claimed. Wrong identity merges carry material cost. |
| Import completeness and candidate selection | Warn about missing or incoherent text; compare viable candidates |All eight standalone MOBIs extract; previous AZW3 failures had no usable candidate. The earlier real-book comparison found no improvement on 10 extraction-warning cases or four Kindle candidate cases. Explicit chapter-count/marker discrepancies can be checked in code. Model judgments cannot recover absent bytes. |
| TTS generation, audio caching, playback and downloads | No direct replacement |These produce audio or execute deterministic I/O/state transitions. Changing pronunciation/chunk policy would need an audio-quality benchmark; not inferred from text judgments. |
| PDF cleanup and repair | Resolve ambiguous hyphens |Previously tested: three accepted reference-matching repairs across three scans in the capped import path, no speedup; 12 header-cleanup cases had no added benefit. Not the priority of this assessment. |

Code anchors: `lib/book-guide-service.js` verificationPrompt, generateAttempt and STRUCTURAL_TYPES; `lib/chapter-extraction.js`; `lib/chapters/partitioning.js`; `lib/chapters/text-sanitization.js` stripHTML; `public/js/util/chapter-labels.mjs`; `lib/search-work-resolution.js`; `lib/metadata-service.js`; `lib/import-validation.js`.

## Baseline identity and operating conditions

The application's configured PPQ verifier is `glm-5.2`. PPQ returns `z-ai/glm-5.2`, which the production adapter rejects as a substitution. An authenticated read of PPQ's official model catalog confirms that returned identifier as GLM 5.2. The experimental comparison scores its raw response only after that exact catalog match. Every batch records `productionAccepted:false`; the production adapter is unchanged. This is a comparison with the configured model's responses, not evidence that the current app accepts those responses.

PPQ did not report an actual charge in the sampled responses. Its catalog gives token prices, so any derived cost is a list-rate estimate and must be distinguished from actual billing and cached-token discounts.

Gateway hit rate limits during initial batching and later experiments. Retained successful calls are preserved; later calls are paced 30 seconds apart. One early incomplete checkpoint was overwritten during recovery, so its complete failure timing is unavailable. Later provider-capacity failures occurred with 30-second pacing in boundary, mixed-field verifier and start-selection experiments. Their incomplete artifacts are retained. Boundary and verifier resumes succeeded; the start-selection retry after a 60-second pause failed again. Successful requests were reused by exact request hash; only unfinished batches were retried. The initial verifier runs illustrate the distinction: GLM finished in 32.8 seconds wall time, while Jev took 183.5 seconds including conservative pacing. The lower Jev request latency did not produce a faster benchmark run. A lower successful-request latency alone does not establish higher throughput under this account's limits. The 30-second pacing is a conservative harness choice following observed 429s, not a measured minimum service interval. No immutable Jev model version is exposed by the alias.

## Why large gains are plausible elsewhere

The useful comparison is against an existing generative LLM making a small decision. Guide verification fits that pattern: it pays for a model response and JSON generation to obtain booleans. Most of this project's book import pipeline instead runs local parsers, markup rules and file conversion. Replacing those cheap operations with a network judgment does not automatically save time or money. Jev can improve ambiguous decisions, but the application must consume them correctly. The section-role replay demonstrates why an accurate label can have no playback benefit.

This assessment follows the [TypeSafe skill](/Users/k/.codex/skills/typesafe-ai/SKILL.md) and live [structure recovery](https://docs.typesafe.ai/cookbooks/autoformat.md), [evidence verification](https://docs.typesafe.ai/cookbooks/citation_check.md), candidate-selection and confidence documentation. It tests composed decisions and real consumers, not only a generic classification prompt. That broader approach found a credible verifier opportunity, but does not support a general claim that Jev accelerates book processing.

## Decision

Prioritize a verifier cascade pilot, followed by a larger evaluation of naturally generated claims. The current controls establish technical promise, not the application's 200-claim certification or a natural false-acceptance rate. The configured GLM alias rejection also needs a separate production fix before a fair end-to-end baseline can run.

Fix explicit EPUB/MOBI source-marker and whitespace handling before adding inference to those paths. Keep section-role judgments as an experimental input to explicit consumer policies. Do not deploy the tested automatic chapter-merge policy: it accepted no useful joins. Search reranking, book identity and missing-text detection remain unmeasured opportunities, not established wins or disproven uses.

## Main evidence files

Local artifacts under `data/benchmarks/jev-expanded/`:

- `verification-summary.json`: paired verifier accuracy, latency, costs and baseline failures.
- `consumer-replay.json`: section types through actual consumers, exclusions and exact-text checks.
- `operational-replay.json`: all Carol boundary decisions applied together; no accepted repair.
- `start-summary.json`: partial preferred-start results and all 12 unrun cases.
- `deterministic-structure-e2e.json`: source-marker and verse-markup alternatives.
- `source-integrity-check.json`, `expanded-integrity-final.json`: source hashes and excerpt checks.
- `*-incomplete*.json`: retained interrupted attempts. Failed-request charges are unknown.

The independent reviewer endorsed the completed consumer, boundary and verifier amendments. The later partial start diagnostic is explicitly outside that ratification. No production code was changed in this expanded assessment; earlier experimental PDF behavior remains disabled.

## Reproduction and evidence

- `scripts/inspect-jev-library.js`: local-only extraction inventory.
- `scripts/freeze-jev-expanded.py`: section and boundary probes with source identifiers and frozen thresholds.
- `scripts/freeze-jev-verification.py`: explicit supported/unsupported verification cases and source spans.
- `scripts/benchmark-jev-expanded.js --live`: paced Gateway structure evaluation; requires `AI_GATEWAY_API_KEY`.
- `scripts/benchmark-jev-verification.js --live [--baseline]`: paired verification. Baseline reads existing local provider credentials without logging them.
- `scripts/analyze-jev-expanded.js`: replay section decisions through current consumers, with exact-text preservation assertions.
- `scripts/verify-jev-structure-alternatives.js`: actual-source deterministic chapter/verse diagnostic.
- `scripts/freeze-jev-operational.py`, `scripts/benchmark-jev-expanded.js --live --operational`, `scripts/analyze-jev-operational.js`: exhaustive Carol boundary check and simultaneous replay.
- `scripts/freeze-jev-guide-shape.js`, `scripts/benchmark-jev-verification.js --live --guide-shape [--baseline]`, `scripts/summarize-jev-verification.js`: production-shaped verifier controls and paired summary. `--generous-baseline` is a separate Liberty-only output-budget control.
- `scripts/benchmark-jev-start.js --freeze` / `--live`, `scripts/compare-jev-start-rules.js`, `scripts/analyze-jev-start.js`: direct preferred-start diagnostic and frozen deterministic comparator.

Freeze and summary scripts refuse to overwrite results. Fresh reproduction requires a separate output directory or deliberately archived artifacts. The structure runner can reuse explicitly retained incomplete checkpoints by exact request hash. Download manifests identify the public source editions; results apply to those snapshots.

All books, excerpts, source snapshots and raw result artifacts are ignored local files. Source integrity, model routing, prompt/response and code hashes accompany the reports. No benchmark output containing book text or credentials belongs in source control.
