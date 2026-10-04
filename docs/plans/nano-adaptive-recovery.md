# Adaptive recovery for rejected Nano segments

## Problem and evidence

The full-book Adam job reached 21/22 sections and 5,585 saved segments, then stopped on internal chapter 6, segment 327. The 140-character request contains three spoken sentences/dialogue turns. Every existing seed (1234/1235/1236) ends early: raw durations 1.84, 2.32 and 1.84 seconds. Repeating that exact recipe at chapter level cannot change the outcome. Rendering the three original sentences separately succeeds with the same model and voice (2.56, 2.64 and 2.88 seconds at seed 1234). Private passage/audio evidence is in ignored output/nano-adaptive-recovery, not this document.

The prior fixes correctly reject short/static output and frame exhaustion, and preserve audio; they only vary seed. Recovery now needs to vary request boundaries while retaining the logical segment, narrator and all source text.

## Proposed implementation

1. Keep normal first takes and the three-seed policy unchanged. Only Nano opts into adaptive recovery after exhausted, known model-output failures: short audio, static audio, or typed NANO_FRAME_LIMIT/422. Transport/auth/invalid requests, missing probes, conversion faults and user cancellation must not trigger splitting.
2. Isolate an adaptive recovery controller and pure text-boundary policy in a small module. Split the rejected request at natural sentence/dialogue boundaries first; preserve exact ordered substrings. Coalesce fragments shorter than 24 non-space characters. If no useful sentence split exists, bisect near the midpoint at whitespace; never cut a word or add/change punctuation. Each split must be smaller than its parent. Unsplittable text fails explicitly.
3. Validate each fragment through the same seed retries, duration floor and static analysis. Render successful fragments as lossless mono 24-kHz WAV with the existing gain, trim and limiter, zero added paragraph/chapter pause. On another eligible fragment failure, subdivide it within the shared limit. Proposed bounds: at most three split levels, at most 12 additional synthesis attempts total, and a 180-second deadline for the entire fallback stage. Initial three seed attempts retain their existing behavior. One AbortSignal links every descendant request, conversion, probe boundary and join; timeout is reported separately from user cancellation.
4. Store all fragment/staging files in a private unique directory under the cache filesystem, outside normal segment filenames. Concatenate only validated PCM fragments in source order; encode once to the original MP3/WAV format, applying the original end pause once. Do not normalize or add gain a second time. Validate the final assembled artifact too, then atomically rename it into the original segment path. Stage normal Nano attempts in the same private manner, so even the initial validation cannot expose unverified output. Publish its artifact marker only through the existing queue completion path; Nano publication errors become fatal and clean the output. Any failure/cancel cleans all scratch and final output; a process-killed partial must never be adopted on restart.
5. Keep the existing render/variant namespace because accepted first takes and old verified audio remain unchanged; only previously rejected segments get this extra recovery. Record a separate recovery-policy revision and safe logs of part/attempt counts, not book text.
6. Return a typed terminal recovery-exhausted error and classify only that code as permanent in chapter recovery. This avoids automatically spending the identical deterministic recovery budget repeatedly. Other engines and transient infrastructure recovery keep their behavior. Existing manual retry remains available.
7. Deploy through the sole release operator. Snapshot all 5,585 existing MP3 hashes/mtimes, clear the affected quarantine through the supported route, resume the full-book job with Adam/fromChapter 3, and verify new valid audio, forward progress and unchanged cached files. With only this chapter unfinished, verify completion if the remaining bounded run finishes during verification; never claim whole-book completion from a resumed job alone.

## Failure cases and tests to write before implementation

- All original seeds fail short/static/frame-limit, but smaller pieces succeed: complete and stream the entire logical segment, with exact source coverage and Adam retained.
- A stubborn child needs another split; already validated siblings are not re-synthesized and every leaf is validated.
- One failed/too-short child cannot be hidden by a long successful sibling or end padding.
- All subdivisions fail: one shared attempt/depth budget, no repeated chapter-level synthesis of terminal deterministic failure, no partial artifact or restart adoption.
- Unknown HTTP errors, malformed responses, failed probes and unsupported text remain failures with no adaptive loop.
- Pause/cancel during a later fragment, and a hung fragment hitting the shared deadline: stop requests, leave no final/marker/scratch, preserve pause intent across restart.
- Final concat/probe failure: no final artifact; error cannot trigger another adaptive loop.
- Lossless fragment assembly: source order, one final end pause, one gain/mastering pass, correct mono/rate and both MP3/WAV final formats.
- Previously verified audio survives the upgrade/restart with identical hash/mtime and no synthesis.

Use real app HTTP/E2E with fixture speech for control flow and artifacts, plus the actual pinned Nano worker for the original failing passage and the earlier short/frame failures. No new unit tests after implementation. Full release gates remain mandatory.

## Doubts for independent review

- Is splitting only rejected units enough to preserve cache identity and source coverage under restart/concurrent claims?
- Are 24-character minimum, three levels, 12 additional attempts and 180 seconds a useful bounded policy, including non-English/punctuation edge cases?
- Does mastered PCM concatenation preserve gain, pauses and audio quality without lossy re-encoding or hidden short parts?
- What cancellation/timeout/publication races remain, especially around probes and final rename?
- Is typed terminal classification appropriate, or does it block useful recovery on infrastructure changes?

## Review and adjudication

Fresh gpt-6-sol/xhigh review (different-model substitute; Claude perspective unavailable): SHIP WITH CHANGES.

- Prepared text: accepted-verified. `_generateTTS` prepares/adapts once; subdivision operates only on the exact string received by `_generateHttpTTS`, with exact concatenation assertions. No fragment re-preparation.
- Publication: accepted-verified that old normal attempts expose files before validation, and marker failures are swallowed. Stage ALL Nano attempts and propagate Nano publication errors. Judgment-call on mandatory marker adoption after a crash: rejected as unnecessary for this quality guarantee. A closed, fully validated staged file is atomically renamed; a crash after rename may safely recover complete validated bytes through the existing legacy path. The guarantee is no partial/unvalidated adoption, not a new global provenance protocol. Pause before rename leaves no final; a process crash after rename cannot retroactively cancel a completed artifact. Old legacy compatibility remains.
- Deadline: accepted-verified. Pass the shared signal to HTTP response bodies, ffprobe/static analysis and assembly, not just check before/after an unbounded subprocess. Deadline failures remain transient and distinct from user cancellation.
- Failure types: accepted-verified. Type short/static at source, use exact HTTP status/code for frame failure, classify only deterministic adaptive exhaustion as permanent.
- Languages: accepted-verified. Recognize Unicode sentence punctuation and closing quotes using exact offsets; retain whitespace fallback. Do not split a continuous unpunctuated CJK word sequence arbitrarily; fail explicitly if no safe boundary exists. Add a Japanese sentence-boundary E2E case.

The retry bounds are initial operational limits, not a proof of word-level completeness. Duration/static checks cannot prove every word was spoken. The actual pinned-worker passage and assembled output require an independent transcription/listening sanity check.


## Implementation review

Fresh gpt-6-sol/xhigh code review: SHIP WITH CHANGES. Accepted and verified the false-return publication gap: `publishVerified` may return false rather than throw; Nano now treats that as fatal and cleans output. Nano recipe-construction failures also propagate. Two real-HTTP fault-injection tests failed before these edits and pass afterward. Other engines retain their prior behavior.

The full adaptive HTTP/E2E matrix passes 22 checks, including shared 15-total-request exhaustion, prepared Japanese punctuation, MP3/WAV ordering and one gain/pause, hung response bodies, cancellation/restart, and cached first-take hash/mtime preservation. Existing seed-recovery (14) and Nano app (11) suites pass.

The independent reviewer also requested stronger transcription of the first actual-model fragment because base.en ASR was uncertain. Small.en independently reproduces ambiguity in seed1234's first sentence; the already generated seed1235 fragment transcribes exactly. Judgment-call: newly split requests start at1235 then1236/1234; normal requests retain1234/1235/1236. This uses a better observed take for the failing passage, without a population-level quality claim or changing existing accepted audio. The reviewer cautioned against extrapolating one passage; accepted as a limitation, not evidence that the equally bounded alternate order is incorrect. Whole alternate assembly passes the stronger small.en sanity check: the first sentence matches, all three endings are present, and one compound phrase still transcribes in/and differently. The final mastered segment is 9.145958 seconds including the original pause. This is a recovery/coverage sanity check, not proof of word-perfect audio. Final independent ratification: ENDORSED. Reviewer verified the amended seed order is confined to adaptive descendants, existing cache identity remains stable, the 22-case E2E report passes, and the stronger alternate-assembly transcript resolves the previously suspect first clause. ASR remains a sanity check, not proof of verbatim narration.


## Public security gate

The first release passed all 3,500 tests and browser/import checks, then public CodeQL blocked its new final rename because output paths can originate in voice-sample URLs. No deployment occurred. Accepted-verified: Nano now requires a configured cache root, resolves the real parent of the destination (including symlinks), and checks containment before staging, synthesis, or cleanup. Real HTTP fault cases for a destination outside the cache and a symlink escape each failed before the fix and pass afterward without any synthesis request. The final adaptive matrix is now 26 cases. The public security check must pass before deployment; no suppression or gate weakening is used.

The follow-up reviewer identified an earlier queue boundary: artifact reuse and cancellation cleanup can run before synthesis. Accepted-verified. One shared Nano destination validator now runs before enqueue deduplication/cache lookup/job registration, and again for direct HTTP renders. It resolves the real root and parent, rejects output symlinks, and preserves the caller's already validated path spelling for existing queue lookups. Two enqueue-level HTTP fault fixtures verify that existing external audio and its absent marker remain untouched, including cancellation. Both were observed failing before the amendment and pass afterward.

Final bounded containment amendment independently ratified: ENDORSED. All 26 adaptive HTTP/E2E checks, 11 Nano application checks and 14 seed-recovery checks pass.
