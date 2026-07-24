// Toast + screen-reader announcements.

let toastEl = null;
let hideTimer = null;

// showToast(message, type = '', options = {})
//   type    — '' (neutral/success styling) or 'error'
//   options — { actionLabel, onAction, duration }
//     When actionLabel is present an inline button renders in the toast;
//     clicking it calls onAction and dismisses the toast.
export function showToast(message, type = '', options = {}) {
  if (!toastEl) toastEl = document.getElementById('success-toast');
  if (!toastEl) return;
  const { actionLabel, onAction, duration = 3000 } = options;

  clearTimeout(hideTimer);
  toastEl.classList.toggle('toast--error', type === 'error');

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
      onAction?.();
    });
    toastEl.append(msg, btn);
  } else {
    toastEl.classList.remove('toast--action');
    toastEl.textContent = message;
  }

  toastEl.classList.add('show');
  hideTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(hideTimer);
  if (toastEl) toastEl.classList.remove('show');
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
let pagehideWired = false;

function commitPending() {
  const entry = pendingUndo;
  if (!entry || entry.settled) return;
  entry.settled = true;
  pendingUndo = null;
  clearTimeout(entry.timer);
  entry.onCommit?.();
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
    action?.();
  };

  showToast(message, '', {
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
