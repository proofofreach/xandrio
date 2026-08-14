# Book Guides

Book Guides are an experimental, instance-wide study-guide artifact for an imported book. The feature is disabled by default. It must stay disabled until the instance has a certified generator/verifier configuration and the release gates in this document pass.

## V1 scope

V1 is English nonfiction only. An admin explicitly tags eligible titles as nonfiction. The application does not classify fiction automatically. Fiction guides are future scope; they need a separate product and evaluation decision. A guide is shared with readers who can access its book. V1 does not add personal learning history, saved quiz state, bookmarks, or spaced-repetition state.

A ready guide contains a brief orientation, concept cards, a chapter map, active-recall prompts, and a small supporting-passage layer. It is concept-first and chapter-linked. Every material claim and answer has an evidence anchor into the imported edition. Quotes support an idea; they are not the primary product. The same structured artifact also produces a section-level audio playlist with the active Xandrio voice. Audio is generated on demand, cached by guide version and voice, and does not require an EPUB export.

## PPQ.ai initial path

The first supported generator path is PPQ.ai's OpenAI-compatible API at `https://api.ppq.ai`. Xandrio sends imported book segments, extracted claims, and verification evidence to the selected model. Requests require PPQ.ai's zero-data-retention routing. If no compatible endpoint is available, the request fails instead of relaxing that requirement. This remains external processing; operators must review PPQ.ai and upstream-provider terms.

The API key is write-only in the admin UI and stored separately from public guide configuration. Use a dedicated PPQ.ai key with a strict spending limit. When the provider is configured, the admin acknowledges once that book text leaves the server and confirms responsibility for processing rights. This warning is not repeated for every title. An admin starts, cancels, retries, configures, and regenerates a guide. Normal readers can read a ready or stale guide but cannot cause source processing or see provider configuration. Only nonfiction-tagged titles expose the library study-guide action.

The default generator route is `gemini-3.7-flash`. In a 12,000-character synthetic extraction probe on 2026-08-14, it returned five grounded claims with five exact citations in 9.0 seconds. `deepseek/deepseek-v4-pro-0813` returned 42 exact citations in 77.6 seconds before the output-size constraint was added; its current PPQ.ai token prices were also about 5.3 times higher for input and 3.2 times higher for output. `deepseek/deepseek-v4-flash-0731` remains available but produced intermittent malformed JSON and altered citations on the real failure investigation. Qwen 3.7 Flash is not offered because its required ZDR request returned 404. These are diagnostic probes, not a full quality benchmark.

PPQ.ai advertises a 1,048,576-token context window and structured output for Gemini 3.7 Flash. Xandrio still uses chapter-bounded extraction and reduction. This keeps evidence anchors precise, bounds retries and cost, and avoids relying on long-context recall. Use `glm-5.2` as the independent verifier. Every provider request requires PPQ.ai's ZDR routing; a model without an eligible ZDR endpoint fails closed.

## Private Codex path

A private, single-operator instance can set `XANDRIO_PRIVATE_CODEX_GUIDES=1` to replace PPQ.ai with a dedicated Codex CLI connection. The Codex CLI must be installed on the server and available to the service user. Set `XANDRIO_CODEX_BIN` when it is outside the service `PATH`; `XANDRIO_CODEX_HOME` defaults to `DATA_DIR/codex`.

The admin connects through the Study Guide settings device-code flow. Xandrio returns only the temporary OpenAI sign-in URL and user code to the browser. Codex stores and refreshes authentication under the dedicated server-side home. Xandrio does not accept or return the OAuth token. This mode offers `gpt-5.6-luna` for generation and `gpt-5.6-terra` for independent verification. It is disabled unless the private flag is explicitly set.

## Evidence and lifecycle

A guide records its book id, source fingerprint, chapter-structure key, normalization/extraction versions, generator and verifier model IDs, and prompt-recipe hash. An anchor records a chapter and normalized source range. The stored artifact does not need to persist raw book text to show a short local context snippet later.

Every guide publish is atomic. The pipeline extracts candidate claims, composes the guide, performs deterministic anchor and quotation checks, then verifies every material claim and recall answer. A failed or cancelled job publishes nothing. A previous verified guide remains available.

Changing source text or chapter structure marks a guide stale. The app revalidates its anchors; unproven links are disabled. A regenerated guide replaces the previous artifact atomically only after verification succeeds. Obsolete narration caches are removed after replacement. Deleting a book cancels its guide and narration jobs and removes guide artifacts and cached guide audio with the rest of the book's local data.

## Passage controls

The implementation enforces conservative product limits:

- At most 18 normalized words in one stored excerpt.
- At most 150 source words in all stored excerpts in one guide.
- No sequence of 12 or more source words outside an approved excerpt field.

These are product controls, not a legal conclusion about any work or use. Operators remain responsible for rights and retention.

## Certification and release gate

Enabling the experimental feature permits generation before certification; the UI does not expose certification as an operator setting or badge. Artifacts retain the internal certification state for evaluation and release decisions. Certification changes that internal quality status only after the exact model pair and prompt recipe pass a legally usable evaluation corpus of at least 12 English nonfiction works across at least three of these shapes: prescriptive, argumentative, historical, biographical, narrative, and technical.

The verifier needs a frozen calibration set of exactly 200 human-labelled claims: 100 supported and 100 unsupported, from at least six corpus works. Unsupported-claim recall and precision must both be at least 90%.

For each corpus work, reviewers sample at least 20 material guide claims and at least eight active-recall questions where available. The gate requires no material fabrication, at least 95% fully supported claims, at least 95% correct and answerable recall answers, at least 80% recall prompts rated non-trivial and useful by both reviewers, and mean central-idea coverage and usefulness of at least 4/5. Every sampled evidence anchor must resolve exactly. Audio-capable formats also require at least 90% of 100 stratified seek checks to land within 30 seconds; formats without reliable seek support are visibly chapter-only.

Run the evaluator against aggregate review results and local manifests:

```bash
npm run benchmark:book-guides -- \
  --manifest /private/evaluation/book-guide-works.json \
  --calibration /private/evaluation/book-guide-calibration.json \
  --results /private/evaluation/book-guide-results.json \
  --output data/book-guide-certification.json
```

Run the benchmark from the Xandrio project directory. The server reads that exact output path. Report provenance must use model identities in `<model-tag>@<sha256:digest>` form and match the recipe, extraction, and normalization versions returned by the admin configuration endpoint.

The manifest contains local paths and rights attestations but the report is aggregate-only. It rejects titles, authors, source paths, book text, quotes, credentials, prompts, and raw model responses in calibration/results data. The harness makes no provider or model call. Use the admin connection test for a small paid provider probe. Never put an API key in benchmark files or command history.

Any change to generator model, verifier model, extraction/normalization version, or recipe hash invalidates certification for new guides. New output returns to test-guide status until calibration and representative-corpus evaluation pass again.

## Cost and operations

V1 admits one background guide job at a time through a dedicated network scheduler. PPQ.ai calls are paid and can retry up to three durable attempts. The UI connection test is also a small paid call. Operators must use a dedicated key, set a provider-side spending limit, monitor account activity, and keep uncertified output limited to deliberate testing until the selected model pair passes the evaluation gate.

The feature must be kept behind an instance-level experimental flag. Start with public-domain or licensed works and an opt-in beta. The rollback is to disable guide generation and hide entry points for books without an existing guide. Existing verified guides remain locally readable and deletable; cleanup of guide artifacts is an explicit destructive action.
