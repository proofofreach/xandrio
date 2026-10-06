// App shell: the phone tab bar, the desktop sidebar, the persistent mini
// player's press-and-hold Recent sheet, and the one-time coach hint.
//
// The shell only navigates through hash links / navigateTo, so deep links
// and history keep working; it never owns engine state. app.js passes
// getters and actions in initShell().
//
// Hooks for later phases:
//   - openRecentSheet() is exported for the player's Recent button.
//   - [data-shell-count] spans in the sidebar take scope counts (library.js
//     fills them on every filter pass).
//   - body[data-view] names the active view for view-specific styling.

import { navigateTo } from '../router.js';
import { registerSheet } from './sheets.js';
import { escapeHTML, safeAttr, coverImageHTML, formatTime } from '../util/format.js';
import { timeLeftLabel } from '../util/time-left.mjs';
import { readText, writeText } from '../util/storage.js';
import { getReferencePlaybackSpeed } from '../views/playback-speed.js';

const COACH_KEY = 'xandrio_coach_recent_hint';
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
const RECENT_LIMIT = 5;

let deps = {};
let recentSheet = null;
let recentList = null;
let coachHint = null;
let inProgressCount = 0;
let activeView = 'library';

// Which tab is "on" for a view. Stats is reached from Library on the phone.
const TAB_FOR_VIEW = { library: 'library', stats: 'library', search: 'search', settings: 'settings' };

function syncNavigation(view) {
  activeView = view || 'library';
  document.body.dataset.view = activeView;
  const tab = TAB_FOR_VIEW[activeView] || null;
  document.querySelectorAll('[data-shell-tab]').forEach(link => {
    const on = link.dataset.shellTab === tab;
    link.classList.toggle('is-on', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const scope = document.querySelector('[data-library-tab].active')?.dataset.libraryTab || 'shelf';
  // The docked player on desktop sits over the library: keep the current
  // library scope highlighted in the sidebar.
  const navView = activeView === 'player' ? 'library' : activeView;
  document.querySelectorAll('[data-shell-nav]').forEach(link => {
    const nav = link.dataset.shellNav;
    const on = nav === navView && (nav !== 'library' || link.dataset.shellScope === scope);
    link.classList.toggle('is-on', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  syncCoachHint();
}

function syncActivityCount() {
  const source = document.getElementById('audio-activity-count');
  const trigger = document.getElementById('queue-status');
  const target = document.getElementById('app-sidebar-activity-count');
  if (!target) return;
  const count = trigger && !trigger.hidden ? (source?.textContent || '').trim() : '';
  target.textContent = count;
  const button = target.closest('button');
  button?.setAttribute('aria-label', count ? `Audio activity, ${count}` : 'Audio activity');
}

function onSidebarClick(event) {
  const link = event.target.closest('[data-shell-scope], [data-shell-action]');
  if (!link) return;
  const scope = link.dataset.shellScope;
  const action = link.dataset.shellAction;
  if (scope) {
    event.preventDefault();
    document.getElementById(`library-tab-${scope}`)?.click();
    if (activeView !== 'library') navigateTo('library');
    else syncNavigation('library');
    return;
  }
  if (action === 'audio-activity') {
    document.getElementById('queue-status')?.click();
    return;
  }
  if (action === 'upload') {
    event.preventDefault();
    openUploadSection();
  }
}

// Find › Upload a file: the sidebar, and the library's first-run state.
export function openUploadSection() {
  const focusUpload = () => {
    const target = document.querySelector('#search-view .upload-section');
    target?.scrollIntoView({ block: 'center' });
    (target?.querySelector('input[type="file"], button, [tabindex]') || target)?.focus?.({ preventScroll: true });
  };
  if (activeView === 'search') focusUpload();
  else {
    document.addEventListener('xandrio:viewchange', function once(e) {
      if (e.detail.view !== 'search') return;
      document.removeEventListener('xandrio:viewchange', once);
      requestAnimationFrame(focusUpload);
    });
    navigateTo('search');
  }
}

// ---- Recent sheet ----------------------------------------------------------

function recentRowHTML(entry, currentId, isPlaying) {
  const { book, position, progress } = entry;
  const id = String(book.id || '');
  const title = book.title || 'Untitled';
  // The open book is "Playing" only while audio actually plays; paused or
  // failed it is "Current".
  const current = Boolean(currentId) && String(currentId) === id;
  const playing = current && isPlaying;
  // Same resume-point label as the Continue strip (library.js).
  const chapter = entry.chapterLabel || '';
  const at = Number(position?.timestamp ?? position?.currentTime);
  const point = Number.isFinite(at) && at > 0 ? formatTime(at) : '';
  // The speed is stated only when this book's own speed differs from the one
  // the library already states.
  const left = progress.timeLeft != null
    ? timeLeftLabel(progress.timeLeft, progress.speed, { referenceSpeed: getReferencePlaybackSpeed() })
    : '';
  const sub = current
    ? [playing ? 'Playing' : 'Current', chapter, point].filter(Boolean).join(' \u00b7 ')
    : [chapter, point, left].filter(Boolean).join(' \u00b7 ');
  const label = playing
    ? `Now playing ${title}. ${sub}`
    : current
      ? `Open ${title}. ${sub}`
      : `Resume ${title}, ${sub}`;
  return `
    <li class="recent-row${current ? ' is-current' : ''}${playing ? ' is-playing' : ''}">
      <button class="recent-row-hit" type="button" data-recent-book="${safeAttr(id)}" aria-label="${safeAttr(label)}">
        ${coverImageHTML(book, 'recent-row-cover')}
        <span class="recent-row-text">
          <span class="recent-row-title">${escapeHTML(title)}</span>
          <span class="recent-row-sub num">${escapeHTML(sub)}</span>
        </span>
        <span class="recent-row-icon" aria-hidden="true">${playing
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>'}</span>
      </button>
    </li>`;
}

function renderRecent() {
  if (!recentList) return;
  const entries = deps.getRecentBooks?.(RECENT_LIMIT) || [];
  const currentId = deps.getCurrentBookId?.() || null;
  const isPlaying = Boolean(deps.isPlaying?.());
  recentList.innerHTML = entries.length
    ? entries.map(entry => recentRowHTML(entry, currentId, isPlaying)).join('')
    : '<li class="recent-empty">Books you start listening to appear here.</li>';
}

export function openRecentSheet() {
  if (!recentSheet) return;
  dismissCoachHint();
  recentSheet.open();
}

function initRecentSheet() {
  const sheetEl = document.getElementById('recent-sheet');
  recentList = document.getElementById('recent-sheet-list');
  if (!sheetEl) return;
  recentSheet = registerSheet(sheetEl, {
    backdrop: document.getElementById('recent-sheet-backdrop'),
    closeBtn: document.getElementById('recent-sheet-close'),
    onOpen: renderRecent,
    // Focus the title, not the close button: no ring on open.
    initialFocus: el => el.querySelector('#recent-sheet-title')
  });
  recentList?.addEventListener('click', event => {
    const row = event.target.closest('[data-recent-book]');
    if (!row) return;
    const bookId = row.dataset.recentBook;
    // Dismissal traverses history. Starting a new route before that traversal
    // completes lets Back overwrite it, especially for an already loaded book.
    const navigationReady = new Promise(resolve => {
      let timer;
      const finish = () => {
        window.removeEventListener('popstate', finish);
        clearTimeout(timer);
        resolve();
      };
      window.addEventListener('popstate', finish, { once: true });
      timer = setTimeout(finish, 350);
    });
    recentSheet.dismiss();
    void deps.resumeBook?.(bookId, { navigationReady });
  });
}

// ---- Chapter sheet ----------------------------------------------------------
// The chapter list (labels and all) is rendered by player-ui.js. This layer
// switches the sheet between Chapters and Bookmarks.

export function showChapterSheetTab(tab) {
  const sheet = document.getElementById('chapter-sheet');
  if (!sheet) return;
  const name = tab === 'bookmarks' ? 'bookmarks' : 'chapters';
  sheet.querySelectorAll('[data-chapter-sheet-tab]').forEach(button => {
    const on = button.dataset.chapterSheetTab === name;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
  });
  const list = document.getElementById('chapter-list');
  const bookmarks = document.getElementById('chapter-sheet-bookmarks');
  if (list) list.hidden = name !== 'chapters';
  if (bookmarks) bookmarks.hidden = name !== 'bookmarks';
  // The title names what the sheet shows.
  const title = document.getElementById('chapter-sheet-title');
  if (title) title.textContent = name === 'bookmarks' ? 'Bookmarks' : 'Chapters';
  sheet.dataset.tab = name;
}

function initChapterSheet() {
  const sheet = document.getElementById('chapter-sheet');
  const list = document.getElementById('chapter-list');
  if (!sheet || !list) return;
  if (typeof MutationObserver === 'function') {
    // Each time the sheet closes it returns to Chapters.
    new MutationObserver(() => {
      if (!sheet.classList.contains('active')) showChapterSheetTab('chapters');
      // player-ui.js focuses the first control (Done) on open; move focus to
      // the title so the sheet opens without a ring on a button.
      else if (!sheet.contains(document.activeElement) || document.activeElement.id === 'chapter-sheet-close') {
        document.getElementById('chapter-sheet-title')?.focus({ preventScroll: true });
      }
    }).observe(sheet, { attributes: true, attributeFilter: ['class'] });
  }
  const tabs = sheet.querySelector('.sheet-tabs');
  tabs?.addEventListener('click', event => {
    const button = event.target.closest('[data-chapter-sheet-tab]');
    if (button) showChapterSheetTab(button.dataset.chapterSheetTab);
  });
  tabs?.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = sheet.dataset.tab === 'bookmarks' ? 'chapters' : 'bookmarks';
    showChapterSheetTab(next);
    sheet.querySelector(`[data-chapter-sheet-tab="${next}"]`)?.focus();
  });
  showChapterSheetTab('chapters');
}

// ---- Mini player press-and-hold ---------------------------------------------

function initMiniPlayerHold() {
  const surface = document.getElementById('mini-player-tap');
  const openBtn = document.getElementById('mini-player-open');
  if (!surface) return;
  let timer = null;
  let start = null;
  let fired = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    start = null;
  };
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.mini-player-btn')) return;
    fired = false;
    start = { x: event.clientX, y: event.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      navigator.vibrate?.(10);
      openRecentSheet();
    }, LONG_PRESS_MS);
  });
  surface.addEventListener('pointermove', event => {
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => surface.addEventListener(type, cancel));
  // The click that ends a long press must not also open the player.
  document.addEventListener('click', event => {
    if (!fired || !surface.contains(event.target)) return;
    fired = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  surface.addEventListener('contextmenu', event => {
    if (event.target.closest('.mini-player-btn')) return;
    event.preventDefault();
    if (!fired) openRecentSheet();
  });
  openBtn?.addEventListener('keydown', event => {
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault();
      openRecentSheet();
    }
  });
}

// ---- Coach hint --------------------------------------------------------------

function coachDismissed() {
  return readText(COACH_KEY, '') === 'dismissed';
}

function dismissCoachHint() {
  if (!coachDismissed()) writeText(COACH_KEY, 'dismissed');
  if (coachHint) coachHint.hidden = true;
  document.body.classList.remove('has-coach-hint');
}

function syncCoachHint() {
  if (!coachHint) return;
  const mini = document.getElementById('mini-player');
  const miniShown = Boolean(mini && mini.style.display !== 'none');
  const show = !coachDismissed() && inProgressCount >= 2 && miniShown && activeView !== 'player';
  coachHint.hidden = !show;
  document.body.classList.toggle('has-coach-hint', show);
}

function initCoachHint() {
  coachHint = document.getElementById('shell-coach-hint');
  document.getElementById('shell-coach-dismiss')?.addEventListener('click', dismissCoachHint);
  document.addEventListener('xandrio:libraryloaded', event => {
    inProgressCount = Number(event.detail?.inProgressCount) || 0;
    syncCoachHint();
  });
  const mini = document.getElementById('mini-player');
  if (mini && typeof MutationObserver === 'function') {
    new MutationObserver(syncCoachHint).observe(mini, { attributes: true, attributeFilter: ['style'] });
  }
}

// ---- Init --------------------------------------------------------------------

export function initShell(options = {}) {
  deps = options;
  document.body.classList.add('has-shell');
  const tabbar = document.getElementById('app-tabbar');
  const sidebar = document.getElementById('app-sidebar');
  if (tabbar) tabbar.hidden = false;
  if (sidebar) sidebar.hidden = false;
  sidebar?.addEventListener('click', onSidebarClick);

  document.addEventListener('xandrio:viewchange', event => syncNavigation(event.detail?.view));
  // Library scope changes (tabs inside the library view) move the sidebar
  // highlight too.
  document.addEventListener('xandrio:libraryscope', () => syncNavigation(activeView));

  const count = document.getElementById('audio-activity-count');
  const trigger = document.getElementById('queue-status');
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(syncActivityCount);
    if (count) observer.observe(count, { childList: true, characterData: true, subtree: true });
    if (trigger) observer.observe(trigger, { attributes: true, attributeFilter: ['hidden'] });
  }
  syncActivityCount();

  initRecentSheet();
  initChapterSheet();
  initMiniPlayerHold();
  initCoachHint();
  syncNavigation(activeView);
}
