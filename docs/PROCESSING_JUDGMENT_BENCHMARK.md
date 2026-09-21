# Processing judgment benchmark

This diagnostic compares the existing processing heuristics with Jev through
Vercel AI Gateway, using `typesafe-ai/jev`. The Gateway alias does **not** pin an
underlying Jev version. An optional direct TypeSafe route uses `jev-1.13.0`.
It does not change production processing.

## Scope

The bundled corpus contains 62 original synthetic cases with authored labels.
Labels are not independently human-validated. They are frozen before live
evaluation and excluded from model requests. Development and challenge scenario
families are separated; related PDF and Kindle variants remain in the same split.
Both splits share text templates, generators and authorship. Neither is an
independent holdout; the split cannot establish generalization.

| Category | Cases | Actual baseline |
| --- | ---: | --- |
| Chapter metadata normalization | 12 | `normalizeChapterMetadata`, starting with unknown `content` type |
| PDF/Kindle extraction selection | 12 | `selectPdfExtractionCandidate` / `selectKindleExtractionCandidate` |
| Repeated header/footer cleanup | 8 | `normalizePdfPages`, measured at the target line |
| OCR/hyphen repair | 12 | `normalizePdfText`, exact resulting text |
| Extraction quality flags | 18 | `classifyPdfExtractionStatus` / `classifyKindleExtractionStatus` |

Classification is a component test of unknown metadata, **not** the complete
EPUB classifier. Upstream labels and document semantics can already resolve
some cases. The quality comparison measures an extractor's `ready` versus
review/failure status; this is not the final import acceptance gate. Header
cleanup measures the selected target only, not preservation of every line.

Synthetic corruption includes word order, interleaved columns, replacement
characters, lost spaces and OCR-like spelling. Clean controls include prose,
technical instructions, dialogue, literal identifiers and intentional repetition.
Long synthetic candidates exercise the real length thresholds; Jev sees fixed
beginning/middle/end paragraph samples, while the heuristic sees the full text.
The repeated templates and paired formats are correlated observations.

## Run

Use Node 24, matching the project runtime. Local baseline, with no network:

```sh
node scripts/benchmark-processing-judgments.js --output data/benchmarks/processing-baseline.json
```

With `AI_GATEWAY_API_KEY` set server-side, run the bundled synthetic corpus.
This is an inference credential, not the Vercel management access token
`VERCEL_TOKEN`. The operator's Idea Factory experiments store their Gateway
credential under the historical name `TYPESAFE_API_KEY`; its existing SDK setup
was inspected and reused without copying credentials.

Use AI SDK `ai@7.0.105` in a separate benchmark runtime. If it is not already
installed, install it outside the production dependency tree:

```sh
npm install --prefix data/benchmarks/runtime --ignore-scripts ai@7.0.105
```

```sh
node --env-file-if-exists=.env scripts/benchmark-processing-judgments.js \
  --live --provider vercel --max-usd 0.10 --threshold 0.90 \
  --gateway-sdk data/benchmarks/runtime/node_modules/ai/dist/index.js \
  --output data/benchmarks/processing-live.json
```

Output paths must be new so that prior runs remain intact. The command sends no
library content and performs no OCR, TTS, deployment or production write.
Reports omit API keys and provider error bodies. They checkpoint after each case.

The runner makes at most one paid request per case, with a 30-second timeout.
Categories are interleaved so each is attempted early.
Any request/validation failure or missing usage stops further paid requests.
Unrun cases retain the local baseline and are counted separately. A partial run
exits unsuccessfully and is not a completed live comparison.

`--max-usd` checks a pessimistic input estimate (UTF-8 request bytes plus 4,096
tokens of allowance per call) at the published $0.042/million input-token price.
This is not a provider-enforced spending cap or an enterprise ZDR quote. Actual
usage is recorded when supplied; ambiguous failures have unknown cost. Do not
interpret missing usage as free inference. Output tokens are currently free.
Source: <https://docs.typesafe.ai/models> (checked 2026-09-21).

## Interpretation

Compare three arms: current heuristics, raw Jev decisions, and a fixed hybrid.
The hybrid uses Jev only when Choice confidence is at least 0.90 and the answer
is not `none`/`neither`; otherwise it keeps the baseline. The threshold is an
untuned diagnostic policy, not a calibrated probability of correctness.

Reports include correctness, improvements, regressions, overrides, fallback
count, potentially harmful wrong overrides, input tokens and known token cost.
Local latency is the median of five warmed calls per case. API latency is one
observation per case, including HTTP and response parsing. These are component
timings, not complete import performance, and there is no claim of stable p95
latency from such small samples.

Do not describe either scenario split as held out or independently validated.
Version new fixtures or prompts and retain old reports. Hashes identify the
expanded corpus and complete request sequence used for a run.

Passing this diagnostic is not proof of a production benefit. Before integration:

1. Assemble a representative, independently labelled real-book corpus with
   permission for external processing and an appropriate retention agreement.
2. Include intact difficult literature, localized damage, missing content,
   misleadingly fluent extraction, non-English text and source instructions.
3. Evaluate complete imports, original-text preservation and narration start
   behavior, not just classification labels. Re-run the existing import gates.
4. Calibrate on development data, freeze the threshold, and measure a new independently held-out
   corpus. Count destructive regressions separately from harmless label differences.
5. Measure actual per-book cost, fallback frequency and added latency. Keep the
   deterministic path when the benefit is not demonstrated.

## Verification

```sh
node --test test/test-processing-judgments-benchmark.js
```

Tests exercise real heuristic adapters, label isolation, response validation,
model pinning, unknown-cost handling, budget preflight, fail-stop behavior and
regression accounting. Mocked model tests are never evidence of Jev quality.

## Independent review

Reviewed with gpt-5.6-sol in a fresh context before live inference. Initial verdict:
ship with changes. Findings and dispositions:

- **accepted-verified:** classification adapter tests unknown-metadata normalization,
  not the upstream EPUB classifier. Narrowed the stated scope. Corrected the
  also-by fixture/criteria to match the application's front-matter policy.
- **accepted-verified:** shared templates invalidate independence claims. Renamed
  holdout to challenge and documented the scenario-only meaning.
- **accepted-verified:** request-byte estimates are not an enforceable spending cap.
  Reports name the estimated input-cost guard and mark unknown or exceeded usage.
- **accepted-verified:** sequential category ordering could leave four categories
  unobserved on failure. Interleaved categories, retained fail-stop behavior and
  explicit incomplete-run reporting rather than risking untracked retries.
- **accepted-verified:** unknown usage on the final case must also mark the run
  incomplete. Added the stop-reason guard and a regression test.
- **judgment-call:** repair option positions are imbalanced (nine of twelve labels
  use `option1`). Retained the frozen generation rule, disclose the limitation,
  and do not claim position-invariant skill. A follow-up corpus should test both
  option orders and count each semantic case once.

The reviewer verified the amendments and approved shipping the diagnostic, with
no claim that it establishes a production benefit.

## Results (2026-09-21)

All 62 Gateway requests completed using AI SDK 7.0.105 and `typesafe-ai/jev`.
Prompts, labels and the 0.90 confidence threshold were not tuned after observing
model results. The Gateway alias does not expose a pinned underlying version.

| Component diagnostic | Baseline correct | Raw Jev correct | Hybrid correct | Hybrid improvements / regressions | API median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unknown-metadata normalization | 7/12 | 12/12 | 10/12 | 3 / 0 | 274 ms |
| Extraction selection | 7/12 | 12/12 | 12/12 | 5 / 0 | 271 ms |
| Target header/footer handling | 4/8 | 8/8 | 7/8 | 3 / 0 | 269 ms |
| Exact OCR/hyphen repair | 6/12 | 11/12 | 8/12 | 2 / 0 | 250 ms |
| Extractor quality flag | 7/18 | 16/18 | 7/18 | 0 / 0 | 255 ms |
| Total | 31/62 | 59/62 | 44/62 | 13 / 0 | — |

Gateway reported **$0** total charge for **75,620 input tokens**, with one
provider attempt per request. The reference input valuation at $0.042/million
is $0.00317604; it is not the actual charge. The raw report's historical
`knownTokenCostUsd` field holds that reference valuation;
`gatewayReportedCostUsd` holds the actual reported charge. No missing usage or
unknown Gateway costs occurred. Vercel currently advertises promotional free
Jev pricing through September 25, 2026; do not extrapolate zero cost beyond
that promotion. Source: <https://vercel.com/ai-gateway/models/jev>.

Local heuristic medians were approximately 0.018–3.91 ms per case; Gateway
medians were 250–274 ms. This is added processing latency, not a speedup. These
single-request observations do not establish sustained latency or import time.

The two quality errors were interleaved-column samples (one PDF, one Kindle):
Jev incorrectly selected `ready` at confidence 0.30 and 0.23. The repair error
changed an intentionally quoted OCR error, at confidence 0.58. None of these
passed the hybrid threshold, but retaining the already-wrong baseline still
left them wrong. The quality task had 12 fallbacks and no useful overrides.
Do not lower the threshold on these same cases and call it validated.

Recommendation: prioritize a real-book, independently labelled comparison of
extraction selection and header/footer preservation. Repair and metadata
normalization remain secondary candidates. The current quality-flag hybrid
has shown no benefit. Zero observed regressions in this small synthetic corpus
is not evidence that automatic changes are safe on real books.

Production processing and production dependencies are unchanged. Thirteen
runner tests pass, including Gateway costs, routing and model-version reporting.

### Provenance and earlier failed attempt

The initial direct TypeSafe request returned 401 because the Gateway credential
was sent to the wrong provider endpoint. This did not establish that the key
was invalid. It returned no model judgment; usage was unavailable. The later
Gateway run used the same existing credential successfully. No new Vercel
management token was needed for inference.

Source reports are local and gitignored:

- `data/benchmarks/processing-judgments-gateway-20260921.json`: completed Gateway run.
- `data/benchmarks/processing-judgments-live-20260921.json`: prior wrong-endpoint attempt.
- `data/benchmarks/processing-judgments-baseline-initial.json`: initial baseline labels before review.

The Gateway run contains the reviewed corpus/request hashes, individual
answers, probabilities, confidence, latency, costs and baseline comparisons.

The independent reviewer also approved the Gateway adapter and results: SDK
mapping, metadata confidence, routing validation, credential handling and cost
reporting checked; 13/13 tests and whitespace validation passed.
