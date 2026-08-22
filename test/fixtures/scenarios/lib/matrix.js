'use strict';

// The single source of truth for which (view, state) combinations this
// harness produces, shared by scripts/scenario-server.js (which dataset to
// route to, what to delay/break) and scripts/scenario-shots.js (which URL to
// open, what interaction to perform, whether to skip a combination).
//
// Not every state is meaningful for every view — a player has no "empty"
// concept, login has no "skeleton". Combinations that don't apply are marked
// `applicable: false` with a one-line reason instead of being silently
// omitted, so a coverage report always accounts for all 56 cells.

const BOOK_ID = { player: 'scn-meridian', guide: 'scn-fieldnotes', activity: 'scn-driftwood' };

// Per-view primary data fetch the proxy delays/breaks for loading/skeleton/error.
const PRIMARY_ENDPOINT = {
  library: { method: 'GET', pattern: /^\/api\/library(?:\?|$)/ },
  search: { method: 'POST', pattern: /^\/api\/search$/ },
  settings: { method: 'GET', pattern: /^\/api\/voices(?:\?|$)/ },
  stats: { method: 'GET', pattern: /^\/api\/stats(?:\?|$)/ },
  guide: { method: 'GET', pattern: /^\/api\/book\/[^/]+\/guide(?:\?|$)/ },
  player: { method: 'GET', pattern: /^\/api\/book\/[^/]+(?:\?|$)/ },
  login: { method: 'POST', pattern: /^\/api\/auth\/login$/ }
};

const HASH_ROUTE = {
  library: '#/library',
  search: '#/search',
  settings: '#/settings',
  stats: '#/stats',
  guide: `#/guide/${BOOK_ID.guide}`,
  player: `#/player/${BOOK_ID.player}`,
  activity: '#/library',
  login: '#/library'
};

function cell({ dataset, applicable = true, reason, delayMs, errorStatus, interaction, route, overlay, isolateVariants, domSignature, domSignatureNote, allowVisible }) {
  return { dataset, applicable, reason, delayMs, errorStatus, interaction, route, overlay, isolateVariants, domSignature, domSignatureNote, allowVisible };
}

const NA = reason => cell({ dataset: 'full', applicable: false, reason });

// A domSignature proves — via a live CSS-selector check against the rendered
// page, not just "a screenshot was taken" — that a cell's declared state is
// what actually rendered. `present` selectors must each match a *visible*
// element; `absent` selectors must each match no visible element. Every
// selector here was found by reading the view's source (public/js/views/*,
// public/app.js) for the markup that specific state produces, not guessed.
function sig(present, absent, exactly) {
  return {
    present: present ? (Array.isArray(present) ? present : [present]) : [],
    absent: absent ? (Array.isArray(absent) ? absent : [absent]) : [],
    exactly: exactly || {}
  };
}

// A handful of cells render byte-identical DOM to a sibling state by design
// (not a bug — see the cited reason) and so have no distinguishing signature
// to assert. Listed explicitly, with why, rather than silently omitted, so a
// coverage report doesn't read "forgot to check this" as "verified".
const noSig = reason => ({ domSignature: undefined, domSignatureNote: reason });

// Rendered by settings.js's showOperatorNotice() at bootstrap, independent of
// route (public/index.html "operator-notice-dialog"; public/js/views/settings.js).
const COLD_SIGNATURE = sig('#operator-notice-dialog.active');
// public/js/features/offline.js updateOfflineBanner() toggles the `hidden`
// attribute on window 'online'/'offline' events, outside every .view
// container, so it applies unchanged across views.
const OFFLINE_SIGNATURE = sig('#offline-banner');
const OFFLINE_BANNER_VISIBLE = '#offline-banner:not([hidden])';
// The capture runner rejects a visible offline banner everywhere by default:
// it is contamination for any non-offline state. Offline cells are the narrow
// exception, and must declare that expected evidence explicitly rather than
// weakening the runner's global negative check.
const offlineCell = options => cell({
  ...options,
  domSignature: OFFLINE_SIGNATURE,
  allowVisible: [...new Set([...(options.allowVisible || []), OFFLINE_BANNER_VISIBLE])]
});

// Player sheets are intentionally individual cells, instead of incidental
// click-throughs inside player:full. `route` records the product route that
// opens the book and `overlay` makes the capture runner use both representative
// viewports. The interaction names are executed against the real UI below;
// there is no DOM class injection or synthetic sheet state in this harness.
const PLAYER_ROUTE = HASH_ROUTE.player;
const isolatedPlayerCell = options => cell({ ...options, isolateVariants: true });
const PLAYER_SHEET_CELLS = {
  chapters: isolatedPlayerCell({ dataset: 'full', route: PLAYER_ROUTE, overlay: true, interaction: 'player-open-chapters', domSignature: sig('#chapter-sheet.active .chapter-list-item.active') }),
  bookmarks: isolatedPlayerCell({ dataset: 'full', route: PLAYER_ROUTE, overlay: true, interaction: 'player-add-bookmark-and-open-chapters', domSignature: sig('#chapter-sheet.active .bookmarks-section .bookmark-row', null, { '#chapter-sheet.active .bookmarks-section .bookmark-row': 1 }) }),
  voice: isolatedPlayerCell({ dataset: 'full', route: PLAYER_ROUTE, overlay: true, interaction: 'player-open-voice', domSignature: sig('#voice-sheet.active #player-voice-list .voice-card') }),
  // The degraded dataset uses the genuine failing Chatterbox engine stub. The
  // selector is the product's visible down-engine card, not the engine status
  // object or a hidden element elsewhere in the page.
  'voice-degraded': isolatedPlayerCell({ dataset: 'degraded', route: PLAYER_ROUTE, overlay: true, interaction: 'player-open-voice', domSignature: sig('#voice-sheet.active #player-voice-list .voice-card--engine-down') }),
  speed: isolatedPlayerCell({ dataset: 'full', route: PLAYER_ROUTE, overlay: true, interaction: 'player-open-speed', domSignature: sig('#speed-sheet.active .speed-preset.active') }),
  sleep: isolatedPlayerCell({ dataset: 'full', route: PLAYER_ROUTE, overlay: true, interaction: 'player-open-sleep', domSignature: sig('#timer-modal.active .timer-option[data-mode="chapter"]') }),
  pronunciation: isolatedPlayerCell({ dataset: 'full', route: PLAYER_ROUTE, overlay: true, interaction: 'player-open-pronunciation', domSignature: sig('#pronunciation-repair-dialog.active #pronunciation-repair-context') })
};

const MATRIX = {
  library: {
    cold: cell({ dataset: 'cold', domSignature: COLD_SIGNATURE }),
    empty: cell({ dataset: 'empty', domSignature: sig('#library-list .empty-state-modern [data-add-book-empty]', '#library-list [data-retry-library]') }),
    loading: cell({ dataset: 'full', delayMs: 1800, domSignature: sig('#library-list .book-item.skeleton') }),
    skeleton: cell({ dataset: 'full', delayMs: 1800, domSignature: sig('#library-list .book-item.skeleton') }),
    error: cell({ dataset: 'full', errorStatus: 503, domSignature: sig('#library-list [data-retry-library]') }),
    offline: offlineCell({ dataset: 'full' }),
    degraded: cell({ dataset: 'degraded', ...noSig('provision.js seeds fewer/different books for "degraded"; library.js has no dataset-conditional rendering branch, so the DOM is structurally identical to "full"') }),
    full: cell({ dataset: 'full', domSignature: sig('#library-list .book-item[data-book-id]:not(.skeleton)') })
  },
  search: {
    cold: cell({ dataset: 'cold', domSignature: COLD_SIGNATURE }),
    empty: cell({ dataset: 'full', interaction: 'search-empty', domSignature: sig('.empty-state-modern', '[data-search-retry]') }),
    loading: cell({ dataset: 'full', delayMs: 2200, interaction: 'search-loading', domSignature: sig('.search-results-list .skeleton-result') }),
    skeleton: cell({ dataset: 'full', delayMs: 2200, interaction: 'search-loading', domSignature: sig('.search-results-list .skeleton-result') }),
    error: cell({ dataset: 'full', errorStatus: 503, interaction: 'search-error', domSignature: sig(['.empty-state-modern', '[data-search-retry]']) }),
    offline: offlineCell({ dataset: 'full' }),
    degraded: NA('Per-source failure is already the "error" state; a distinct degraded search UI does not exist'),
    full: cell({ dataset: 'full', interaction: 'search-full', domSignature: sig('.search-results-list .result-card[data-work-id]:not(.skeleton-result)') })
  },
  settings: {
    cold: cell({ dataset: 'cold', domSignature: COLD_SIGNATURE }),
    empty: NA('Settings is a fixed set of sections; there is no "no settings" state'),
    // #voice-list's own content (public/index.html: <details class="settings-section">
    // with no "open" attribute) is collapsed behind a closed native <details>
    // by default, so none of loading/error/degraded/full's distinguishing
    // voice-card markup is visible without expanding the accordion first.
    // 'settings-expand-voice' (scripts/scenario-shots.js performInteraction)
    // clicks the Voice section's <summary> the same way a user would; each
    // state below then asserts on what actually renders inside #voice-list
    // once it's open.
    loading: cell({ dataset: 'full', delayMs: 6000, interaction: 'settings-expand-voice', domSignature: sig(['details.settings-section[open]:has(#voice-list) > summary', 'details.settings-section[open]:has(#voice-list) .settings-hint'], '#voice-list .voice-card') }),
    skeleton: NA('Settings has no dedicated skeleton placeholder — see "loading"'),
    // The settings view's primary endpoint (above) targets GET /api/voices,
    // not GET /api/engines/status: voices.js's loadEngineStatus() swallows a
    // failed /api/engines/status into engineStatus = null with no visible
    // effect (isEngineDown/selectionDisabled both stay false, same as
    // "full" — a real, confirmed product gap, not a harness one; see
    // voices.js:222-227), so breaking that endpoint could never produce a
    // capturable error frame here. Breaking /api/voices instead exercises
    // loadVoices()'s existing catch block (voices.js:199-219), which really
    // does replace #voice-list's content with a distinct "Couldn't load
    // voices" retry state.
    error: cell({ dataset: 'full', errorStatus: 503, interaction: 'settings-expand-voice', domSignature: sig('details.settings-section[open] #voice-list [data-retry-voices]') }),
    offline: offlineCell({ dataset: 'full' }),
    // The degraded dataset's Chatterbox stub genuinely reports itself down
    // (test/fixtures/scenarios/lib/environment.js: createTtsEngineStub
    // ('chatterbox', { failing: dataset === 'degraded' })), which
    // voices.js's renderVoiceCard() reflects as a real .voice-card--engine-down
    // class — previously hidden only by the same closed accordion as "loading".
    degraded: cell({ dataset: 'degraded', interaction: 'settings-expand-voice', domSignature: sig('details.settings-section[open] #voice-list .voice-card--engine-down') }),
    full: cell({ dataset: 'full', interaction: 'settings-expand-voice', domSignature: sig('details.settings-section[open] #voice-list .voice-card', '#voice-list .voice-card--engine-down') })
  },
  stats: {
    cold: cell({ dataset: 'cold', domSignature: COLD_SIGNATURE }),
    empty: cell({ dataset: 'empty', domSignature: sig('#stats-body .empty-state-modern [data-stats-browse]') }),
    loading: cell({ dataset: 'full', delayMs: 1500, domSignature: sig('#stats-body .stats-loading') }),
    skeleton: NA('Stats renders a single loading placeholder, not a distinct skeleton — see "loading"'),
    error: cell({ dataset: 'full', errorStatus: 503, domSignature: sig('#stats-body .empty-state-modern [data-stats-retry]') }),
    offline: offlineCell({ dataset: 'full' }),
    degraded: cell({ dataset: 'degraded', ...noSig('provision.js seeds different stats positions for "degraded"; stats.js render() has no dataset-conditional branch, so the DOM is structurally identical to "full"') }),
    full: cell({ dataset: 'full', domSignature: sig('#stats-body .stats-tiles') })
  },
  guide: {
    cold: cell({ dataset: 'cold', domSignature: COLD_SIGNATURE }),
    empty: NA('A book not eligible for a guide is a distinct "needs classification" state, not empty — see docs'),
    loading: cell({ dataset: 'full', delayMs: 1800, domSignature: sig('#guide-body .settings-hint', ['#guide-body .guide-state', '#guide-body .guide-section']) }),
    skeleton: NA('Guide has no dedicated skeleton placeholder — see "loading"'),
    error: cell({ dataset: 'degraded', domSignature: sig('#guide-body .guide-state[data-state="error"]') }),
    offline: offlineCell({ dataset: 'full' }),
    degraded: cell({ dataset: 'degraded', domSignature: sig('#guide-body .guide-state[data-state="error"]') }),
    // A whole guide section is taller than a phone viewport. The heading is
    // the deterministic state-bearing evidence that can be fully framed.
    full: cell({ dataset: 'full', domSignature: sig('#guide-body #guide-overview > h3') })
  },
  player: {
    cold: isolatedPlayerCell({ dataset: 'cold', domSignature: COLD_SIGNATURE }),
    empty: NA('A player always addresses one book; there is no "no book" player state'),
    loading: isolatedPlayerCell({ dataset: 'full', delayMs: 1800, domSignature: sig('#audio-loading[data-status="preparing"], #audio-loading[data-status="generating"]') }),
    skeleton: NA('Player has no dedicated skeleton placeholder — see "loading"'),
    // errorStatus breaks the *book* fetch (GET /api/book/:id), which fails
    // before playback prep ever starts — public/app.js's openBook() catches
    // that in its outer try/catch and shows a toast (id="success-toast",
    // public/js/ui/toast.js), not the #audio-loading overlay (that only
    // covers *narration/chunk* failures once a book has already loaded).
    // Verified directly: the toast is what actually renders here.
    error: isolatedPlayerCell({ dataset: 'full', errorStatus: 503, domSignature: sig('#success-toast.show.toast--error'), allowVisible: ['#success-toast.show.toast--error'] }),
    offline: isolatedPlayerCell({ dataset: 'full', domSignature: OFFLINE_SIGNATURE, allowVisible: [OFFLINE_BANNER_VISIBLE] }),
    degraded: isolatedPlayerCell({ dataset: 'degraded', ...noSig('the degraded dataset leaves the default player book (scn-meridian, default voice kokoro:am_onyx) fully ready — the chatterbox-down state only surfaces in the voice sheet, which this cell does not open, so the DOM is structurally identical to "full"') }),
    full: isolatedPlayerCell({ dataset: 'full', domSignature: sig(null, '#audio-loading[data-status]:not([data-status=""])') }),
    ...PLAYER_SHEET_CELLS
  },
  // Audio Activity lives in the persistent library header, rather than in
  // #player-view. It is still a playback surface: this cell first starts a
  // real offline preparation through the book menu, then opens the real
  // activity sheet from the visible header control. The activity itself is
  // therefore deterministic, meaningful, and not fabricated in the DOM.
  activity: {
    active: cell({ dataset: 'full', route: HASH_ROUTE.activity, overlay: true, isolateVariants: true, interaction: 'library-start-offline-and-open-activity', domSignature: sig('#audio-activity-sheet.active .audio-activity-row[data-state="active"]') })
  },
  login: {
    cold: NA('Trusted-LAN/cold datasets never require login; the gate cannot appear without accounts configured'),
    empty: NA('Login has no "empty" concept'),
    loading: NA('Login round-trips fast enough that there is no reliably capturable loading frame'),
    skeleton: NA('Login has no skeleton placeholder'),
    error: cell({ dataset: 'login', interaction: 'login-error', domSignature: sig('#login-error') }),
    // login.js owns its small, auth-independent connectivity state because
    // public/app.js returns after showLoginGate() before initOffline() runs.
    // The gate must therefore surface disconnected sign-in rather than rely
    // on the authenticated app's global offline banner.
    offline: cell({ dataset: 'login', domSignature: sig('#login-offline-status:not([hidden])') }),
    degraded: NA('Login has no degraded concept distinct from error'),
    full: cell({ dataset: 'login', domSignature: sig(null, ['#login-error', '#login-offline-status:not([hidden])']) })
  }
};

module.exports = { MATRIX, HASH_ROUTE, PRIMARY_ENDPOINT, BOOK_ID };
