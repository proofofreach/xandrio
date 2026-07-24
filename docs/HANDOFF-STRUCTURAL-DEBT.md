# Handoff Plan B — Structural Debt (app.js extraction + docs)

*Written 2026-07-02. Companion plan: `docs/HANDOFF-HIDDEN-FEATURES.md` (run one or the other, not interleaved).*

## Context

`public/app.js` is ~4,891 lines (at `?v=58`). The overhaul added features inline; the planned strangler extraction never ran. The DI seam pattern is already proven three times — boot injects closures into `initRouter`/`initBookmarks`/`initKeys` (app.js:938-1004): **extracted modules receive dependencies as an object of getters/functions; no module imports app.js state directly.** Continue that pattern; do NOT do a big-bang `state.js` rewrite — shared globals (`currentBook`, `currentChapter`, `chapters`, `chunkPlayer`, speed) stay in app.js, passed as getters.

**Iron rule:** function moves are verbatim relocations + import rewiring. The engine layer never moves: `SingleFileChapterPlayer` (675-835), selection/handoff/callback plumbing (273-444, 837-1005), checkpoint/position logic (2558-2670), Media Session (2671-2764) all STAY in app.js. Target end-state: app.js ≈ boot + engine + checkpoint + Media Session ≈ 1,400 lines.

**Line numbers verified 2026-07-02; the repo has multiple active sessions — re-verify anchors at execution time.** Each step below is independently shippable; verify + commit per step; one `node scripts/bump-version.mjs` per landed batch. Add every new file to `APP_SHELL` in `public/sw.js`. Steps are strictly sequential (they all edit app.js) — do NOT parallelize B1–B4; docs (B5) can run parallel to anything.

## B1. Foundations (do first — everything else uses them)

1. **`public/js/ui/sheets.js`** — the sheet/modal pattern is hand-rolled 7× with per-sheet `*FocusRelease` globals and a duplicated `closeXDirect`/`closeX` two-tier split (chapter sheet 635-673; delete 4600-4610; start-over 4611-4629; shortcut overlay 4645-4662; voice sheet 4324-4347; speed sheet + timer modal in setupEventListeners). Build `registerSheet(el, {onOpen, onClose, backdrop, closeBtn})` returning `{open, close, dismiss}` that internally does: `classList` toggle + `aria-hidden` + `trapFocus`/release + `sheetOpened`/`requestSheetClose` history wiring + body class. Migrate the 5 simple ones first (delete, start-over, shortcut, timer, speed); chapter + voice sheets last (they have open-time render hooks). Removes 5 module globals.
2. **`public/js/util/storage.js`** — `readJSON(key, fallback)` / `writeJSON(key, value)` (try/catch both ways). Migrate the 7 hand-rolled localStorage sites (checkpoint prefix, book-meta, rail dismissals, saved voices, time-display, voice facets, language, client-settings fallback).
3. **`public/js/api.js` extension** — add `apiGet(path)` / `apiSend(method, path, body)` returning parsed JSON with one error shape (throw on !ok), sync headers included. Migrate call sites opportunistically as each region is extracted (~15 sites), not as a standalone sweep.
4. **Inline-onclick elimination** — replace generated-HTML `onclick=` handlers with delegated listeners on their containers: search result cards + retry buttons (`app.js:1965, 2015, 2252` → delegate on `#search-results`), delete triggers (`window.showDeleteModal`), voice-card buttons (`window.__selectVoice`/`__playSample` → delegate on the voice list), the static index.html empty-state button (line 67). This removes most `window.*` hatches and unblocks clean extraction. Keep `window.openBookFromLibrary` (used cross-region) until B2.

## B2. Low-coupling view extractions

5. **`public/js/views/library.js`** (~650 lines out) — book-meta cache + `bookProgressInfo` + `progressMetaLine` + `renderBookCard` + skeletons (1584-1710), rail (1711-1797), `loadLibrary` (1798-1865), filter/sort/view + badges (3242-3356), swipe-delete (4711-4815), delete-modal glue. Deps injected: `{openBook, navigateTo}`. Exports `initLibrary(deps)`, `loadLibrary`. `allBooks`/`currentViewMode`/`continueRailHasEntries` become module-local.
6. **`public/js/views/search.js`** (~500 lines out) — search + download + upload (1866-2321, 4816-4891) incl. `DOWNLOAD_STEPS`/SSE progress. Deps: `{loadLibrary, openBook, navigateTo}`. The `window.__rateLimitFallback` hack dies with B1.4's delegation.

## B3. Settings + voices

7. **`public/js/views/settings.js`** — convert the IIFE's non-voice sections (sources/sync/language/client-settings, ~3358-3888) to a module with `initSettings()` listening to the existing `xandrio:viewchange` event. IIFE-local state moves with it.
8. **`public/js/views/voices.js`** (the big one, ~700 lines: 3889-4588) — voice catalog/facets/render, cache status, HQ-prep panel, sample playback, `switchCurrentChapterToVoice`. This is the most player-coupled piece: inject `{getCurrentBook, getCurrentChapter, getChunkPlayer, loadChapter, togglePlayPause, applyPlaybackSpeed}` as getters/fns. Replace the four `window.__*` hatches with real exports (`loadVoices`, `refreshVoicePrepPanel`) imported by app.js at its 2 call sites (openBook ~2439, loadChapter ~2482). `switchCurrentChapterToVoice` must keep calling the exact same playback functions — treat it as engine-adjacent; move verbatim, test hardest.

## B4. Player presentation (riskiest — last)

9. **`public/js/views/player-ui.js`** — presentation-only functions the engine callbacks call: time-display helpers (229-271), chapter title/prep detail (445-527), progress/ambient/chapter-sheet render (528-673), audio-loading overlay + poll (1488-1583), reliability/tip widgets paint (305-363 — paint parts only; the polling timer control stays with the engine code), mini-player sync (2776-2817). **Engine callbacks stay in app.js and import from player-ui** — the seam is "callbacks decide when, player-ui decides what it looks like." `lastChunkTimeData`/`narrationPreparingStartedAt`/`audioLoadingPoll*` move into the module.
10. **Endgame check:** app.js should now be ≈ imports + globals + DOM refs + engine class/plumbing/callbacks + openBook/loadChapter/toggle + checkpoint + Media Session + lifecycle + boot + setupEventListeners (which shrinks as listeners move to their view modules). Do NOT rename to playback.js — not worth the churn.

## B5. Docs refresh (parallel-safe, do anytime)

- **`docs/API.md`**: regenerate the endpoint list from `server.js` + `lib/routes/*.js` — it's missing bookmarks, client settings, sync, voices, voice-cache, chunk endpoints, engines-status (if Plan A lands). Keep the existing per-endpoint format.
- **`docs/UI-REDESIGN-PLAN.md`**: add a header note "absorbed by the 2026-07 overhaul; historical" — don't delete.
- **`PRODUCT.md`** (repo root): audience (self-hosted single user, iPhone PWA primary), value prop, feature inventory, non-goals (multi-user, light theme).
- **`DESIGN.md`** (repo root): register (product/tool), token table from `style-v3.css:11-40`, patterns (sheets, skeletons, rail, toasts), anti-patterns (no backdrop-filter, no emoji, engine-boundary rule). These two are what the UI-Suite skill looks for on future reviews.
- **`docs/ARCHITECTURE.md`**: refresh the frontend module map after B1–B4.

## Verification (each step + endgame)

- Per step: `node --check` all touched modules; browser smoke (boot with zero console errors, navigate all views + back, open/close every sheet, play + seek + chapter change); the moved region's specific feature exercised (e.g., after B2.5: rail dismiss, filter hides rail, swipe delete).
- After B3.8 (voices): full voice-switch mid-chapter regression + sample-while-playing duck/restore + HQ-prep panel poll.
- After B4.9: complete playback matrix — chunked start → generation overlay with real counts → seek-ahead prioritize → chunk→single-file handoff → auto-advance → sleep-timer expiry fade → lock-screen Media Session.
- Endgame: `wc -l public/app.js` ≈ 1,400; `git diff public/js/chunk-player.js` empty across the whole effort; `grep -c "window.__" public/app.js` → 0.
