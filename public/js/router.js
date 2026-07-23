// Hash router for Xandrio.
//
// Wraps the existing showView()/openBook() rendering path — the router decides
// *when* they run, never *how* they render. Routes:
//   #/library (default) · #/search · #/settings · #/player/:bookId
//
// Transient sheets/modals get history-backed close: opening one pushes a
// history entry so the back button dismisses the sheet instead of leaving the
// screen (Libby/BookPlayer behavior on Android; harmless on iOS standalone,
// which has no back button).

let config = null;
let lastRenderedKey = null;
let sheetStack = [];
let ignorePops = 0;

function parseHash() {
  const hash = window.location.hash || '';
  const playerMatch = hash.match(/^#\/player\/([^/?#]+)/);
  if (playerMatch) {
    return { view: 'player', bookId: decodeURIComponent(playerMatch[1]) };
  }
  const viewMatch = hash.match(/^#\/(library|search|settings|stats)\b/);
  return { view: viewMatch ? viewMatch[1] : 'library', bookId: null };
}

function routeKey(route) {
  return route.view === 'player' ? `player:${route.bookId}` : route.view;
}

function keyToView(key) {
  if (!key) return null;
  return key.startsWith('player:') ? 'player' : key;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Runs `apply` (a synchronous showView call) inside a View Transition when the
// browser supports it, tagging <html data-vt> so CSS can pick slide vs. fade.
// Falls back to a plain call under reduced-motion or unsupported browsers.
function runViewTransition(fromView, toView, apply) {
  if (!fromView || !document.startViewTransition || prefersReducedMotion()) {
    apply();
    return;
  }
  const html = document.documentElement;
  if (fromView === 'library' && toView === 'player') html.dataset.vt = 'up';
  else if (fromView === 'player' && toView === 'library') html.dataset.vt = 'down';
  else html.dataset.vt = 'fade';

  const transition = document.startViewTransition(() => apply());
  transition.finished.catch(() => {}).finally(() => { delete html.dataset.vt; });
}

async function route({ force = false } = {}) {
  const target = parseHash();
  const key = routeKey(target);
  if (!force && key === lastRenderedKey) return;
  const previousView = keyToView(lastRenderedKey);
  lastRenderedKey = key;

  if (target.view === 'player') {
    if (config.isBookOpen(target.bookId)) {
      runViewTransition(previousView, 'player', () => config.showView('player'));
    } else {
      try {
        // openBook renders the player view itself once the book is loaded.
        // Not wrapped in a view transition: it awaits async loading work, and
        // the transition API expects the DOM update to happen synchronously.
        await config.openBook(target.bookId);
      } catch (err) {
        console.error('Router: failed to open book from hash:', err);
        navigateTo('library', null, { replace: true });
      }
    }
  } else {
    runViewTransition(previousView, target.view, () => config.showView(target.view));
  }
}

export function navigateTo(view, bookId = null, { replace = false } = {}) {
  const hash = view === 'player' ? `#/player/${encodeURIComponent(bookId)}` : `#/${view}`;
  if (window.location.hash === hash) {
    route({ force: true });
    return;
  }
  if (replace) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
    route();
  } else {
    window.location.hash = hash; // triggers hashchange → route()
  }
}

// openBook() is still called directly from flows that need to await it
// (library tap, post-download, post-upload). This keeps the address bar and
// history in sync without re-triggering the router for a book that is already
// being opened.
export function syncPlayerHash(bookId) {
  const hash = `#/player/${encodeURIComponent(bookId)}`;
  if (window.location.hash === hash) {
    lastRenderedKey = `player:${bookId}`;
    return;
  }
  lastRenderedKey = `player:${bookId}`; // set first so the hashchange no-ops
  window.location.hash = hash;
}

// --- History-backed sheets/modals ------------------------------------------

export function sheetOpened(closeFn) {
  sheetStack.push(closeFn);
  window.history.pushState({ xandrioSheet: sheetStack.length }, '');
}

// UI-driven close (backdrop, ✕, selection, Esc). Closes immediately and
// consumes the history entry the open pushed. Returns false when no
// history-backed sheet is open (or the top of the stack is a different
// sheet), so callers can fall back to a direct close.
export function requestSheetClose(expectedCloseFn = null) {
  const top = sheetStack[sheetStack.length - 1];
  if (!top || (expectedCloseFn && top !== expectedCloseFn)) return false;
  sheetStack.pop();
  top();
  ignorePops += 1;
  window.history.back();
  return true;
}

// View-change teardown (closeTransientSheets) closes the DOM directly; drop
// the stale closers so a later back press doesn't re-run them.
export function clearSheetStack() {
  sheetStack = [];
}

export function initRouter(options) {
  config = options;

  window.addEventListener('hashchange', () => route());
  window.addEventListener('popstate', () => {
    if (ignorePops > 0) {
      ignorePops -= 1;
      return;
    }
    const closeFn = sheetStack.pop();
    if (closeFn) closeFn();
    // If this pop also crossed a hash boundary, hashchange fires and routes.
  });

  if (!window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + '#/library');
  }
  route({ force: true });
}
