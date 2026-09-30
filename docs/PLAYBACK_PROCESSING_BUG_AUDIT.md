# Playback and processing bug audit

Twenty-two defects were reproduced and fixed across three audit passes. Eight affect
extraction/reprocessing, nine affect the current playback path, one affects the
shared session handoff API, and four affect the retained legacy chunk adapter.
Thirty regression scenarios cover them, including same-engine handoffs
through both adapters and a relocation/Pause check that already passed.

## Reproductions and fixes

1. EPUB narration changes apostrophized proper names (O'Reilly, D'Souza).
2. EPUB extraction deletes literal escaped angle-bracket text and decodes nested entities twice.
3. An out-of-range numeric entity aborts EPUB extraction instead of retaining surrounding prose.
4. A chapter rebuild interprets a null character offset as an exact offset of zero, losing the saved timestamp.
5. Two concurrent chunk seeks can finish in reverse order and leave the earlier target selected.
6. Pause during a pending chunk seek is undone by its saved resume decision.
7. Pause during a cross-chunk skip is undone by its saved resume decision.
8. A playback handoff to the same engine reads its position after reloading, losing the position.
9. A handoff between chunk engines restores an estimated chapter time instead of the exact chunk position.
10. A pending or failed session transition can label the old engine's position with the incoming book/chapter.
11. The live continuous player clamps a buffered seek to an estimated duration even when the actual audio is longer.
12. Pause does not cancel a pending live-player start; it later reports a false playback-progress timeout.
13. A cancelled continuous seek clears the loading flag of a newer seek in its unconditional cleanup.
14. Named HTML references discard accented letters and symbols, and references containing digits such as `&frac12;` remain encoded. Extraction now uses the installed entity reference maps with case-sensitive names.
15. Text repair deletes authored Unicode joiners, changing Persian spelling, Indic shaping, and emoji sequences. U+200C and U+200D are preserved.
16. Inline markup inserts spaces inside accented, uppercase, and non-Latin words and before punctuation. Inline formatting tags now preserve the source whitespace.
17. Continuous playback crosses chapters using estimates. A resume beyond an underestimated duration is immediately saved in the next chapter at zero. Chapter mapping now waits for the server's decoded duration before crossing a boundary.
18. A measured empty chapter is serialized as unknown, ignored by polling, and replaced with an estimated duration in seek calculations. A decoded zero remains distinct from an unknown duration through the server, polling, mapping, and seeking.
19. Pause while a next-chapter download is pending at the audible boundary invokes the normal chapter-ended callback when the download finishes, allowing the app to resume automatically. The pending boundary now remains paused. Resume consumes the downloaded source, continues waiting for an active download, or requests the normal fallback if the download failed.
20. Rebuild recovery deletes audio already installed before a crash. Overlapping chapter moves can also read another chapter's installed audio from an old source path, and interrupted recovery copies can be mistaken for complete stages. Recovery now reconstructs staging copies from installed destinations before invalidation. Staging copies use a temporary file and atomic rename. The journal records the promotion phase; older journals infer it from consumed stages and missing original sources. Real files, exact audio bytes, and narration fingerprints are verified after faults injected after promotion and during recovery copying.
21. A queued native `play` event can report playing after the user has already paused the element. Native play handling now checks the element's actual paused state before changing player state or publishing callbacks.
22. An early continuous EOF can expire a chapter sleep limit before its target chapter, or mark a truncated final chapter complete. EOF now checks the target chapter and any measured remaining duration before reporting intentional completion. Early EOF retains the recoverable `CONTINUOUS_STREAM_EOF` error. A completed chapter limit still ends normally.

The live PWA uses `SingleFileChapterPlayer`; the retained `ChunkPlayer` is not constructed by the current shell. Cases 5–7 and 9 concern that legacy adapter. Cases 8 and 10 also affect the live adapter and are verified independently there.
The current app does not call `handoffTo`; case 8 is a defect in the shared
session API rather than a demonstrated current user flow.

Verification: `node scripts/verify-playback-processing-e2e.js`. This creates synthetic EPUBs, runs the production extraction/cache pipeline, and exercises production playback adapters with native Chromium audio and controlled HTTP delays. It writes JSON results and a browser trace under `output/playback-processing/`. Browser checks cannot prove physical iOS behavior.

Each failure was captured before changing its implementation. The processing
checks parse synthetic EPUB files and verify the disk-cache round trip. The
playback checks use native audio with HTTP byte ranges. They do not replace the
media element with a fake. Controlled response gates reproduce pending seek,
pause, and checkpoint races.

Fixes restrict contraction repair to recognized English contractions, decode
entities once after removing source markup, validate Unicode scalar values, and
use the timestamp when a character offset is absent. Session handoffs capture
position before reloading and use the adapter's exact restore contract. Pending
or unready sources cannot produce checkpoints. Live playback starts have explicit
cancellation ownership; seek cleanup only clears its own loading state. Only
measured duration can limit a continuous seek. Legacy chunk seeks use a revision
guard and preserve user playback intent separately from temporary seek pauses.

## Evidence and limits

First-pass verification passed: 14/14 regression scenarios, 3,493/3,493 existing
tests across 183 suites, and the running application browser smoke.

The resumed audit captured seven new failures before implementation. Two expose
the same estimate-based mapping defect. An added seek check caught the remaining
zero-duration seek error, and a failed-download check verified the corrected
Pause/Resume boundary flow. The repeatable harness now has 23 scenarios. The
shell and offline controller both use `xandrio-v188`.

Resumed verification passed all 23 scenarios in Chromium and the application
browser smoke on Node 24.15.0. All 3,493 existing checks across 183 suites passed
across the full run and isolated reruns. The full run required reruns of
`book-guide-service`, `security-http`, and `ui-composition` after deadline or
browser-interaction failures; those reruns passed 24, 29, and 17 checks. The
machine-readable repository report retains these failures and their rerun logs
rather than claiming a clean single full-suite execution. `git diff --check`
passed.

WebKit passed 20 of the 23 scenarios. Three that require advancing playback
could not complete: a standalone native `Audio` element also reports playing
without advancing its WAV or MP3 playhead in this local WebKit environment,
including after a real Play click. The diagnostic reproduces this without the
production adapter. This is a verification limit, not evidence of an additional
application defect. Physical iOS playback remains unverified.

The third pass reproduced four failing scenarios covering three additional
defects, plus additional failures for a legacy journal and interrupted recovery
copy. After the fixes, all 30 regression scenarios pass in Chromium. Relevant existing
player, reconciliation, rebuild, sleep-timer, and shell-version checks passed
(272 checks across five suites), as did the application browser smoke and
`git diff --check`. The current shell and offline controller both use `xandrio-v189`.
This pass does not claim a new full-repository run or new WebKit verification.

- Before: `output/playback-processing/before-live.json` and browser trace.
- After: `output/playback-processing/verification.json` and browser trace.
- Full repository suite: `output/playback-processing/final-suite.log`.
- Running application smoke: `output/playback-processing/app-smoke.log`.
- Repeat: `npm run verify:playback-processing`.
- Resumed baseline: `output/playback-processing/resume-before.json` and browser trace.
- Resumed verification: `output/playback-processing/resume-final.json` and browser trace.
- Resumed repository suite: `output/playback-processing/resume-suite.log`.
- Repository results including isolated reruns: `output/playback-processing/resume-repository-verification.json`.
- Resumed application smoke: `output/playback-processing/resume-smoke.log`.
- WebKit results: `output/playback-processing/resume-webkit.json` and browser trace.
- WebKit native-media diagnostics: `output/playback-processing/webkit-native-diagnostic.json` and `webkit-format-diagnostic.json`.
- Repeat WebKit: `BUG_AUDIT_BROWSER=webkit BUG_AUDIT_PHASE=webkit npm run verify:playback-processing`.
- Third-pass baseline: `output/playback-processing/third-before.json` and browser trace.
- Legacy-journal baseline: `output/playback-processing/third-legacy-before.json` and browser trace.
- Third-pass verification: `output/playback-processing/third-final.json` and browser trace.
- Third-pass verification summary: `output/playback-processing/third-verification.json`.
- Interrupted-copy baseline: `output/playback-processing/third-partial-before.json` and browser trace.
- Relevant existing checks: `output/playback-processing/third-player.log`, `third-reconcile.log`, `third-rebuild.log`, `third-sleep-timer.log`, and `third-shell.log`.
- Third-pass browser smoke: `output/playback-processing/third-smoke.log`.
- Focused reproduction: set `BUG_AUDIT_FILTER` to a substring of the scenario name when running `npm run verify:playback-processing`.

The installed PWA shell cache is bumped to deliver the changed modules. Existing
extracted chapter caches are preserved: missing source text cannot be recovered
from an already-corrupted cache, so affected existing books need re-import from
their source. This audit does not claim physical-device iOS verification or that
all possible playback and processing defects have been eliminated.

The release checks also caught a defect in `scripts/bump-version.mjs`: it updated
the worker version without updating the offline controller pin, which broke
downloaded playback. The script now updates both versions in lockstep. This
necessary delivery fix is separate from the twenty-two audited defects above.

## Reported book-switch race

The application browser reproduces the reported symptom with real, distinct
audio for two books. Hold book A's audio response, select B, then hold B's saved
position response. Releasing A first lets its old playback transition republish
A while the screen still displays B. After B's open abandons itself, pressing
Play starts A under B's title. The initial browser run records that exact
title/source mismatch and an advancing A playhead.

Opening another book now cancels the outgoing media load and playback recovery,
releases its native audio resource, and invalidates its session transition
before awaiting the incoming position. The outgoing checkpoint is captured
first. A failed selection can still restore the previous session. Ordinary
chapter handoffs retain their source-change behavior.

Repeat the four application scenarios with `npm run verify:book-switch` on
Node 24. They cover the delayed outgoing response, native resume during the
incoming position fetch, rapid A/B/C selection, and a failed book selection
preserving A's position. The harness uses Chromium's real media element and
HTTP audio, with distinct tones for each book. JSON results, screenshots, and
Playwright traces are saved under `output/playback-processing/`.

- Baseline: `book-switch-before.json` and `book-switch-before.trace.zip`.
- Fixed application: `book-switch-after.json` and `book-switch-after.trace.zip`.
- Final versioned shell: `book-switch-final.json` and `book-switch-final.trace.zip`.
- Existing session/player checks: `book-switch-session.log` and `book-switch-player.log`.
- Playback audit regressions: `book-switch-regressions.json` and trace.
- Application smoke and shell versions: `book-switch-smoke.log` and `book-switch-shell.log`.

All four book-switch scenarios and all 30 prior audit scenarios pass. Existing
session, player, and shell suites pass 242 checks. The application browser smoke
also passes. The shell and offline controller use `xandrio-v190`, with `app.js?v=145`.
This change has browser verification; physical iOS verification remains open.

## Oversized import source conservation

Oversized chapter partitioning called the speech splitter, which expanded
citation abbreviations, ordinals and currency, and changed lexical casing in
stored chapter text. Partitioning now uses the boundary splitter directly.
Speech preparation still applies substitutions when producing narration.

Run `npm run verify:source-partition` on Node 24. It builds and imports a real
oversized EPUB, checks exact normalized source conservation across all parts,
checks chapter metadata and ordinary chapters, and verifies that speech
substitutions still apply to narration. The before/after JSON and logs are
saved under `output/playback-processing/`. The reproduction changed 208,509
normalized source characters into 302,109 before the fix. After the fix, the
imported source hash matches the input hash exactly.
