import { apiGet, apiSend } from '../api.js';
import { formatDuration, escapeHTML, safeAttr, relativeTime, coverImageHTML, cssEscape } from '../util/format.js';
import { readJSON, writeJSON, readText, writeText } from '../util/storage.js';
import { confirmSheet } from '../ui/confirm.js';
import { showToast, showUndoToast } from '../ui/toast.js';
import { onActivate } from '../ui/keys.js';

const ICON_GRID = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="icon"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/></svg>';
const ICON_LIST = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="icon"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg>';
const BOOK_META_PREFIX = 'xandrio_book_meta:';
const RAIL_DISMISSED_KEY = 'xandrio_rail_dismissed';
const RAIL_PLAY_GLYPH = `
  <svg viewBox="0 0 24 24" class="rail-play-icon" aria-hidden="true">
    <circle cx="12" cy="12" r="11" class="rail-play-bg"></circle>
    <path d="M9.5 7.5v9l7-4.5-7-4.5z" class="rail-play-tri"></path>
  </svg>
`;

const LIBRARY_TAB_KEY = 'xandrio_library_tab';

let deps = {};
let currentShelf = new Set();
let currentTab = 'shelf';
let librarySearch = null;
let sortSelect = null;
let viewToggleIcon = null;
let continueRail = null;
let currentViewMode = 'list';
let continueRailHasEntries = false;
let swipeListenersInstalled = false;

export function getCachedBookMeta(bookId) {
  return readJSON(BOOK_META_PREFIX + bookId, null);
}

export function cacheBookMeta(bookId, meta) {
  writeJSON(BOOK_META_PREFIX + bookId, meta);
}

export function bookProgressInfo(book, position) {
  if (!position || position.chapterIndex === undefined) return null;
  const info = {
    chapterIndex: position.chapterIndex,
    updatedAt: position.updatedAt || null,
    updatedAtMs: position.updatedAtMs || (position.updatedAt ? Date.parse(position.updatedAt) : 0),
    chapterCount: null,
    percent: null,
    timeLeft: null,
    finished: Boolean(position.finished),
  };
  const chapterCount = Number.isInteger(book.chapterCount) && book.chapterCount > 0
    ? book.chapterCount
    : getCachedBookMeta(book.id)?.chapterCount;
  if (Number.isInteger(chapterCount) && chapterCount > 0) {
    info.chapterCount = chapterCount;
    const durations = normalizedChapterDurations(book, chapterCount);
    if (durations) {
      const durationInfo = durationWeightedProgress(durations, position);
      info.percent = info.finished ? 100 : durationInfo.percent;
      info.timeLeft = info.finished ? 0 : durationInfo.timeLeft;
    } else {
      info.percent = info.finished ? 100 : Math.min(99, Math.round(100 * position.chapterIndex / chapterCount));
      if (book.totalDuration) {
        const rate = position.playbackRate || 1;
        info.timeLeft = info.finished ? 0 : Math.max(0, book.totalDuration * (1 - position.chapterIndex / chapterCount) / rate);
      }
    }
  }
  return info;
}

export function normalizedChapterDurations(book, chapterCount = book?.chapterCount) {
  const count = Number(chapterCount);
  if (!book || !Number.isInteger(count) || count <= 0 || !Array.isArray(book.chapterDurations)) return null;
  const durations = book.chapterDurations.slice(0, count).map(value => Number(value));
  if (durations.length !== count || !durations.every(value => Number.isFinite(value) && value > 0)) return null;
  return durations;
}

export function durationWeightedProgress(durations, position = {}) {
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return { percent: null, timeLeft: null };
  const chapterIndex = Math.max(0, Math.min(durations.length - 1, Number(position.chapterIndex) || 0));
  const elapsedBefore = durations.slice(0, chapterIndex).reduce((sum, value) => sum + value, 0);
  const chapterTime = Math.max(0, Math.min(durations[chapterIndex] || 0, Number(position.timestamp ?? position.currentTime ?? 0) || 0));
  const elapsed = Math.min(total, elapsedBefore + chapterTime);
  const rate = Number(position.playbackRate) > 0 ? Number(position.playbackRate) : 1;
  return {
    percent: Math.min(99, Math.max(0, Math.round((elapsed / total) * 100))),
    timeLeft: Math.max(0, (total - elapsed) / rate)
  };
}

function progressMetaLine(progress) {
  if (progress.finished) {
    return ['Finished', progress.updatedAt ? relativeTime(progress.updatedAt) : ''].filter(Boolean).join(' · ');
  }
  const parts = [];
  if (progress.timeLeft != null) parts.push(`${formatDuration(progress.timeLeft)} left`);
  else if (progress.chapterCount) parts.push(`Chapter ${progress.chapterIndex + 1} of ${progress.chapterCount}`);
  else parts.push(`Chapter ${progress.chapterIndex + 1}`);
  if (progress.updatedAt) parts.push(relativeTime(progress.updatedAt));
  return parts.join(' · ');
}

function shelfToggleHTML(id, title, onShelf) {
  return `
    <button class="shelf-toggle${onShelf ? ' on-shelf' : ''}" data-shelf-toggle="${safeAttr(id)}"
            aria-label="${onShelf ? `Remove ${safeAttr(title)} from my shelf` : `Add ${safeAttr(title)} to my shelf`}">
      ${onShelf ? '✓ On shelf' : '+ Shelf'}
    </button>`;
}

function renderBookCard(book, position, onShelf = false) {
  const progress = bookProgressInfo(book, position);
  const id = String(book.id || '');
  const title = book.title || 'Untitled';
  const author = book.author || 'Unknown Author';
  const metaLine = progress
    ? `<span class="progress-meta">${escapeHTML(progressMetaLine(progress))}</span>`
    : (book.totalDuration ? `<span class="duration-badge">${formatDuration(book.totalDuration)}</span>` : '');
  const finishedBadge = progress?.finished ? '<span class="book-finished-badge">Finished</span>' : '';
  const progressBar = progress && progress.percent != null ? `
        <div class="book-progress" role="progressbar" aria-valuenow="${progress.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${progress.percent}% listened">
          <div class="book-progress-fill" style="width:${progress.percent}%"></div>
        </div>` : '';

  return `
    <div class="book-item${progress?.finished ? ' finished' : ''}"
         data-book-id="${safeAttr(id)}"
         data-on-shelf="${onShelf ? '1' : '0'}"
         data-added="${safeAttr(book.addedAt || '')}"
         data-last-read="${safeAttr(position?.updatedAt || book.addedAt || '')}"
         data-finished="${progress?.finished ? '1' : '0'}"
         tabindex="0"
         role="button"
         aria-label="Open ${safeAttr(title)} by ${safeAttr(author)}">
      <div class="book-item-inner">
        <div class="book-cover-wrap">
          ${coverImageHTML(book, 'book-item-cover', `Cover of ${title}`)}
        </div>
        <div class="book-item-info">
          <h3>${escapeHTML(title)}</h3>
          <p>${escapeHTML(author)}</p>
          ${metaLine}
          ${finishedBadge}
          ${shelfToggleHTML(id, title, onShelf)}
        </div>
        ${progressBar}
      </div>
      <button class="delete-btn-reveal" data-delete-book-id="${safeAttr(id)}" data-delete-book-title="${safeAttr(title)}" data-delete-book-author="${safeAttr(author)}" aria-label="Delete ${safeAttr(title)}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="delete-icon"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
      </button>
      <button class="delete-btn-desktop" data-delete-book-id="${safeAttr(id)}" data-delete-book-title="${safeAttr(title)}" data-delete-book-author="${safeAttr(author)}" aria-label="Delete ${safeAttr(title)}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
      </button>
    </div>
  `;
}

function skeletonCardsHTML(n) {
  return Array.from({ length: n }, () => `
    <div class="book-item skeleton" aria-hidden="true">
      <div class="book-item-inner">
        <div class="book-cover-wrap sk-block"></div>
        <div class="book-item-info">
          <div class="sk-line w-70"></div>
          <div class="sk-line w-45"></div>
          <div class="sk-line w-30"></div>
        </div>
      </div>
    </div>
  `).join('');
}

function getRailDismissals() {
  return readJSON(RAIL_DISMISSED_KEY, {});
}

function dismissRailEntry(bookId, updatedAtMs) {
  const dismissals = getRailDismissals();
  dismissals[bookId] = updatedAtMs || Date.now();
  writeJSON(RAIL_DISMISSED_KEY, dismissals);
}

function isRailDismissed(bookId, updatedAtMs) {
  const dismissedAt = getRailDismissals()[bookId];
  return Boolean(dismissedAt) && dismissedAt >= (updatedAtMs || 0);
}

function railCardHTML(entry) {
  const { book, progress } = entry;
  const id = String(book.id || '');
  const title = book.title || 'Untitled';
  const metaLine = progressMetaLine(progress);
  const progressBar = progress.percent != null
    ? `<div class="rail-progress"><div class="rail-progress-fill" style="width:${progress.percent}%"></div></div>`
    : '';

  return `
    <div class="rail-card" data-book-id="${safeAttr(id)}" data-updated-ms="${safeAttr(progress.updatedAtMs || 0)}" role="button" tabindex="0" aria-label="Resume ${safeAttr(title)}">
      <div class="rail-cover-wrap">
        ${coverImageHTML(book, 'rail-cover')}
        <button class="rail-dismiss" aria-label="Remove ${safeAttr(title)} from Continue Listening" title="Remove from Continue Listening">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" aria-hidden="true"><path stroke-linecap="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <span class="rail-play-glyph">${RAIL_PLAY_GLYPH}</span>
        ${progressBar}
      </div>
      <p class="rail-title">${escapeHTML(title)}</p>
      <p class="rail-meta">${escapeHTML(metaLine)}</p>
    </div>
  `;
}

function renderContinueRail(entries) {
  if (!continueRail) return;
  continueRailHasEntries = entries.length > 0;
  if (!continueRailHasEntries) {
    continueRail.hidden = true;
    continueRail.innerHTML = '';
    return;
  }
  continueRail.innerHTML = `
    <h2 class="rail-heading">Continue Listening</h2>
    <div class="rail-track">${entries.map(entry => railCardHTML(entry)).join('')}</div>
  `;
  continueRail.hidden = false;
}

export async function loadLibrary() {
  const libraryList = document.getElementById('library-list');
  const hasRenderedBooks = !!libraryList?.querySelector('.book-item:not(.skeleton)');
  if (libraryList && !hasRenderedBooks) libraryList.innerHTML = skeletonCardsHTML(6);

  let data, positions;
  try {
    const [libraryData, posData] = await Promise.all([
      apiGet('/api/library'),
      apiGet('/api/positions').catch(() => ({}))
    ]);
    data = libraryData;
    positions = posData.positions || {};
  } catch (err) {
    console.error('Failed to load library:', err);
    if (libraryList) {
      renderContinueRail([]);
      libraryList.innerHTML = `
        <div class="empty-state-modern">
          <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg></div>
          <h3>Couldn't load your library</h3>
          <p>Check your connection and try again</p>
          <button class="btn-primary" data-retry-library>Retry</button>
        </div>
      `;
      libraryList.querySelector('[data-retry-library]')?.addEventListener('click', () => loadLibrary());
    }
    return;
  }

  if (data.books.length === 0) {
    renderContinueRail([]);
    libraryList.innerHTML = `
      <div class="empty-state-modern">
        <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/></svg></div>
        <h3>Your library is empty</h3>
        <p>Add your first audiobook to get started</p>
        <button class="btn-primary" data-add-book-empty>+ Add Book</button>
      </div>
    `;
    return;
  }

  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch-device');
  currentShelf = new Set(Array.isArray(data.shelf) ? data.shelf : []);
  // Default to "My shelf" per stored preference, but never open on an empty
  // shelf — fall back to the shared pool.
  const storedTab = readText(LIBRARY_TAB_KEY, 'shelf');
  currentTab = (storedTab === 'shelf' && currentShelf.size === 0) ? 'all' : storedTab;
  syncLibraryTabs();
  libraryList.innerHTML = data.books.map(book => renderBookCard(book, positions[book.id] || null, currentShelf.has(book.id))).join('');
  const continueEntries = data.books
    .map(book => ({ book, progress: bookProgressInfo(book, positions[book.id]) }))
    .filter(entry => entry.progress && !entry.progress.finished)
    .filter(entry => !isRailDismissed(entry.book.id, entry.progress.updatedAtMs))
    .sort((a, b) => (b.progress.updatedAtMs || 0) - (a.progress.updatedAtMs || 0))
    .slice(0, 3);
  renderContinueRail(continueEntries);
  if (continueRail && librarySearch?.value.trim()) continueRail.hidden = true;
  sortLibrary();
  filterLibrary();
  setupSwipeDelete();
}

function syncLibraryTabs() {
  document.querySelectorAll('[data-library-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.libraryTab === currentTab);
  });
}

// A card is visible when it matches the search query AND the active tab
// ("My shelf" vs "All books"). Both paths funnel through here so the two
// filters can't fight over the hidden class.
function filterLibrary() {
  const query = librarySearch?.value.toLowerCase().trim() || '';
  let visibleCount = 0;
  document.querySelectorAll('.book-item:not(.skeleton)').forEach(item => {
    const title = item.querySelector('h3')?.textContent.toLowerCase() || '';
    const author = item.querySelector('p')?.textContent.toLowerCase() || '';
    const matchesQuery = !query || title.includes(query) || author.includes(query);
    const matchesTab = currentTab === 'all' || item.dataset.onShelf === '1';
    const visible = matchesQuery && matchesTab;
    item.classList.toggle('hidden', !visible);
    if (visible) visibleCount++;
  });
  if (continueRail) continueRail.hidden = query.length > 0 || !continueRailHasEntries;
  const emptyShelfHint = document.getElementById('shelf-empty-hint');
  if (emptyShelfHint) emptyShelfHint.hidden = !(currentTab === 'shelf' && visibleCount === 0 && !query);
}

function setLibraryTab(tab) {
  currentTab = tab === 'all' ? 'all' : 'shelf';
  writeText(LIBRARY_TAB_KEY, currentTab);
  syncLibraryTabs();
  filterLibrary();
}

async function toggleShelfMembership(bookId, button) {
  const onShelf = currentShelf.has(bookId);
  button.disabled = true;
  try {
    if (onShelf) {
      await apiSend('DELETE', `/api/shelf/${encodeURIComponent(bookId)}`);
      currentShelf.delete(bookId);
    } else {
      await apiSend('POST', `/api/shelf/${encodeURIComponent(bookId)}`);
      currentShelf.add(bookId);
    }
    const card = button.closest('.book-item');
    if (card) card.dataset.onShelf = currentShelf.has(bookId) ? '1' : '0';
    button.classList.toggle('on-shelf', currentShelf.has(bookId));
    button.textContent = currentShelf.has(bookId) ? '✓ On shelf' : '+ Shelf';
    filterLibrary();
  } catch (err) {
    console.error('Shelf update failed:', err);
    showToast('Could not update your shelf', 'error');
  } finally {
    button.disabled = false;
  }
}

function sortLibrary() {
  const sortBy = sortSelect.value;
  const libraryList = document.getElementById('library-list');
  libraryList.querySelectorAll('.library-divider').forEach(el => el.remove());
  const bookItems = Array.from(libraryList.querySelectorAll('.book-item'));
  bookItems.sort((a, b) => {
    const aTitle = a.querySelector('h3')?.textContent || '';
    const aAuthor = a.querySelector('p')?.textContent || '';
    const aDate = a.dataset.added || '0';
    const bTitle = b.querySelector('h3')?.textContent || '';
    const bAuthor = b.querySelector('p')?.textContent || '';
    const bDate = b.dataset.added || '0';
    switch(sortBy) {
      case 'last-read':
        return new Date(b.dataset.lastRead || b.dataset.added || '0') - new Date(a.dataset.lastRead || a.dataset.added || '0');
      case 'recent': return new Date(bDate) - new Date(aDate);
      case 'title-az': return aTitle.localeCompare(bTitle);
      case 'title-za': return bTitle.localeCompare(aTitle);
      case 'author-az': return aAuthor.localeCompare(bAuthor);
      case 'author-za': return bAuthor.localeCompare(aAuthor);
      default: return 0;
    }
  });
  if (sortBy === 'last-read') {
    const unfinished = bookItems.filter(item => item.dataset.finished !== '1');
    const finished = bookItems.filter(item => item.dataset.finished === '1');
    unfinished.forEach(item => libraryList.appendChild(item));
    if (finished.length) {
      const divider = document.createElement('div');
      divider.className = 'library-divider';
      divider.textContent = 'Finished';
      libraryList.appendChild(divider);
      finished.forEach(item => libraryList.appendChild(item));
    }
  } else {
    bookItems.forEach(item => libraryList.appendChild(item));
  }
}

function toggleView() {
  const libraryList = document.getElementById('library-list');
  if (currentViewMode === 'list') {
    currentViewMode = 'grid';
    libraryList.classList.add('grid-view');
    viewToggleIcon.innerHTML = ICON_LIST;
  } else {
    currentViewMode = 'list';
    libraryList.classList.remove('grid-view');
    viewToggleIcon.innerHTML = ICON_GRID;
  }
}

async function openBookFromLibrary(bookId) {
  const escapedId = cssEscape(bookId);
  const card = document.querySelector(`.book-item[data-book-id="${escapedId}"]`);
  let loadingTimer = null;
  if (card) loadingTimer = setTimeout(() => card.classList.add('loading'), 300);
  try {
    await deps.openBook(bookId);
  } catch (err) {
    console.error('Error opening book:', err);
  } finally {
    if (loadingTimer) clearTimeout(loadingTimer);
    card?.classList.remove('loading');
  }
}

async function showDeleteModal(bookId, title) {
  const ok = await confirmSheet({
    title: 'Delete book',
    message: `Delete "${title}"? This cannot be undone.`,
    confirmLabel: 'Delete'
  });
  if (ok) deleteBook(bookId);
}

async function deleteBook(id) {
  try {
    const data = await apiSend('DELETE', `/api/book/${encodeURIComponent(id)}`);
    if (data.success) {
      const escapedId = cssEscape(id);
      const bookElement = document.querySelector(`[data-book-id="${escapedId}"]`);
      if (bookElement) {
        bookElement.style.transition = 'all 300ms ease';
        bookElement.style.opacity = '0';
        bookElement.style.transform = 'translateX(-100%)';
        setTimeout(() => {
          bookElement.remove();
          if (document.querySelectorAll('.book-item').length === 0) loadLibrary();
        }, 300);
      }
      showToast('Book deleted');
    } else {
      showToast('Failed to delete book', 'error');
    }
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Error deleting book', 'error');
  }
}

function setupSwipeDelete() {
  if (swipeListenersInstalled) return;
  swipeListenersInstalled = true;
  let startX = 0;
  let startY = 0;
  let currentItem = null;
  let currentInner = null;
  let swiping = false;
  let openItem = null;
  const THRESHOLD = 50;
  const REVEAL_WIDTH = 70;
  function closeOpen(animate) {
    if (!openItem) return;
    const inner = openItem.querySelector('.book-item-inner');
    if (inner) {
      if (animate) inner.style.transition = 'transform 200ms ease';
      inner.style.transform = '';
      if (animate) setTimeout(() => { inner.style.transition = ''; }, 200);
    }
    openItem.classList.remove('swiping');
    openItem = null;
  }
  document.addEventListener('pointerdown', (e) => {
    const bookItem = e.target.closest('.book-item');
    if (openItem && bookItem !== openItem && !e.target.closest('.delete-btn-reveal')) closeOpen(true);
    if (!bookItem || e.target.closest('.delete-btn-reveal')) return;
    startX = e.clientX;
    startY = e.clientY;
    currentItem = bookItem;
    currentInner = bookItem.querySelector('.book-item-inner');
    swiping = false;
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (!currentItem || !currentInner) return;
    const dx = startX - e.clientX;
    const dy = e.clientY - startY;
    if (!swiping && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      currentItem = null;
      currentInner = null;
      return;
    }
    if (dx > 10) {
      swiping = true;
      currentItem.classList.add('swiping');
      e.preventDefault();
      currentInner.style.transform = `translateX(-${Math.min(dx, REVEAL_WIDTH)}px)`;
      currentInner.style.transition = 'none';
    }
  });
  document.addEventListener('pointerup', (e) => {
    if (!currentItem || !currentInner) return;
    const dx = startX - e.clientX;
    if (swiping && dx > THRESHOLD) {
      if (openItem && openItem !== currentItem) closeOpen(true);
      currentInner.style.transition = 'transform 200ms ease';
      currentInner.style.transform = `translateX(-${REVEAL_WIDTH}px)`;
      openItem = currentItem;
      setTimeout(() => { if (currentInner) currentInner.style.transition = ''; }, 200);
    } else if (swiping) {
      currentItem.classList.remove('swiping');
      currentInner.style.transition = 'transform 200ms ease';
      currentInner.style.transform = '';
      setTimeout(() => { if (currentInner) currentInner.style.transition = ''; }, 200);
    }
    if (swiping && currentInner) {
      currentInner.style.pointerEvents = 'none';
      const ref = currentInner;
      setTimeout(() => { ref.style.pointerEvents = ''; }, 50);
    }
    currentItem = null;
    currentInner = null;
    swiping = false;
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('.delete-btn-reveal') && openItem) setTimeout(() => closeOpen(true), 100);
  });
}

export function initLibrary(options = {}) {
  deps = options;
  librarySearch = document.getElementById('library-search');
  sortSelect = document.getElementById('sort-select');
  viewToggleIcon = document.getElementById('view-toggle-icon');
  continueRail = document.getElementById('continue-rail');

  document.getElementById('library-search-toggle')?.addEventListener('click', () => {
    document.getElementById('library-search-bar')?.classList.remove('collapsed');
    librarySearch?.focus();
  });
  document.getElementById('library-search-close')?.addEventListener('click', () => {
    librarySearch.value = '';
    filterLibrary();
    document.getElementById('library-search-bar')?.classList.add('collapsed');
  });
  librarySearch?.addEventListener('input', filterLibrary);
  sortSelect?.addEventListener('change', sortLibrary);
  document.getElementById('library-tabs')?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-library-tab]');
    if (tabBtn) setLibraryTab(tabBtn.dataset.libraryTab);
  });
  document.getElementById('view-toggle-btn')?.addEventListener('click', toggleView);

  const libraryList = document.getElementById('library-list');
  libraryList?.addEventListener('click', (e) => {
    const emptyAddBtn = e.target.closest('[data-add-book-empty]');
    if (emptyAddBtn) {
      e.preventDefault();
      document.getElementById('add-book-btn')?.click();
      return;
    }
    const deleteBtn = e.target.closest('[data-delete-book-id]');
    if (deleteBtn) {
      e.stopPropagation();
      showDeleteModal(deleteBtn.dataset.deleteBookId, deleteBtn.dataset.deleteBookTitle, deleteBtn.dataset.deleteBookAuthor);
      return;
    }
    const shelfBtn = e.target.closest('[data-shelf-toggle]');
    if (shelfBtn) {
      e.stopPropagation();
      toggleShelfMembership(shelfBtn.dataset.shelfToggle, shelfBtn);
      return;
    }
    const bookItem = e.target.closest('.book-item');
    if (bookItem) openBookFromLibrary(bookItem.dataset.bookId);
  });
  onActivate(libraryList, (e) => {
    const bookItem = e.target.closest('.book-item');
    if (!bookItem) return;
    openBookFromLibrary(bookItem.dataset.bookId);
  });
  continueRail?.addEventListener('click', (e) => {
    const dismiss = e.target.closest('.rail-dismiss');
    const card = e.target.closest('.rail-card');
    if (!card) return;
    if (dismiss) {
      e.stopPropagation();
      dismissRailEntryWithUndo(card);
      return;
    }
    openBookFromLibrary(card.dataset.bookId);
  });
}

// Remove a Continue-Listening card from the UI immediately, but defer the
// persisted dismissal (localStorage) ~5s so Undo can restore the exact card.
function dismissRailEntryWithUndo(card) {
  const bookId = card.dataset.bookId;
  const updatedMs = Number(card.dataset.updatedMs) || Date.now();
  const track = card.parentElement;
  const nextSibling = card.nextElementSibling;

  card.remove();
  if (continueRail && !continueRail.querySelector('.rail-card')) {
    continueRailHasEntries = false;
    continueRail.hidden = true;
  }

  showUndoToast('Removed from Continue Listening', {
    onUndo: () => {
      if (!track) return;
      if (nextSibling && nextSibling.parentElement === track) track.insertBefore(card, nextSibling);
      else track.appendChild(card);
      continueRailHasEntries = true;
      if (continueRail) continueRail.hidden = false;
    },
    onCommit: () => dismissRailEntry(bookId, updatedMs)
  });
}
