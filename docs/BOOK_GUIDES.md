# Book Guides

Book Guides are an experimental, instance-wide study-guide artifact for an imported book. The feature is disabled by default. It must stay disabled until the instance has a certified local generator/verifier configuration and the release gates in this document pass.

## V1 scope

V1 is English nonfiction only. Before generation, an admin must attest that the selected book is nonfiction. The application does not classify fiction automatically. Fiction guides are future scope; they need a separate product, evaluation, rights, and UX decision. A guide is shared with readers who can access its book. V1 does not add personal learning history, saved quiz state, bookmarks, or spaced-repetition state.

A ready guide contains a brief orientation, concept cards, a chapter map, active-recall prompts, and a small supporting-passage layer. It is concept-first and chapter-linked. Every material claim and answer has an evidence anchor into the imported edition. Quotes support an idea; they are not the primary product.

## Local-only initial path

The first supported generator path is a loopback-only Ollama-compatible service on the same machine as Xandrio. Book text, extracted claims, and verification evidence stay on that machine. Xandrio must not send book text to an external model provider in V1. There is no implicit fallback from local generation to a remote provider.

An admin starts, cancels, retries, configures, and regenerates a guide. Normal readers can read a ready or stale guide but cannot cause source processing. The generation screen must state the local destination, the model identifiers, the estimated cost and duration, and the nonfiction attestation before a job begins.

## Evidence and lifecycle

A guide records its book id, source fingerprint, chapter-structure key, normalization/extraction versions, generator and verifier model IDs, and prompt-recipe hash. An anchor records a chapter and normalized source range. The stored artifact does not need to persist raw book text to show a short local context snippet later.

Every guide publish is atomic. The pipeline extracts candidate claims, composes the guide, performs deterministic anchor and quotation checks, then verifies every material claim and recall answer. A failed or cancelled job publishes nothing. A previous verified guide remains available.

Changing source text or chapter structure marks a guide stale. The app revalidates its anchors; unproven links are disabled. A regenerated guide replaces the previous artifact atomically only after verification succeeds. Deleting a book cancels its guide jobs and removes guide artifacts with the rest of the book's local data.

## Passage controls

The implementation enforces conservative product limits:

- At most 18 normalized words in one stored excerpt.
- At most 150 source words in all stored excerpts in one guide.
- No sequence of 12 or more source words outside an approved excerpt field.

These are product controls, not a legal conclusion about any work or use. Operators remain responsible for rights and retention.

## Certification and release gate

Generation stays unavailable until the selected model pair and prompt recipe are certified. Certification requires a legally usable local corpus of at least 12 English nonfiction works across at least three of these shapes: prescriptive, argumentative, historical, biographical, narrative, and technical.

The verifier needs a frozen calibration set of exactly 200 human-labelled claims: 100 supported and 100 unsupported, from at least six corpus works. Unsupported-claim recall and precision must both be at least 90%.

For each corpus work, reviewers sample at least 20 material guide claims and at least eight active-recall questions where available. The gate requires no material fabrication, at least 95% fully supported claims, at least 95% correct and answerable recall answers, at least 80% recall prompts rated non-trivial and useful by both reviewers, and mean central-idea coverage and usefulness of at least 4/5. Every sampled evidence anchor must resolve exactly. Audio-capable formats also require at least 90% of 100 stratified seek checks to land within 30 seconds; formats without reliable seek support are visibly chapter-only.

Run the offline evaluator with local files only:

```bash
npm run benchmark:book-guides -- \
  --manifest /private/evaluation/book-guide-works.json \
  --calibration /private/evaluation/book-guide-calibration.json \
  --results /private/evaluation/book-guide-results.json \
  --output data/book-guide-certification.json
```

Run the benchmark from the Xandrio project directory. The server reads that exact output path. Report provenance must use model identities in `<model-tag>@<sha256:digest>` form and match the recipe, extraction, and normalization versions returned by the admin configuration endpoint.

The manifest contains local paths and rights attestations but the report is aggregate-only. It rejects titles, authors, source paths, book text, quotes, credentials, prompts, and raw model responses in calibration/results data. The harness makes no provider or model call. `--allow-live-provider` requires `--provider-config` as an explicit acknowledgement, but the current harness has no network adapter and still performs no live call.

Any change to generator model, verifier model, extraction/normalization version, or recipe hash invalidates certification for new guides. Re-run calibration and representative-corpus evaluation before re-enabling generation.

## Hardware and operations

The provisional recommended local profile is 32 GB system or unified memory, plus either 12 GB supported GPU VRAM or 32 GB Apple unified memory, eight modern CPU cores, and sufficient model storage. V1 admits one background guide job at a time through the shared generation scheduler. Operators must use Ollama's local resource controls; Xandrio makes no paid or external model calls.

The feature must be kept behind an instance-level experimental flag. Start with public-domain or licensed works and an opt-in beta. The rollback is to disable guide generation and hide entry points for books without an existing guide. Existing verified guides remain locally readable and deletable; cleanup of guide artifacts is an explicit destructive action.
