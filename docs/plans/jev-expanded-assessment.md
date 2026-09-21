# Expanded Jev assessment

Scope: existing Xandrio behavior, with EPUB and standalone MOBI prioritized. Inference uses Vercel AI Gateway `typesafe-ai/jev`. Earlier PDF results remain valid only for their narrow sample. No production integration or default changes are part of this assessment.

## Coverage and decision rules

1. Inventory current extraction, section normalization, navigation/narration selection, and study-guide model decisions. Distinguish generation from typed judgment. Verify each proposed improvement reaches a real consumer.
2. Collect eight additional public-domain works as genuine EPUB and standalone MOBI. Include novels, stories, poetry, aphoristic and argumentative nonfiction. Preserve source URLs, hashes and work-level development/test splits. Inspect local library structure without uploading private books to find representativeness gaps.
3. Freeze candidate spans and source-derived labels before live calls. Existing markup/TOC is evidence for labels; do not strip good markup to manufacture an application gain. Keep stress controls distinct from naturally observed failures. Missing text/candidates are parser failures, not semantic judgments.
4. Evaluate structure decisions in batches over coherent state, using the structure-recovery cookbook. Preserve all source text, order and reliable authored boundaries. Measure actual boundary/title/section outcomes and false changes, not merely agreement with labels.
5. Evaluate existing study-guide verification with source-grounded statements and deliberate error controls, clearly marked as authored evaluation cases. Compare against the actual configured verifier if available; do not compare latency/cost across unrelated runs. Keep false acceptance separate from false rejection and model abstention. A smoke benchmark is not production certification.
6. Record actual request/response, routing, tokens, latency, reported charge, source/code hashes, failures and complete denominators. Avoid tuning on held-out works. Independent review checks coverage, causal attribution, and claims before final report.

## Failure modes before benchmark implementation

Reference leakage; exposing gold or baseline to model; counting pre-existing deterministic fixes as model gains; using broken parser output with no correct candidate; erasing poetry or authored short sections; treating all front matter as disposable; accepting unsupported guide claims; missing qualifiers or evidence context; malformed batched answers or route changes; confidence mistaken for correctness; synthetic corruption mistaken for real prevalence; silently dropping failed requests; token/cost mismeasurement; production mutation during evaluation.

## Doubts

Gutenberg exports may underrepresent the user's commercial EPUB library. Actual library formats should inform local coverage, but public-source evaluation alone cannot establish library-wide benefit. A Jev cascade may save verifier calls yet hurt false-acceptance rates. Chapter metadata affects several consumers differently; none may be inferred from label accuracy alone. Current inference aliases are unpinned.


## Independent review, round1

SHIP-WITH-CHANGES for assessment; no product integration. All factual findings independently checked against code. Accepted-verified: purposive candidate selection cannot establish whole-book coverage; two different start selectors; types do not filter playback; guides skip only copyright/toc/divider; production24-item verifier shape includes composed fields; rate pacing must be included in operational time; MOBI primary-only candidates offer no selection experiment; structural recuts need state/audio migration. External validity remains Gutenberg-only.

Judgment-call: prince-mobi-37 fits overlapping rights (digital-production notice) and aux (transcriber note) criteria. Exclude it from primary metrics after freeze; retain original gold and show both denominators. Other inspected gold supported by sources. No inference labels are silently changed.

Amendments: full enumeration of32 adjacent pairs for a previously unqueried A Christmas Carol in both formats, with original contents as state; two24-item same-book guide batches with actual materialVerificationItems output (32new composed probes plus16 reused claims). Freeze before inference. Replay browser start, server warmup, progress strings, actual guide inclusion and text hashes. Do not infer natural error prevalence, certification, full generation savings or production throughput. Explicitly record unsuccessful attempts and manual checkpoint recovery.

Round2 validated all32 Carol labels and both24-item guide batches against source before Jev inference. Threshold metadata0.95/0.05 added to frozen guide-shape artifact before Jev calls; baseline had run but does not use thresholds. Rows unchanged and pre-amendment copy retained. Fields are agent-authored controls passed through materialVerificationItems, not generated guide outputs. Carol remains an exhaustive-pair diagnostic; the manually identified TOC is also the first source section with existing type toc.

Attempt audit limitation: two initial Gateway429 failures preceded conservative pacing. Successful batches were reused by exact request hash. The first incomplete report was overwritten during manual checkpoint consolidation; its full failure timing is unavailable. The second incomplete report and completed successful request payloads remain. Do not claim a complete immutable history for that first failed attempt, a precise all-attempt latency, or known failure charges. Later experiment outputs are separate and retained.

Final amendment ratification: ENDORSED by the independent gpt-5.6-sol reviewer. The reviewer checked the prior consumer, exhaustive-pair and production-shaped verification amendments against final artifacts. The supplemental direct-start diagnostic was explicitly outside this ratification. Carol accepted no merges, so the report claims no reconstruction gain. Mixed-field controls are agent-authored, not human-authored.

Later availability failures: the operational boundary run and mixed-field verifier each received a Gateway capacity/rate-limit failure despite 30-second spacing. Both incomplete artifacts were archived. Operational requests reused successful exact-hash payloads; the verifier resume required an identical frozen-file hash and reused the successful Prince batch. Only unfinished work was rerun. No provider substitution was allowed. Request-latency gains do not imply run-wall-time or availability gains.

Supplemental direct-start probe stopped at six of 18 cases after a Gateway capacity failure and a second failure on a single slower resume. Both attempt artifacts retained. Raw six-of-six; gated four-of-six versus baseline two-of-six; both accepted corrections also achieved by deterministic rules. No unique model correction beyond the rule comparator established. Twelve cases remain untested. End the assessment with this explicit availability gap rather than retrying indefinitely. No production start behavior changed.
