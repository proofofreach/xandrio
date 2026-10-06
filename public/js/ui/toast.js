// Toast + screen-reader announcements.

let toastEl = null;
let hideTimer = null;

function runToastAction(action, label = 'Toast action') {
  if (typeof action !== 'function') return;
  try {
    Promise.resolve(action()).catch(error => console.error(`${label} failed:`, error));
  } catch (error) {
    console.error(`${label} failed:`, error);
  }
}

// ---- Inline status awareness ---------------------------------------------
// A toast must never repeat an error that an inline status area already shows
// on screen. Inline areas tag themselves with a key (markInlineStatus); a toast
// with the same key is suppressed while that area is visible. As a fallback,
// an error toast whose text matches a visible inline status is suppressed too.
const INLINE_STATUS_ATTR = 'data-toast-key';
const inlineStatusEls = new Set();

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isShown(el) {
  if (!el || !el.isConnected || el.hidden) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  return el.offsetParent !== null || el.getClientRects?.().length > 0;
}

// Register an element that can show status inline (e.g. the player's audio
// loading panel). Optional `key` tags what it currently shows.
export function registerInlineStatus(el, key = null) {
  if (!el) return;
  inlineStatusEls.add(el);
  markInlineStatus(el, key);
}

// Tag (or clear, with null) the message key an inline status area shows.
export function markInlineStatus(el, key = null) {
  if (!el?.setAttribute) return;
  inlineStatusEls.add(el);
  if (key) el.setAttribute(INLINE_STATUS_ATTR, key);
  else el.removeAttribute(INLINE_STATUS_ATTR);
  // The inline area can appear after the toast: a toast with the same key
  // already on screen then gives way. Checked after the caller has made the
  // area visible.
  if (key) {
    queueMicrotask(() => {
      if (currentKey === key && toastEl?.classList.contains('show') && isShown(el)) hideToast();
    });
  }
}

export function isInlineStatusShowing(key = null, message = '') {
  const text = normalizeText(message);
  for (const el of inlineStatusEls) {
    if (!isShown(el)) continue;
    if (key && el.getAttribute?.(INLINE_STATUS_ATTR) === key) return true;
    if (text && normalizeText(el.textContent).includes(text)) return true;
  }
  if (key && typeof document?.querySelectorAll === 'function') {
    for (const el of document.querySelectorAll(`[${INLINE_STATUS_ATTR}]`)) {
      if (el.getAttribute(INLINE_STATUS_ATTR) === key && isShown(el)) return true;
    }
  }
  return false;
}

// ---- Toast ----------------------------------------------------------------
// showToast(message, type = '', options = {})
//   type    — '' (neutral/success styling) or 'error'
//   options — { actionLabel, onAction, duration, key }
//     When actionLabel is present an inline button renders in the toast;
//     clicking it calls onAction and dismisses the toast.
//     key dedupes: a toast with the key already on screen is kept (its timer
//     restarts) instead of being shown again. It defaults to type + message.
//     A toast whose key or error text is already visible in an inline status
//     area is suppressed.
// Returns false when the toast was suppressed.
// Toasts dock at the bottom, above the mini player and tab bar, so they
// never cover navigation or transport (see shell.css).
let currentKey = null;

// ---- Docking above an open sheet -------------------------------------------
// A toast must never cover an open sheet's controls. While a sheet is open the
// toast docks just above the sheet's top edge, so feedback from the sheet's own
// actions ("Could not save book speed") stays visible while the user is still
// there; deferring it until the sheet closes would hide exactly the message the
// user needs. Only when the sheet leaves no room for a toast (a short landscape
// viewport) is the toast deferred until the sheet closes.
const DOCK_GAP = 12;
const TOAST_ROOM = 76;
let pendingToast = null;
let dockWired = false;

function openSheetPanel() {
  let tallest = null;
  document.querySelectorAll('.voice-sheet.active .voice-sheet-panel').forEach(panel => {
    if (!tallest || panel.offsetHeight > tallest.offsetHeight) tallest = panel;
  });
  return tallest;
}

// Returns true when the toast can be shown now.
// A view can dock the toast at the top instead (the player does, under its
// nav, see player.css). It says so with `--toast-dock: top`. The toast is
// always pinned by ONE vertical edge: pinning top and bottom together
// stretches it into a giant box over the sheet.
function isTopDocked() {
  return getComputedStyle(toastEl).getPropertyValue('--toast-dock').trim() === 'top';
}

function dockToast() {
  if (!toastEl) return true;
  toastEl.style.removeProperty('bottom');
  toastEl.style.removeProperty('top');
  const panel = openSheetPanel();
  if (!panel) return true;
  const sheetTop = window.innerHeight - panel.offsetHeight;
  const topDocked = isTopDocked();
  // A top-docked toast that clears the sheet stays where it is.
  if (topDocked && (parseFloat(getComputedStyle(toastEl).top) || 0) + TOAST_ROOM <= sheetTop) return true;
  if (sheetTop < TOAST_ROOM) return false;
  // Otherwise it sits just above the sheet's top edge, by its bottom edge only.
  if (topDocked) toastEl.style.top = 'auto';
  toastEl.style.bottom = `${panel.offsetHeight + DOCK_GAP}px`;
  return true;
}

function wireDocking() {
  if (dockWired || typeof MutationObserver !== 'function') return;
  dockWired = true;
  new MutationObserver(() => {
    if (pendingToast && !openSheetPanel()) {
      const [message, type, options] = pendingToast;
      pendingToast = null;
      showToast(message, type, options);
      return;
    }
    if (toastEl?.classList.contains('show') && !dockToast()) hideToast();
    else if (toastEl?.classList.contains('show')) dockToast();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => { if (toastEl?.classList.contains('show')) dockToast(); });
}

export function showToast(message, type = '', options = {}) {
  if (!toastEl) toastEl = document.getElementById('success-toast');
  if (!toastEl) return false;
  const { actionLabel, onAction, duration = 3000 } = options;
  const key = options.key || `${type}:${message}`;

  if (isInlineStatusShowing(options.key || null, type === 'error' ? message : '')) {
    return false;
  }

  wireDocking();
  if (!dockToast()) {
    pendingToast = [message, type, options];
    return true;
  }
  clearTimeout(hideTimer);
  // Same key already on screen: keep it (no flash, no stacking). An action
  // toast still rebinds so its button runs the newest handler.
  if (currentKey === key && toastEl.classList.contains('show') && !actionLabel) {
    hideTimer = setTimeout(hideToast, duration);
    return true;
  }
  currentKey = key;
  toastEl.classList.toggle('toast--error', type === 'error');
  toastEl.dataset.toastKey = key;

  if (actionLabel) {
    toastEl.classList.add('toast--action');
    toastEl.textContent = '';
    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      hideToast();
      runToastAction(onAction);
    });
    toastEl.append(msg, btn);
  } else {
    toastEl.classList.remove('toast--action');
    toastEl.textContent = message;
  }

  toastEl.classList.add('show');
  hideTimer = setTimeout(hideToast, duration);
  return true;
}

export function hideToast() {
  clearTimeout(hideTimer);
  pendingToast = null;
  currentKey = null;
  if (toastEl) toastEl.classList.remove('show');
}

// ---- Inline confirmation --------------------------------------------------
// Confirms a tool's action on the tool itself ("Saved · 12:04" for ~2s)
// instead of a toast, so nothing covers the transport. The original label
// stays in the DOM underneath; screen readers hear the confirmation.
const confirmationTimers = new WeakMap();

export function showInlineConfirmation(target, text, { duration = 2000 } = {}) {
  if (!target) return;
  clearTimeout(confirmationTimers.get(target));
  let label = target.querySelector(':scope > .inline-confirmation');
  if (!label) {
    label = document.createElement('span');
    label.className = 'inline-confirmation';
    label.setAttribute('aria-hidden', 'true');
    target.append(label);
  }
  label.textContent = text;
  target.classList.add('is-confirming');
  announceToScreenReader(text);
  confirmationTimers.set(target, setTimeout(() => {
    target.classList.remove('is-confirming');
    label.remove();
    confirmationTimers.delete(target);
  }, duration));
}

// ---- Undo toast ----------------------------------------------------------
// Optimistic-delete helper: the caller removes the item from the UI up front,
// then calls showUndoToast to defer the real (server/cache) commit.
//   onCommit — runs when the window expires, the toast is superseded by a
//              newer undo toast, or the page is hidden (best-effort) WITHOUT
//              an undo. This must equal the site's original delete behavior.
//   onUndo   — runs if the user taps Undo; the pending commit is cancelled.
// Only one undo is pending at a time; showing a new one commits the previous.
let pendingUndo = null;
let undoSequence = 0;
let pagehideWired = false;

function commitPending() {
  const entry = pendingUndo;
  if (!entry || entry.settled) return;
  entry.settled = true;
  pendingUndo = null;
  clearTimeout(entry.timer);
  runToastAction(entry.onCommit, 'Undo commit');
}

export function showUndoToast(message, { onUndo, onCommit, duration = 5000 } = {}) {
  if (!pagehideWired) {
    pagehideWired = true;
    // Flush a pending commit if the page is being torn down so it isn't lost.
    window.addEventListener('pagehide', commitPending);
  }

  // A new undo supersedes any in-flight one: commit the previous without undo.
  commitPending();

  const entry = { onCommit, settled: false, timer: null };
  pendingUndo = entry;

  const settle = (action) => {
    if (entry.settled) return;
    entry.settled = true;
    if (pendingUndo === entry) pendingUndo = null;
    clearTimeout(entry.timer);
    runToastAction(action, action === onUndo ? 'Undo action' : 'Undo commit');
  };

  showToast(message, '', {
    key: `undo:${++undoSequence}`,
    actionLabel: 'Undo',
    duration,
    onAction: () => settle(onUndo)
  });

  entry.timer = setTimeout(() => settle(onCommit), duration);
}

export function announceToScreenReader(message) {
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.className = 'sr-only';
  announcement.textContent = message;
  document.body.appendChild(announcement);
  setTimeout(() => announcement.remove(), 1000);
}
