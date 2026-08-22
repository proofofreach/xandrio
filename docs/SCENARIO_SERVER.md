# Synthetic scenario server

A harness that boots the **real** `server.js`/`public/` bundle against synthetic
data, with every outbound provider, TTS, and network call stubbed, and exposes
named, deep-linkable states for each view — the prerequisite for any later
visual, accessibility, or interaction critic to have something real and
reproducible to look at.

```
npm run scenario:serve   # long-running dev server, prints the scenario matrix
npm run scenario:shots   # boots the environment, screenshots the matrix, tears down
```

## How it works

- **Five datasets, five real server processes.** `cold`, `empty`, `full`,
  `degraded`, and `login` each get their own `DATA_DIR`/`CACHE_DIR`
  (`test/fixtures/scenarios/lib/provision.js`) and their own `node server.js`
  child process. Nothing about the server is mocked — real chapter
  extraction/normalization, real xbook caching, real TTS chunking/ffmpeg
  mastering, real listening-stats computation, real book-guide validation.
- **One public proxy in front of all five**
  (`test/fixtures/scenarios/lib/proxy-router.js`). Address a scenario with an
  `X-Xandrio-Scenario: <view>:<state>` request header (Playwright's
  `context.setExtraHTTPHeaders` attaches it to the document load and every
  subsequent XHR/fetch automatically):
  ```
  curl -H "X-Xandrio-Scenario: library:loading" http://127.0.0.1:8399/
  ```
  The header picks which dataset to route to and, for that view's one
  "primary" data endpoint (`test/fixtures/scenarios/lib/matrix.js`), whether
  to delay the response (`loading`/`skeleton`) or fail it (`error`) — real
  local responses are near-instant, so a few states need an injected delay to
  be reliably screenshottable at all. Everything else passes straight
  through untouched. Proxied requests keep their original `Host` header (the
  public proxy address) rather than being rewritten to the backend's port —
  `lib/csrf.js`'s same-origin check compares the browser's `Origin` against
  the request's own `Host`, so rewriting it would 403 every state-changing
  request (this was a real bug caught by actually loading the player, not a
  hypothetical).
- **No live network egress, structurally.** Every dataset server is launched
  with `NODE_OPTIONS=--require .../lib/network-guard.js`, which patches
  Node's `http.request`/`https.request`, `http.get`/`https.get`, **and**
  global `fetch()` so any call to a non-loopback host is rewritten to the
  local provider stub instead (`test/fixtures/scenarios/lib/provider-stub.js`).
  All three are guarded independently, not via one shared choke point:
  `http.get`/`https.get` call Node's own internal, unexported `request()`
  rather than `module.exports.request`, so patching `.request` alone never
  touches `.get()`; global `fetch()` is implemented by undici, which opens
  its own sockets and is invisible to `http`/`https` patches entirely
  (`lib/search-cover-service.js`'s `writeRemoteCover` calls `fetch()`
  directly — this is a real, exercised code path, not a hypothetical). A
  fetch() destination the guard cannot safely rewrite (a non-HTTP(S) scheme)
  rejects instead of falling through to a real request — fail-closed, not
  fail-open. This isn't environment-specific — it holds whether or not the
  machine actually has internet access, and it covers every provider
  uniformly, including Gutenberg and Internet Archive, which have no
  configurable base-URL env var to redirect. Kokoro/Chatterbox are pointed at
  their own stub instances directly via `KOKORO_TTS_URL`/`CHATTERBOX_TTS_URL`.
  Edge TTS has no configurable endpoint at all, so it's excluded outright
  (`XANDRIO_VOICE_PROVIDERS=kokoro,chatterbox`) rather than stubbed.
  Dataset children use a fixed scenario-only environment instead of inheriting
  `process.env`; operator credentials and private-provider flags cannot enter
  the harness. The one deliberate exception is `PATH`, passed through
  unchanged — `lib/audio-chunk-service.js` shells out to a real `ffmpeg`
  binary for chunk mastering, and with no `PATH` at all `spawn('ffmpeg', ...)`
  fails `ENOENT` before it ever runs, which the client only sees as a generic
  chunk-generation "error" status. `PATH` carries no credentials and reveals
  nothing about the operator; it's the same directory search path any real
  deployment's shell already gives `node server.js`.
  `npm run scenario:verify-isolation` is a fast, no-server-boot
  regression that proves this allowlist and that all three entry points
  (`request()`, `get()`, `fetch()`) are redirected to a loopback stub and
  never reach a real host — see
  `test/fixtures/scenarios/verify-network-guard.js`.
- **No credentials, anywhere.** No `ANNAS_SECRET_KEY` or Z-Library auth is
  ever set. That alone isn't what keeps them silent, though — both report
  `configured: true` unconditionally in the real provider registry. What
  actually blocks them is that every dataset leaves the operator policy's
  `unverifiedSourcesEnabled` flag **off**, which gates Anna's Archive,
  Z-Library, *and* Internet Archive behind a real acknowledgement
  requirement — a request naming any of the three fails fast with
  `SOURCE_ACKNOWLEDGEMENT_REQUIRED` before any provider code runs. This
  matters most for Anna's Archive, whose search launches a real headless
  browser (`lib/annas-scraper.js`) with its own networking that the network
  guard (which patches Node's `http`/`https` modules) cannot see or
  redirect — it must never run at all, not merely be pointed somewhere
  synthetic. The `login` dataset's one seeded account
  (`reader` / `scenario-demo-only`) is a local instance credential the
  harness creates itself, not a stored external
  secret.

## Scenario matrix

`test/fixtures/scenarios/lib/matrix.js` is the single source of truth for
which `(view, state)` cells exist, shared by both scripts. Run
`npm run scenario:serve` to print the live matrix, including which cells are
intentionally not applicable and why (a player has no "empty" state, login
has no "skeleton", etc.) — nothing is silently dropped.

| view | cold | empty | loading | skeleton | error | offline | degraded | full |
|---|---|---|---|---|---|---|---|---|
| library | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| search | ✓ | ✓ (interaction) | ✓ (interaction) | ✓ (interaction) | ✓ (interaction) | ✓ | — | ✓ (interaction) |
| settings | ✓ | — | ✓ (interaction) | — | ✓ (interaction) | ✓ | ✓ (interaction) | ✓ (interaction) |
| stats | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| guide | ✓ | — | ✓ | — | ✓ (job failed) | ✓ | ✓ | ✓ |
| player | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| login | — | — | — | — | ✓ (interaction) | ✓ | — | ✓ |

`—` cells have a one-line reason printed by `scenario:serve` (e.g. "a player
always addresses one book; there is no 'no book' player state").

## Dimensions captured

`scripts/scenario-shots.js` screenshots each applicable cell at:

- **Viewport**: iPhone-sized (390×844, mobile UA, touch) and desktop
  (1280×800).
- **Color scheme**: `dark` and `light` (via Playwright's `colorScheme`).
  **Xandrio currently ships one fixed dark theme** — there is no
  `prefers-color-scheme` media query or in-app toggle (confirmed by reading
  `public/style-v3.css` and `public/app.js`). The `light` shots are expected
  to look visually identical to `dark`; they exist to catch accidental light
  leakage from native form-control chrome or browser UA styles, not to show
  a light theme that doesn't exist. If a light theme is ever added, this is
  where it starts getting exercised.
- **Motion**: `no-preference` and `reduce` (via Playwright's
  `reducedMotion`, which the router in `public/js/router.js` already reads
  for view transitions).
- **Text scale**: `normal` and `large`. **Xandrio has no in-app text-scale
  control either.** "Large" is emulated with a page-zoom
  (`document.documentElement.style.zoom = '1.4'`) as a stand-in for real
  browser/OS accessibility zoom, so overflow/reflow problems under enlarged
  text are still visible even without a dedicated setting to drive.

By default (`--dimensions=sample`) every applicable cell gets one
mobile/dark/normal-motion/normal-text shot, and each view's `full` state
additionally gets one desktop, one light, one reduced-motion, and one
large-text shot. The four state-bearing settings cells (`loading`, `error`,
`degraded`, and `full`) also get a desktop dark/normal shot after their Voice
accordion is opened. This proves the settings state surface at both responsive
breakpoints without paying for the full cartesian product (7 views × 8 states
× 16 variants) on every run. Pass `--dimensions=full` for a deliberate,
occasional full-matrix audit. `--views=library,player` and
`--states=full,loading` narrow a run further.

Output: `artifacts/scenario-shots/<view>/<state>/<viewport>_<colorScheme>_<motion>_<textScale>.png`.

A single (view, state, variant) failure does not abort the sweep. Every
applicable cell is always attempted; failures are collected and reported
together, and the process exits nonzero only after every cell has had a
chance to capture — so one bad cell can never cost every other cell its
screenshot, and a single run always produces the complete artifact set
(minus only that cell) for inspection.

Every capture is checked against the viewport it asked for: after
`page.screenshot()`, `scripts/scenario-shots.js` reads the actual pixel
dimensions straight out of the PNG's IHDR chunk and compares them against
`viewport.width/height * deviceScaleFactor`, throwing (nonzero exit) on any
mismatch. This guards against `browser.newContext()` silently ignoring
malformed viewport options — Playwright requires dimensions nested under
`viewport: {width, height}`, not top-level `width`/`height` keys, and a
context built the wrong way falls back to the 1280×720 default without
raising an error, which previously meant every "mobile" shot was actually a
desktop-width render with no 390×844 iPhone/PWA evidence at all.
`npm run scenario:verify-viewport` runs a standalone, fast version of this
check directly against `about:blank` for every entry in `VIEWPORTS`,
without booting the five-dataset server.

`npm run scenario:verify-fixtures` is a similarly fast, no-server-boot
preflight that checks every `content/books.json` entry's `cover` field
resolves to a real JPEG in `covers/`, and that every file in `covers/` is
referenced by some book. `provision.js`'s `writeBookXBook()` resolves that
field with a plain `fs.copyFile()` and throws `ENOENT` on any mismatch —
run this first when adding or editing a book fixture, since that ENOENT
otherwise only surfaces after `scenario:shots` has spent time booting all
five dataset server processes, and kills the 'full' dataset before it
produces a single screenshot.

`npm run scenario:verify` writes one JSON judge envelope to stdout for Loopy.
It exits `0` only when its `status` is `complete`; an `actionable` status exits
nonzero so normal shell chains and CI jobs fail. `npm run scenario:verify-exit`
is the focused regression check for that contract.

## Settings view: opening the closed-by-default Voice accordion

The settings view's Voice section is a native `<details class="settings-section">`
with no `open` attribute (`public/index.html`), so its voice-card markup never
renders visibly until something opens it. `settings-expand-voice`
(`scripts/scenario-shots.js` `performInteraction`) clicks the section's
`<summary>` — the same thing a real user would do — before capturing
`settings:loading`/`error`/`degraded`/`full`, each of which asserts a distinct
signature inside `#voice-list` once it's open (empty while still loading,
`[data-retry-voices]` on error, `.voice-card--engine-down` when degraded,
plain `.voice-card`s when full).

`npm run scenario:verify-settings` is the focused executable regression. It
runs only those four cells in a temporary output directory, relies on their
live DOM-signature checks, and verifies that the mobile and desktop primary
screenshots are each distinct across the four states. Its child process gets
only `PATH`; no operator credential or provider environment is inherited.

The settings view's primary endpoint (`test/fixtures/scenarios/lib/matrix.js`
`PRIMARY_ENDPOINT`) targets `GET /api/voices`, not `GET /api/engines/status`.
Breaking `/api/engines/status` is a dead end for a capturable error frame:
`voices.js`'s `loadEngineStatus()` swallows that failure into
`engineStatus = null` with no visible effect at all (a real, confirmed
product gap, not a harness one — see `voices.js:222-227`). Breaking
`/api/voices` instead exercises `loadVoices()`'s existing catch block
(`voices.js:199-219`), which really does replace `#voice-list`'s content with
a distinct "Couldn't load voices" retry state.

## Known limitations (intentional, not silent)

- **Search-result acquisition (download/import) is not wired through the
  stub.** The matrix targets view *states*, not the full import pipeline;
  Gutenberg/Internet Archive/OPDS "download" links resolve to a placeholder
  body via the provider stub, not a real EPUB. Search *results rendering* —
  titles, authors, per-source status, rights/license labels — is real.
- **Anna's Archive, Z-Library, and Internet Archive search results never
  appear** in a default scenario search (see "No credentials, anywhere"
  above) — all three report `configured: true` but sit behind the
  operator's unverified-sources acknowledgement, which every dataset leaves
  off. A search naming them fails fast with `SOURCE_ACKNOWLEDGEMENT_REQUIRED`
  rather than running. `defaultSearchSources` in
  `test/fixtures/scenarios/lib/provision.js` only lists Gutenberg and
  Standard Ebooks for this reason. Flip `unverifiedSourcesEnabled` to `true`
  in `seedSettings` for a deliberate run that needs to see the acknowledged
  state — that's still safe, since Internet Archive is redirected by the
  network guard the same way Gutenberg is (Anna's Archive itself must stay
  off; see the comment there).
- **`degraded` is deliberately narrow**: Chatterbox is down (Kokoro stays
  healthy), one book (`scn-fieldnotes`) has a failed book-guide job and
  partial audio generation. It is not an exhaustive fault-injection matrix —
  extend `test/fixtures/scenarios/lib/provision.js`'s `DEGRADED_OVERRIDES`
  and `test/fixtures/scenarios/content/books.json` if a specific degraded
  shape is needed for a later critic.
- **Ready-guide provenance is fixture-derived.** `provision.js` computes the
  guide source identity from the same persisted book record and normalized
  chapters that the real server reads. `verify-guide-fixture-provenance.js`
  rejects a fingerprint or chapter-structure mismatch before a nominally
  ready guide can be captured as a stale-warning frame.
- **`loading`/`skeleton` capture a fixed instant (600ms) into an injected
  delay**, not the exact first paint of a skeleton. It reliably catches
  "mid-flight" but is not a substitute for the precise DOM assertions in
  `scripts/smoke-browser.js`'s `verifyLibraryLoadStates()`.

## Adding a new scenario

1. Add or edit content in `test/fixtures/scenarios/content/*.json` (books,
   search results) — keep it synthetic; no private library data.
2. If it needs new derived data shape, extend
   `test/fixtures/scenarios/lib/provision.js`.
3. Add/edit a cell in `test/fixtures/scenarios/lib/matrix.js`. Every cell
   must be either `applicable: true` with a `dataset`, or
   `applicable: false` with a `reason` — there is no silent third option.
4. Re-run `npm run scenario:serve` to confirm the printed matrix and
   `curl -H "X-Xandrio-Scenario: <view>:<state>"` the new cell before wiring
   up a screenshot.
