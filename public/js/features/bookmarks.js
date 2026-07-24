// Bookmarks feature: player-topbar "add bookmark" action plus a bookmarks
// section rendered inside the chapter sheet. Talks to /api/bookmarks
// directly; all playback interaction (seeking, chapter loads) goes through
// the host app's existing player functions, passed in via initBookmarks().
import { apiGet, apiSend } from '../api.js';
import { escapeHTML, safeAttr, formatTime, relativeTime } from '../util/format.js';
import { showToast, showUndoToast, announceToScreenReader } from '../ui/toast.js';
import { onActivate } from '../ui/keys.js';

const ICON_TRASH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10z"/></svg>';

let deps = null;
let bookmarksCache = [];

// deps: {
//   containerId,               // element id to render the bookmarks section into
//   getCurrentBook,            // () => current book object (needs .id)
//   getCurrentChapter,         // () => current chapter index
//   getCurrentTime,            // () => current playback position in seconds
//   getChapterTitle,           // (chapterIndex) => display title for a chapter
//   selectChapter,             // (chapterIndex, options) => Promise, commits a chapter selection
//   seek,                      // (seconds) => seek the active player
//   dismissChapterSheet,       // () => close the chapter sheet
//   onBookmarkAdded            // optional () => called after a bookmark is saved
// }
export function initBookmarks(options) {
  deps = options;
}

async function fetchBookmarks(bookId) {
  if (!bookId) return [];
  try {
    const data = await apiGet(`/api/bookmarks/${bookId}`);
    return Array.isArray(data.bookmarks) ? data.bookmarks : [];
  } catch {
    return [];
  }
}

function renderBookmarkRow(bm) {
  const chapterLabel = deps.getChapterTitle ? deps.getChapterTitle(bm.chapterIndex) : `Chapter ${bm.chapterIndex + 1}`;
  return `
    <div class="bookmark-row" data-bookmark-jump="${safeAttr(bm.id)}" role="button" tabindex="0">
      <div class="bookmark-row-main">
        <div class="bookmark-row-title">${escapeHTML(chapterLabel)} &middot; ${formatTime(bm.timestamp)}</div>
        <div class="bookmark-row-meta">${escapeHTML(relativeTime(bm.createdAt))}</div>
      </div>
      <button type="button" class="bookmark-delete-btn" data-bookmark-delete="${safeAttr(bm.id)}" aria-label="Delete bookmark">${ICON_TRASH}</button>
    </div>
  `;
}

export async function renderBookmarksSection() {
  if (!deps) return;
  const container = document.getElementById(deps.containerId);
  if (!container) return;

  const book = deps.getCurrentBook?.();
  if (!book?.id) {
    container.innerHTML = '';
    return;
  }

  const bookmarks = await fetchBookmarks(book.id);
  bookmarksCache = bookmarks;

  if (!bookmarks.length) {
    container.innerHTML = '';
    return;
  }

  const sorted = [...bookmarks].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

  container.innerHTML = `
    <div class="bookmarks-section">
      <div class="bookmarks-section-title">Bookmarks</div>
      ${sorted.map(renderBookmarkRow).join('')}
    </div>
  `;

  container.querySelectorAll('[data-bookmark-jump]').forEach(el => {
    el.addEventListener('click', () => jumpToBookmark(el.dataset.bookmarkJump));
    onActivate(el, () => jumpToBookmark(el.dataset.bookmarkJump));
  });
  container.querySelectorAll('[data-bookmark-delete]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBookmark(el.dataset.bookmarkDelete, el.closest('.bookmark-row'));
    });
  });
}

async function jumpToBookmark(bookmarkId) {
  const bm = bookmarksCache.find(b => b.id === bookmarkId);
  if (!bm || !deps) return;

  if (bm.chapterIndex !== deps.getCurrentChapter?.()) {
    await deps.selectChapter(bm.chapterIndex, {
      commitImmediately: true,
      seekToSeconds: bm.timestamp
    });
  } else {
    await deps.seek(bm.timestamp);
    deps.checkpointPlayback?.({ force: true });
    await deps.savePosition?.({ allowBackward: true, force: true });
  }
  deps.dismissChapterSheet?.();
}

function deleteBookmark(bookmarkId, rowEl) {
  // Optimistic delete: drop the row from the UI now, defer the DELETE ~5s so
  // Undo can restore it. The server keeps the bookmark until the commit fires,
  // so onUndo simply re-renders the section from the server.
  bookmarksCache = bookmarksCache.filter(b => b.id !== bookmarkId);
  const container = document.getElementById(deps.containerId);
  if (rowEl) {
    rowEl.remove();
    if (container && !container.querySelector('.bookmark-row')) container.innerHTML = '';
  } else {
    renderBookmarksSection();
  }

  showUndoToast('Bookmark deleted', {
    onUndo: () => { renderBookmarksSection(); },
    onCommit: async () => {
      try {
        await apiSend('DELETE', `/api/bookmarks/${bookmarkId}`);
      } catch {
        // best-effort; the row was already dropped locally
      }
    }
  });
}

export async function addBookmarkAtCurrentPosition() {
  if (!deps) return;
  const book = deps.getCurrentBook?.();
  if (!book?.id) return;

  const chapterIndex = deps.getCurrentChapter?.();
  const timestamp = deps.getCurrentTime?.();
  if (!Number.isFinite(chapterIndex) || !Number.isFinite(timestamp)) return;

  try {
    await apiSend('POST', '/api/bookmarks', { bookId: book.id, chapterIndex, timestamp });

    const label = `Bookmarked at ${formatTime(timestamp)}`;
    showToast(label);
    announceToScreenReader(label);
    deps.onBookmarkAdded?.();
  } catch {
    showToast('Could not save bookmark', 'error');
  }
}
