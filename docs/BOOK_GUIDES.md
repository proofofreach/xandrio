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

## Optional tool-free OpenAI path

Set `XANDRIO_BOOK_GUIDE_PROVIDER=openai-api` and restart to use the OpenAI Responses API at `https://api.openai.com/v1/responses`. The default remains `ppq-ai`; unknown provider values fail startup. Configure a dedicated OpenAI API key in Study Guide settings, or set server-side `OPENAI_API_KEY`. A saved key takes precedence over the environment key for its own provider. Clear removes the saved key; remove an environment key separately. API billing is separate from a ChatGPT subscription. Configuration/readiness checks do not validate the key or make a model call. The connection test and generation make paid calls; use a provider-side spending limit.

Generation uses `gpt-5.6-luna`; independent verification uses `gpt-5.6-terra`. These are routing identities, not evidence of immutable model weights or quality certification. The adapter sends only the supplied prompt as text, with `tools: []`, `tool_choice: "none"` and `store: false`. It has no agent subprocess, host-tool dispatcher, file attachment, conversation continuation, or model-directed follow-up. It accepts completed assistant text and rejects tool-call/refusal/incomplete output, response-model mismatch, invalid JSON, redirects and response overflow. Timeouts and cancellation cover headers and body. This boundary comes from the transport and absence of host tools, not instructions in a prompt. The application still reads its own credential/configuration files and selected book to construct requests.

`store: false` disables API response storage; it is **not** a zero-data-retention or no-logging guarantee. OpenAI processes book text externally under the account's applicable data controls. Review those terms separately from PPQ.ai's ZDR routing. [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra).

### Migrate from the removed Codex CLI provider

1. Replace `XANDRIO_PRIVATE_CODEX_GUIDES=1` with `XANDRIO_BOOK_GUIDE_PROVIDER=openai-api` and restart. For compatibility, the old flag also selects this replacement if the new selector is unset. The selector takes precedence. No Codex command runs; `XANDRIO_CODEX_BIN` and `XANDRIO_CODEX_HOME` are ignored.
2. Open Study Guide settings, enter a dedicated OpenAI API key, choose the generator/verifier pair and acknowledge external processing again. Save the configuration. Old Codex sign-in, OAuth credentials and consent are not imported. Device-login endpoints return unsupported for API-key providers.
3. Re-evaluate/certify the new pair and transport, or deliberately retain the experimental uncertified opt-in. Old provider/model digests, certificates and checkpoints do not authorize or resume new OpenAI work. Existing guide artifacts remain readable and deletable.
4. Revoke/remove the obsolete Codex login/home yourself if no other service needs it. Xandrio does not read or delete those files during migration.

Stored keys are tagged by provider. Legacy untagged keys belong to PPQ.ai only. Switching providers requires a matching key and a fresh processing acknowledgement; no saved key is sent to a different provider.

Independent extraction and verification requests run with bounded concurrency. The default is four model calls; set `XANDRIO_BOOK_GUIDE_MODEL_CONCURRENCY` to a positive integer to match provider limits. Successful grounded segments and supported verification batches are checkpointed locally. A restart or later-phase failure resumes that work instead of processing the book again. Checkpoints are source-, recipe-, and model-specific and are removed after publication, cancellation, or deletion.

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

V1 admits one background guide job at a time. Within that job, the dedicated network scheduler admits up to `XANDRIO_BOOK_GUIDE_MODEL_CONCURRENCY` independent model calls. Provider failures retry only the failed call. Quality failures retain grounded extraction, regenerate the affected composition, and verify every final material statement again. PPQ.ai calls are paid. The UI connection test is also a small paid call. Operators must use a dedicated key, set a provider-side spending limit, monitor account activity, and keep uncertified output limited to deliberate testing until the selected model pair passes the evaluation gate.

The feature must be kept behind an instance-level experimental flag. Start with public-domain or licensed works and an opt-in beta. The rollback is to disable guide generation and hide entry points for books without an existing guide. Existing verified guides remain locally readable and deletable; cleanup of guide artifacts is an explicit destructive action.

## Optional Jev verification cascade

An operator can enable `XANDRIO_JEV_GUIDE_VERIFIER_ENABLED=true` with
`XANDRIO_JEV_EXTERNAL_TEXT_ACKNOWLEDGED=true` and `AI_GATEWAY_API_KEY`.
Guide statements and cited source evidence then go to TypeSafe through Vercel
AI Gateway. This adds an external processor even for an OpenAI-generated guide.
Generation and repair stay with the selected provider; uncertain checks and
Jev failures use the configured verifier. See SELF_HOSTING.md for the deadline,
serial batching, cooldown, disablement and certification requirements.

Artifacts record the verification policy and content-free counts for the last
verification attempt: Jev accepts/rejects, escalations, whole-batch fallback
items, elapsed time and previously supported items reused from checkpoints.
These counts do not attribute reused decisions or measure total generation time.
PPQ's 6,000-token verifier output profile has its own policy identity, so the
old 1,500-token profile's certificate/checkpoints cannot silently certify it.
