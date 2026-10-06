import { apiGet, apiSend, getCurrentUser } from '../api.js';
import { escapeHTML, safeAttr, relativeTime, coverImageHTML, cssEscape, formatTime } from '../util/format.js';
import { bookTimeLeft, chapterDurationsFor, effectiveSpeed, formatDuration, formatSpeed } from '../util/time-left.mjs';
import { deviceState, narrationState, primaryState, statusLineVariants, gridTimeVariants } from '../util/library-status.mjs';
import { chapterPositionLabel } from '../util/chapter-labels.mjs';
import { effectiveSpeedForBook, getReferencePlaybackSpeed } from './playback-speed.js';
import { readJSON, writeJSON, readText, writeText } from '../util/storage.js';
import { getClientSettings } from '../client-settings.js';
import { confirmSheet } from '../ui/confirm.js';
import { registerSheet } from '../ui/sheets.js';
import { showToast, showUndoToast } from '../ui/toast.js';
import { shareBook } from '../features/sharing.js';
import {
  cancelOfflineDownload,
  cancelOfflinePreparation,
  downloadBookForOffline,
  enableOfflineReadyNotifications,
  getVerifiedOfflineLibraryBooks,
  offlineDownloadsSupported,
  offlineStatusForBook,
  prepareAndDownloadBookForOffline,
  removeOfflineBook
} from '../features/offline.js';

// ---- Glyphs (stroked SVG; DESIGN.md rules out emoji icons) -----------------
const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
const GLYPH = {
  download: svg('<circle cx="12" cy="12" r="9.2"/><path d="M12 7.5v8.5m0 0-3.6-3.6M12 16l3.6-3.6"/>'),
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.6 12.3 3 3 5.8-6.2" fill="none" stroke="var(--offline-check-mark, #0B0B0D)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  retry: svg('<path d="M19.5 8.5A8 8 0 0 0 5 9"/><path d="M19.8 4.5v4.3h-4.3"/><path d="M4.5 15.5A8 8 0 0 0 19 15"/><path d="M4.2 19.5v-4.3h4.3"/>'),
  warn: svg('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17h.01"/>', ' class="status-warn"'),
  chevron: svg('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>', ' class="scope-chevron"'),
  check1: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  queue: svg('<path d="M4 6.5h13M4 11.5h13M4 16.5h7"/><path d="m15 14.5 5 3-5 3z" fill="currentColor"/>'),
  shelf: svg('<path d="M4 6.5h13M4 11.5h9M4 16.5h7"/><path d="M18.5 20.5s-3.5-2.1-3.5-4.4a1.8 1.8 0 0 1 3.5-.6 1.8 1.8 0 0 1 3.5.6c0 2.3-3.5 4.4-3.5 4.4z" fill="currentColor" stroke="none"/>'),
  share: svg('<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>'),
  hide: svg('<path d="M4 12h16"/><circle cx="12" cy="12" r="9"/>'),
  trash: svg('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10 10.5v6M14 10.5v6"/>'),
  remove: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 12h7"/>'),
  cancel: svg('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>'),
  bookshelf: svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H9v16H5.5A1.5 1.5 0 0 1 4 18.5zM9 4h4.5v16H9z"/><path d="M14.2 5.2l3.9-1 3.6 14.6-3.9 1z"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  upload: svg('<path d="M12 16V4M6.5 9.5 12 4l5.5 5.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>')
};
const DELETE_GLYPH = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="delete-icon"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>';

const BOOK_META_PREFIX = 'xandrio_book_meta:';
const RAIL_DISMISSED_KEY = 'xandrio_rail_dismissed';
const LIBRARY_TAB_KEY = 'xandrio_library_tab';
const VIEW_MODE_KEY = 'xandrio_library_view';
const CONTINUE_LIMIT = 5;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
const SCOPES = ['shelf', 'downloaded', 'all'];
const SCOPE_LABELS = { shelf: 'My Shelf', downloaded: 'Downloaded', all: 'Shared Library' };
const DESKTOP_QUERY = '(min-width: 760px)';

let deps = {};
let currentShelf = new Set();
let currentTab = 'shelf';
let librarySearch = null;
let sortSelect = null;
let continueRail = null;
let currentViewMode = 'list';
let continueRailHasEntries = false;
let swipeListenersInstalled = false;
let libraryLoadGeneration = 0;
let libraryContentState = 'loading';
let librarySnapshot = { books: [], positions: {} };
let booksById = new Map();
let audioActivity = new Map();
let audioActivityKey = '';
let fitFrame = 0;
let bookActionsSheet = null;
let bookActionsBookId = null;
const pendingBookDownloads = new Set();

function libraryTabStorageKey() {
  const accountId = getCurrentUser()?.id;
  return accountId ? `${LIBRARY_TAB_KEY}:${accountId}` : LIBRARY_TAB_KEY;
}

function isDesktop() {
  return typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;
}

export function getCachedBookMeta(bookId) {
  return readJSON(BOOK_META_PREFIX + bookId, null);
}

export function cacheBookMeta(bookId, meta) {
  writeJSON(BOOK_META_PREFIX + bookId, meta);
}

// Use the player's semantic structure. A raw section index is not a chapter
// number: front matter and part dividers do not count as chapters.
export function resumeChapterLabel(bookId, chapterIndex, { withTotal = false } = {}) {
  const meta = getCachedBookMeta(bookId);
  const book = booksById.get(String(bookId));
  if (book?.chapterStructureKey && meta?.chapterStructureKey !== book.chapterStructureKey) return '';
  if (!meta?.chapterStructureKey) return '';
  const chapters = meta?.chapterStructure;
  const index = Number(chapterIndex);
  if (!Array.isArray(chapters) || !Number.isInteger(index) || index < 0 || index >= chapters.length) return '';
  return chapterPositionLabel(chapters, index, { short: true, withTotal });
}

async function loadResumeChapterStructures(books, positions, generation) {
  const pending = books.filter(book => positions[book.id]?.chapterIndex !== undefined && !positions[book.id]?.finished)
    .sort((a, b) => (Date.parse(positions[b.id]?.updatedAt) || 0) - (Date.parse(positions[a.id]?.updatedAt) || 0))
    .filter(book => {
      const meta = getCachedBookMeta(book.id);
      return !book.chapterStructureKey || meta?.chapterStructureKey !== book.chapterStructureKey || !Array.isArray(meta?.chapterStructure);
    });
  // Render the usable shelf first. Fill missing labels in sequential bounded
  // batches, so a large shelf has neither one request per book nor a hard cutoff.
  for (let start = 0; start < pending.length; start += 50) {
    if (generation !== libraryLoadGeneration) return;
    const batch = pending.slice(start, start + 50);
    const previousKeys = new Map(batch.map(book => [String(book.id), getCachedBookMeta(book.id)?.chapterStructureKey]));
    try {
      const ids = batch.map(book => encodeURIComponent(book.id));
      const data = await apiGet(`/api/library/chapter-labels?bookIds=${ids.join(',')}`);
      if (generation !== libraryLoadGeneration) return;
      for (const book of batch) {
        const id = String(book.id);
        const summary = data?.summaries?.[id];
        if (!summary?.structureKey || !Array.isArray(summary.chapters)) continue;
        if (book.chapterStructureKey && summary.structureKey !== book.chapterStructureKey) continue;
        const meta = getCachedBookMeta(id);
        // Opening/rebuilding a book while this read was pending owns newer
        // metadata. A late library summary cannot replace that structure.
        if (meta?.chapterStructureKey !== previousKeys.get(id) && meta?.chapterStructureKey !== summary.structureKey) continue;
        cacheBookMeta(id, {
          ...(meta || {}),
          chapterStructure: summary.chapters,
          chapterStructureKey: summary.structureKey
        });
      }
      refreshLibraryPlayback();
    } catch {
      // The shelf stays usable when structure is unavailable. Omit the number.
      return;
    }
  }
}

// Library-facing progress for one book. Time left comes from the shared
// time-left module at the book's effective speed (see effectiveSpeedForBook),
// so library rows, the Continue strip and the player always agree.
export function bookProgressInfo(book, position, speed = null) {
  if (!position || position.chapterIndex === undefined) return null;
  const info = {
    chapterIndex: position.chapterIndex,
    updatedAt: position.updatedAt || null,
    updatedAtMs: position.updatedAtMs || (position.updatedAt ? Date.parse(position.updatedAt) : 0),
    chapterCount: null,
    percent: null,
    timeLeft: null,
    speed: null,
    finished: Boolean(position.finished),
  };
  const chapterCount = Number.isInteger(book.chapterCount) && book.chapterCount > 0
    ? book.chapterCount
    : getCachedBookMeta(book.id)?.chapterCount;
  if (Number.isInteger(chapterCount) && chapterCount > 0) {
    info.chapterCount = chapterCount;
    const rate = speed ?? effectiveSpeedForBook(book.id);
    const timing = bookTimeLeft(book, position, rate, chapterCount);
    info.speed = effectiveSpeed(rate);
    if (timing) {
      info.percent = info.finished ? 100 : timing.percent;
      info.timeLeft = info.finished ? 0 : timing.timeLeft;
    } else {
      info.percent = info.finished ? 100 : Math.min(99, Math.round(100 * position.chapterIndex / chapterCount));
    }
  }
  return info;
}

// The live position of the open book, so the Continue strip and the rows
// describe where the listener actually is rather than the last server save.
function livePositionFor(bookId) {
  const live = deps.getCurrentPlayback?.();
  if (!live || String(live.bookId) !== String(bookId)) return null;
  return live;
}

function positionFor(bookId) {
  const saved = librarySnapshot.positions[bookId] || null;
  const live = livePositionFor(bookId);
  if (!live || !Number.isInteger(live.chapterIndex)) return saved;
  return {
    ...(saved || {}),
    chapterIndex: live.chapterIndex,
    timestamp: Number.isFinite(live.timestamp) ? live.timestamp : saved?.timestamp,
    updatedAtMs: Math.max(saved?.updatedAtMs || 0, Date.now()),
    updatedAt: saved?.updatedAt || new Date().toISOString(),
    finished: false
  };
}

function inProgressEntries() {
  return librarySnapshot.books
    .map(book => ({ book, position: positionFor(book.id) }))
    .map(entry => ({ ...entry, progress: bookProgressInfo(entry.book, entry.position) }))
    .filter(entry => entry.progress && !entry.progress.finished)
    .sort((a, b) => (b.progress.updatedAtMs || 0) - (a.progress.updatedAtMs || 0));
}

// Books in progress, most recently played first, from the last library
// load. Feeds the Recent sheet (one tap resumes) and the coach hint.
export function getRecentInProgress(limit = 5) {
  return inProgressEntries()
    .slice(0, limit)
    .map(entry => ({ ...entry, chapterLabel: resumeChapterLabel(entry.book.id, entry.progress.chapterIndex) }));
}

export function normalizedChapterDurations(book, chapterCount = book?.chapterCount) {
  return chapterDurationsFor(book, chapterCount);
}

export function durationWeightedProgress(durations, position = {}) {
  const timing = bookTimeLeft(
    { chapterDurations: durations, chapterCount: durations.length },
    { chapterIndex: 0, ...position },
    position.playbackRate
  );
  if (!timing) return { percent: null, timeLeft: null };
  return { percent: timing.percent, timeLeft: timing.timeLeft };
}

// Strictly: is this book fully on this device and proven playable from it?
//
// Partial, in-progress and still-verifying downloads previously answered yes,
// so they were filed under Downloaded and marked as on-device. Opening one and
// finding it would not play is the failure this guards against. Those states
// keep their own descriptive labels — they simply stop claiming to be
// something the user can rely on offline.
function isAvailableOnDevice(status) {
  return Boolean(status.downloaded);
}

// ---- Row model -------------------------------------------------------------

// Everything a row, cell, table row or actions header says about one book,
// in the one vocabulary (library-status.mjs + time-left.mjs).
function bookModel(book) {
  const id = String(book.id || '');
  const position = positionFor(id);
  const progress = bookProgressInfo(book, position);
  const speed = effectiveSpeedForBook(id);
  const referenceSpeed = getReferencePlaybackSpeed();
  const status = offlineStatusForBook(id);
  const device = deviceState(status, { pending: pendingBookDownloads.has(id) });
  const narration = narrationState(book, audioActivity.get(id) || null, speed);
  let timeLeft = progress?.timeLeft ?? null;
  if (timeLeft === null && !progress) {
    // Not started: the whole book is left.
    const whole = bookTimeLeft(book, { chapterIndex: 0, timestamp: 0 }, speed);
    timeLeft = whole?.timeLeft ?? null;
  }
  const fallbackTime = book.totalDuration ? formatDuration(Number(book.totalDuration) / speed) : '';
  let context = null;
  if (progress?.finished) {
    const when = progress.updatedAt ? relativeTime(progress.updatedAt) : '';
    context = when ? { long: when, short: when, warn: false } : null;
  } else if (progress) {
    const when = progress.updatedAt ? relativeTime(progress.updatedAt) : '';
    context = when ? { long: `Played ${when}`, short: when, warn: false } : null;
  } else {
    context = { long: 'Not played yet', short: 'New', warn: false };
  }
  const current = Boolean(livePositionFor(id));
  return {
    id, book, position, progress, speed, referenceSpeed, status, device, narration, context,
    chapterLabel: progress && !progress.finished ? resumeChapterLabel(id, progress.chapterIndex, { withTotal: true }) : '',
    timeLeft, fallbackTime, current,
    downloaded: isAvailableOnDevice(status),
    primary: primaryState({ device, narration, context })
  };
}

function stateHTML(word, warn) {
  return `${escapeHTML(word)}${warn ? GLYPH.warn : ''}`;
}

function statusVariantHTML(variant) {
  const time = variant.time ? `<span class="status-time">${escapeHTML(variant.time)}</span>` : '';
  const state = variant.state
    ? `<span class="status-state">${variant.time ? '<span class="status-sep" aria-hidden="true"> · </span>' : ''}${stateHTML(variant.state, variant.warn)}</span>`
    : '';
  return time + state;
}

function fitAttr(variants) {
  return safeAttr(JSON.stringify(variants));
}

function statusLineHTML(model) {
  const variants = statusLineVariants({
    timeLeft: model.timeLeft,
    speed: model.speed,
    referenceSpeed: model.referenceSpeed,
    fallbackTime: model.fallbackTime,
    stateWord: model.primary
  }).map(statusVariantHTML);
  return `<span class="book-status num" data-fit="${fitAttr(variants)}">${variants[0]}</span>`;
}

function gridLinesHTML(model) {
  const times = gridTimeVariants({
    timeLeft: model.timeLeft,
    speed: model.speed,
    referenceSpeed: model.referenceSpeed,
    fallbackTime: model.fallbackTime
  }).map(text => `<span class="status-time">${escapeHTML(text)}</span>`);
  const word = model.primary;
  const states = word
    ? [...new Set([word.long, word.short])].map(text => `<span class="status-state">${stateHTML(text, word.warn)}</span>`)
    : [''];
  return `
    <span class="book-grid-line num" data-fit="${fitAttr(times)}">${times[0]}</span>
    <span class="book-grid-line" data-fit="${fitAttr(states)}">${states[0]}</span>`;
}

// Desktop table columns: "9h 12m at 1.25×" (the table has room to state
// every row's speed) and the narration state in words.
function tableColumnsHTML(model) {
  let time = model.fallbackTime || '—';
  if (model.timeLeft === 0) time = 'Finished';
  else if (model.timeLeft !== null) time = formatDuration(model.timeLeft);
  const speed = model.timeLeft ? `<span class="book-col-muted"> at ${escapeHTML(formatSpeed(model.speed))}</span>` : '';
  const word = model.narration || (model.device.kind === 'prepared' ? model.device : null) || model.context;
  const status = word ? stateHTML(word.long, word.warn) : '—';
  return `
    <span class="book-col book-col-time num" data-open-book="${safeAttr(model.id)}">${escapeHTML(time)}${speed}</span>
    <span class="book-col book-col-status" data-open-book="${safeAttr(model.id)}">${status}</span>`;
}

function ringHTML(percent) {
  if (percent === null || percent === undefined) {
    return '<span class="offline-ring is-indeterminate" aria-hidden="true"></span>';
  }
  return `<span class="offline-ring" style="--pct:${Number(percent)}" aria-hidden="true"><span class="offline-ring-num num">${Number(percent)}</span></span>`;
}

// The trailing 44px offline control: download arrow, progress ring with a
// percentage, filled check, or retry glyph. Its label names the state in
// words (visible in the desktop table, read by screen readers on phones).
function offlineControlContents(model) {
  const { id, device, book } = model;
  const title = book.title || 'Untitled';
  const glyph = device.glyph === 'ring' ? ringHTML(device.percent)
    : device.glyph === 'check' ? GLYPH.check
      : device.glyph === 'retry' ? GLYPH.retry
        : GLYPH.download;
  if (device.tap === 'download' && !device.disabled) {
    const label = device.action || 'Download';
    return `
      <button type="button" class="book-local-state offline-btn offline-btn--${safeAttr(device.glyph)}" data-download-book="${safeAttr(id)}"
              title="${safeAttr(model.status.label || label)}" aria-label="${safeAttr(`${label}: ${title}`)}">
        ${glyph}<span class="offline-btn-label">${escapeHTML(label)}</span>
      </button>`;
  }
  if (device.tap === 'menu') {
    const label = device.column || device.long;
    return `
      <button type="button" class="book-local-state offline-btn offline-btn--${safeAttr(device.glyph)}" data-offline-menu-book="${safeAttr(id)}"
              aria-haspopup="menu" title="${safeAttr(model.status.label || device.long)}"
              aria-label="${safeAttr(`${device.long}. Download options for ${title}`)}">
        ${glyph}<span class="offline-btn-label">${escapeHTML(label)}</span>
      </button>`;
  }
  const label = device.column && device.column !== '—' ? device.column : device.long;
  return `
    <span class="book-local-state offline-btn offline-btn--${safeAttr(device.glyph)} is-inert" role="img"
          title="${safeAttr(model.status.label || device.long)}" aria-label="${safeAttr(`${device.long}: ${title}`)}">
      ${glyph}<span class="offline-btn-label">${escapeHTML(label)}</span>
    </span>`;
}

function offlineStatusHTML(model) {
  return `
    <span class="book-local-control book-local-control--${safeAttr(model.device.kind)}"
          data-offline-status="${safeAttr(model.id)}">
      ${offlineControlContents(model)}
    </span>`;
}

function progressBarHTML(progress, className = 'book-progress') {
  if (!progress || progress.percent == null) return '';
  return `
    <div class="${className}" role="progressbar" aria-valuenow="${progress.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${progress.percent}% listened">
      <div class="${className}-fill" style="width:${progress.percent}%"></div>
    </div>`;
}

function bookBylineHTML(model) {
  const chapter = model.chapterLabel ? `<span class="book-resume num" title="${safeAttr(model.chapterLabel)}">${escapeHTML(model.chapterLabel)}</span>` : '';
  return `<span class="book-byline"><span class="book-author">${escapeHTML(model.book.author || 'Unknown Author')}</span>${chapter}</span>`;
}

function renderBookCard(book, onShelf = false) {
  const model = bookModel(book);
  const { id, progress } = model;
  const title = book.title || 'Untitled';
  const author = book.author || 'Unknown Author';
  return `
    <div class="book-item${progress?.finished ? ' finished' : ''}${model.current ? ' is-current' : ''}"
         data-book-id="${safeAttr(id)}"
         data-on-shelf="${onShelf ? '1' : '0'}"
         data-downloaded="${model.downloaded ? '1' : '0'}"
         data-added="${safeAttr(book.addedAt || '')}"
         data-last-read="${safeAttr(model.position?.updatedAt || book.addedAt || '')}"
         data-finished="${progress?.finished ? '1' : '0'}">
      <div class="book-item-inner">
        <button class="book-card-open" type="button" data-open-book="${safeAttr(id)}"
                aria-label="${progress && !progress.finished ? 'Resume' : 'Play'} ${safeAttr(title)} by ${safeAttr(author)}">
          <span class="book-cover-wrap">
            ${coverImageHTML(book, 'book-item-cover', `Cover of ${title}`)}
          </span>
          ${progressBarHTML(progress, 'book-cell-progress')}
          <span class="book-item-info">
            <span class="book-title">${escapeHTML(title)}</span>
            ${bookBylineHTML(model)}
            ${statusLineHTML(model)}
            ${gridLinesHTML(model)}
          </span>
        </button>
        ${tableColumnsHTML(model)}
        ${offlineStatusHTML(model)}
        <div class="book-card-tools">
          <div class="book-overflow">
            <button class="book-overflow-trigger" type="button" data-book-menu-toggle aria-expanded="false" aria-haspopup="menu"
                    aria-label="More actions for ${safeAttr(title)}">${GLYPH.more}</button>
            <div class="book-overflow-menu" role="menu" aria-label="Actions for ${safeAttr(title)}" hidden></div>
          </div>
        </div>
        ${progressBarHTML(progress)}
      </div>
      <button class="delete-btn-reveal" tabindex="-1" aria-hidden="true" data-delete-book-id="${safeAttr(id)}" data-delete-book-title="${safeAttr(title)}" data-delete-book-author="${safeAttr(author)}" aria-label="Delete ${safeAttr(title)}">
        ${DELETE_GLYPH}
      </button>
    </div>
  `;
}

// Re-describe one rendered row after its device copy, narration or the
// open book changed, without rebuilding it (focus and menus survive).
function refreshRow(card) {
  const book = booksById.get(card.dataset.bookId);
  if (!book) return;
  const model = bookModel(book);
  card.dataset.downloaded = model.downloaded ? '1' : '0';
  card.classList.toggle('is-current', model.current);
  const info = card.querySelector('.book-item-info');
  if (info) {
    const byline = info.querySelector('.book-byline');
    if (byline) byline.outerHTML = bookBylineHTML(model);
    info.querySelector('.book-status')?.remove();
    info.querySelectorAll('.book-grid-line').forEach(line => line.remove());
    info.insertAdjacentHTML('beforeend', statusLineHTML(model) + gridLinesHTML(model));
  }
  const columns = card.querySelectorAll('.book-col');
  if (columns.length) {
    const template = document.createElement('template');
    template.innerHTML = tableColumnsHTML(model);
    columns.forEach((column, index) => column.replaceWith(template.content.children[0] || column));
  }
  const control = card.querySelector('[data-offline-status]');
  if (control) {
    const hadFocus = control.contains(document.activeElement);
    control.className = `book-local-control book-local-control--${model.device.kind}`;
    control.innerHTML = offlineControlContents(model);
    if (hadFocus) control.querySelector('button')?.focus();
  }
}

function skeletonCardsHTML(n) {
  return `
    <p id="library-loading-status" class="sr-only" role="status" aria-live="polite">Loading library…</p>
    ${Array.from({ length: n }, () => `
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
  `).join('')}`;
}

// ---- Status line fitting (brief fix 4) ---------------------------------------
//
// Each fitted element carries its variants in truncation order. Pass one
// shows the fullest variant everywhere; each later pass moves only the
// elements whose time or state is still clipped to their next variant.
// Reads and writes are batched per pass, so a full library costs three
// layouts, not one per row.

function isClipped(element) {
  if (element.scrollWidth > element.clientWidth + 1) return true;
  for (const child of element.children) {
    if (child.scrollWidth > child.clientWidth + 1) return true;
  }
  return false;
}

function fitStatusLines() {
  fitFrame = 0;
  const list = document.getElementById('library-view');
  if (!list) return;
  let pending = [...list.querySelectorAll('[data-fit]')].filter(element => element.offsetParent !== null);
  const variantsFor = new Map();
  for (const element of pending) {
    let variants;
    try { variants = JSON.parse(element.dataset.fit); } catch { variants = []; }
    variantsFor.set(element, variants);
    if (element.dataset.fitStep !== '0' && variants.length) element.innerHTML = variants[0];
    element.dataset.fitStep = '0';
  }
  for (let step = 1; pending.length; step++) {
    const clipped = pending.filter(element => isClipped(element));
    pending = clipped.filter(element => variantsFor.get(element).length > step);
    for (const element of pending) {
      element.innerHTML = variantsFor.get(element)[step];
      element.dataset.fitStep = String(step);
    }
  }
}

function scheduleFit() {
  if (fitFrame || typeof requestAnimationFrame !== 'function') return;
  fitFrame = requestAnimationFrame(fitStatusLines);
}

// ---- Continue strip ------------------------------------------------------------

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
  const { book, progress, position } = entry;
  const id = String(book.id || '');
  const title = book.title || 'Untitled';
  const chapter = resumeChapterLabel(id, progress.chapterIndex, { withTotal: true });
  const live = livePositionFor(id);
  const at = Number(position?.timestamp ?? position?.currentTime);
  const point = live?.isPlaying ? 'Playing' : (Number.isFinite(at) && at > 0 ? formatTime(at) : '');
  const meta = [chapter, point].filter(Boolean).join(' · ');
  const metaVariants = [...new Set([meta, chapter || meta])].map(escapeHTML);
  const label = live?.isPlaying
    ? `Now playing ${[title, chapter].filter(Boolean).join(', ')}. Open the player`
    : [`Resume ${title}`, meta].filter(Boolean).join(', ');
  const percent = progress.percent != null ? progress.percent : 0;
  return `
    <button type="button" class="rail-card${live ? ' is-playing' : ''}" data-book-id="${safeAttr(id)}"
            data-updated-ms="${safeAttr(progress.updatedAtMs || 0)}" aria-label="${safeAttr(label)}">
      <span class="rail-cover-wrap">${coverImageHTML(book, 'rail-cover')}</span>
      <span class="rail-text">
        <span class="rail-title">${escapeHTML(title)}</span>
        <span class="rail-meta num" data-fit="${fitAttr(metaVariants)}" title="${safeAttr(meta)}">${escapeHTML(meta)}</span>
      </span>
      <span class="rail-progress" aria-hidden="true"><span class="rail-progress-fill" style="width:${percent}%"></span></span>
    </button>
  `;
}

function continueEntries() {
  return inProgressEntries()
    .filter(entry => !isRailDismissed(entry.book.id, entry.progress.updatedAtMs) || livePositionFor(entry.book.id))
    .slice(0, CONTINUE_LIMIT);
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
    <h2 class="rail-heading" id="continue-rail-title">Continue</h2>
    <div class="rail-track" role="list" aria-labelledby="continue-rail-title">${entries.map(entry => `<div role="listitem" class="rail-item">${railCardHTML(entry)}</div>`).join('')}</div>
  `;
  syncContinueVisibility();
  scheduleFit();
}

function syncContinueVisibility() {
  if (!continueRail) return;
  const query = librarySearch?.value.trim() || '';
  continueRail.hidden = currentTab === 'downloaded' || query.length > 0 || !continueRailHasEntries;
}

function refreshContinueRail() {
  if (libraryContentState !== 'ready') return;
  renderContinueRail(continueEntries());
}

// ---- Load --------------------------------------------------------------------

function firstRunHTML() {
  return `
    <div class="empty-state-modern library-first-run">
      <div class="empty-art" aria-hidden="true">${GLYPH.bookshelf}</div>
      <h3>No books yet</h3>
      <p>Add an ebook and Xandrio narrates it on your server. You can start listening while the rest is prepared.</p>
      <button class="btn-primary btn-wide" type="button" data-add-book-empty>${GLYPH.search}<span>Find a book</span></button>
      <button class="btn-secondary btn-wide" type="button" data-upload-book-empty>${GLYPH.upload}<span>Upload a file</span></button>
      <p class="empty-fine">EPUB, MOBI, AZW, AZW3, PRC or PDF</p>
    </div>
  `;
}

function setLibraryShape(state) {
  const view = document.getElementById('library-view');
  if (view) view.dataset.libraryState = state;
  const searchToggle = document.getElementById('library-search-toggle');
  if (searchToggle) {
    // Search is disabled until there is something to search.
    searchToggle.disabled = state === 'empty';
  }
}

export async function loadLibrary() {
  const libraryList = document.getElementById('library-list');
  if (!libraryList) return;
  const generation = ++libraryLoadGeneration;
  const hasRenderedBooks = !!libraryList?.querySelector('.book-item:not(.skeleton)');
  if (!hasRenderedBooks) {
    libraryContentState = 'loading';
    setLibraryShape('loading');
    libraryList.innerHTML = skeletonCardsHTML(6);
    filterLibrary();
  }
  libraryList.setAttribute('aria-busy', 'true');

  try {
    // Verify local downloads concurrently, but do not make a successful online
    // library wait for a sequential Cache Storage audit. The verified result is
    // only required when the network library itself is unavailable.
    const verifiedOfflineBooks = getVerifiedOfflineLibraryBooks().catch(error => {
      console.warn('Could not verify local downloads:', error);
      return [];
    });
    let data, positions;
    let offlineFallback = false;
    try {
      const [libraryData, posData] = await Promise.all([
        apiGet('/api/library'),
        apiGet('/api/positions').catch(() => ({}))
      ]);
      data = libraryData;
      positions = posData.positions || {};
    } catch (err) {
      if (generation !== libraryLoadGeneration) return;
      console.error('Failed to load library:', err);
      const offlineBooks = await verifiedOfflineBooks;
      if (generation !== libraryLoadGeneration) return;
      if (offlineBooks.length > 0) {
        offlineFallback = true;
        data = { books: offlineBooks, shelf: [] };
        positions = Object.fromEntries(offlineBooks.map(book => [
          book.id,
          readJSON(`xandrio_playback_checkpoint:${book.id}`, null)
        ]));
      } else {
        libraryContentState = 'error';
        setLibraryShape('error');
        renderContinueRail([]);
        libraryList.classList.remove('offline-library-fallback');
        libraryList.innerHTML = `
          <div class="empty-state-modern" role="alert">
            <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg></div>
            <h3>Couldn't load your library</h3>
            <p>Check your connection and try again</p>
            <button class="btn-primary" data-retry-library>Retry</button>
          </div>
        `;
        libraryList.querySelector('[data-retry-library]')?.addEventListener('click', () => loadLibrary());
        filterLibrary();
        return;
      }
    }

    if (generation !== libraryLoadGeneration) return;
    libraryContentState = data.books.length ? 'ready' : 'empty';
    setLibraryShape(libraryContentState);
    currentShelf = new Set(Array.isArray(data.shelf) ? data.shelf : []);
    // A new account opens on its own shelf. Preserve an explicit tab choice.
    const storedTab = readText(libraryTabStorageKey(), 'shelf');
    currentTab = SCOPES.includes(storedTab) ? storedTab : 'shelf';
    if (offlineFallback) currentTab = 'downloaded';
    librarySnapshot = { books: data.books, positions };
    booksById = new Map(data.books.map(book => [String(book.id), book]));
    syncLibraryTabs();
    if (data.books.length === 0) {
      renderContinueRail([]);
      libraryList.classList.remove('offline-library-fallback');
      libraryList.innerHTML = firstRunHTML();
      filterLibrary();
      return;
    }

    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) document.body.classList.add('touch-device');
    libraryList.innerHTML = data.books.map(book => renderBookCard(book, currentShelf.has(book.id))).join('');
    libraryList.classList.toggle('offline-library-fallback', offlineFallback);
    document.dispatchEvent(new CustomEvent('xandrio:libraryloaded', {
      detail: { inProgressCount: getRecentInProgress(Infinity).length }
    }));
    renderContinueRail(continueEntries());
    syncSpeedNote();
    sortLibrary();
    filterLibrary();
    setupSwipeDelete();
    if (!offlineFallback) void loadResumeChapterStructures(data.books, positions, generation);
  } finally {
    if (generation === libraryLoadGeneration) libraryList.setAttribute('aria-busy', 'false');
  }
}

function refreshOfflineIndicators() {
  document.querySelectorAll('#library-list .book-item:not(.skeleton)').forEach(refreshRow);
  document.querySelectorAll('[data-offline-menu-action]').forEach(element => {
    const hadFocus = element.contains(document.activeElement);
    element.innerHTML = offlineMenuActionContents(element.dataset.offlineMenuAction);
    if (hadFocus) element.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  });
  if (bookActionsBookId) syncBookActionsHeader(bookActionsBookId);
  filterLibrary();
}

// Re-describe rows and the strip when the open book or its playback state
// changes (the library shows the live position of the playing book).
export function refreshLibraryPlayback() {
  if (libraryContentState !== 'ready') return;
  document.querySelectorAll('#library-list .book-item:not(.skeleton)').forEach(refreshRow);
  refreshContinueRail();
  syncSpeedNote();
  scheduleFit();
}

// ---- Scope (My Shelf / Downloaded / Shared Library) ---------------------------

function syncLibraryTabs() {
  document.querySelectorAll('[data-library-tab]').forEach(btn => {
    const active = btn.dataset.libraryTab === currentTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-scope-option]').forEach(item => {
    item.setAttribute('aria-checked', item.dataset.scopeOption === currentTab ? 'true' : 'false');
  });
  const label = SCOPE_LABELS[currentTab] || SCOPE_LABELS.shelf;
  const scopeLabel = document.getElementById('library-scope-label');
  if (scopeLabel) scopeLabel.textContent = label;
  const title = document.getElementById('library-title-text');
  if (title) title.textContent = label;
  document.getElementById('library-scope-button')
    ?.setAttribute('aria-label', `${label}. Change library scope`);
  document.getElementById('library-panel')
    ?.setAttribute('aria-labelledby', `library-tab-${currentTab}`);
  syncDeviceHint();
  document.dispatchEvent(new CustomEvent('xandrio:libraryscope', { detail: { scope: currentTab } }));
}

// The long device-transfer paragraph helps once there is a download to
// manage; on an empty Downloaded tab it buried the one useful action.
function syncDeviceHint() {
  const deviceHint = document.getElementById('downloaded-device-hint');
  if (!deviceHint) return;
  const hasDownloads = Boolean(document.querySelector('#library-list .book-item[data-downloaded="1"]'));
  deviceHint.hidden = currentTab !== 'downloaded' || !hasDownloads;
}

function syncScopeCounts() {
  const items = [...document.querySelectorAll('#library-list .book-item:not(.skeleton)')];
  const ready = libraryContentState === 'ready' || libraryContentState === 'empty';
  const counts = {
    shelf: items.filter(item => item.dataset.onShelf === '1').length,
    downloaded: items.filter(item => item.dataset.downloaded === '1').length,
    all: items.length
  };
  document.querySelectorAll('[data-shell-count]').forEach(element => {
    const value = counts[element.dataset.shellCount];
    element.textContent = ready && value !== undefined ? String(value) : '';
  });
  return counts;
}

function filterEmptyStateHTML() {
  return `
    <div class="empty-state-modern" data-library-filter-empty role="status" aria-live="polite">
      <h3>No matching books</h3>
      <p>Try another title or author.</p>
      <button class="btn-secondary" type="button" data-clear-library-filter>Clear filter</button>
    </div>`;
}

function updateFilterEmptyState(query, visibleCount) {
  const libraryList = document.getElementById('library-list');
  if (!libraryList) return;
  let emptyState = libraryList.querySelector('[data-library-filter-empty]');
  const shouldShow = libraryContentState === 'ready' && Boolean(query) && visibleCount === 0;
  if (shouldShow && !emptyState) {
    libraryList.insertAdjacentHTML('beforeend', filterEmptyStateHTML());
    emptyState = libraryList.querySelector('[data-library-filter-empty]');
  }
  if (emptyState) emptyState.hidden = !shouldShow;
}

// A card is visible when it matches the search query AND the active tab
// ("My Shelf", "Downloaded", or "Shared Library"). All paths funnel through here so the two
// filters can't fight over the hidden class.
function filterLibrary() {
  const query = librarySearch?.value.toLowerCase().trim() || '';
  let visibleCount = 0;
  document.querySelectorAll('.book-item:not(.skeleton)').forEach(item => {
    const title = item.querySelector('.book-title')?.textContent.toLowerCase() || '';
    const author = item.querySelector('.book-author')?.textContent.toLowerCase() || '';
    const matchesQuery = !query || title.includes(query) || author.includes(query);
    const matchesTab = currentTab === 'all' ||
      (currentTab === 'downloaded' ? item.dataset.downloaded === '1' : item.dataset.onShelf === '1');
    const visible = matchesQuery && matchesTab;
    item.classList.toggle('hidden', !visible);
    if (visible) visibleCount++;
  });
  syncContinueVisibility();
  const emptyShelfHint = document.getElementById('shelf-empty-hint');
  if (emptyShelfHint) emptyShelfHint.hidden = !(libraryContentState === 'ready' && currentTab === 'shelf' && visibleCount === 0 && !query);
  const emptyDownloadedHint = document.getElementById('downloaded-empty-hint');
  if (emptyDownloadedHint) emptyDownloadedHint.hidden = !(libraryContentState === 'ready' && currentTab === 'downloaded' && visibleCount === 0 && !query);
  updateFilterEmptyState(query, visibleCount);
  syncDeviceHint();
  syncScopeCounts();
  const count = document.getElementById('library-count');
  if (count) count.textContent = libraryContentState === 'ready' ? `${visibleCount} ${visibleCount === 1 ? 'book' : 'books'}` : '';
  const view = document.getElementById('library-view');
  if (view) view.dataset.libraryVisible = String(visibleCount);
  scheduleFit();
}

function setLibraryTab(tab) {
  currentTab = SCOPES.includes(tab) ? tab : 'shelf';
  writeText(libraryTabStorageKey(), currentTab);
  syncLibraryTabs();
  filterLibrary();
}

export function getLibraryScope() {
  return currentTab;
}

export function setLibraryScope(scope) {
  setLibraryTab(scope);
}

// Phone scope menu: a large-title button opening a native-style menu of the
// three scopes, with a check on the active one. Arrow keys, Home/End and
// typing move focus; Escape and Tab close it and focus returns to the title.
function scopeMenuItems() {
  return [...document.querySelectorAll('#library-scope-menu [role^="menuitem"]')];
}

function openScopeMenu(focus = 'checked') {
  const menu = document.getElementById('library-scope-menu');
  const button = document.getElementById('library-scope-button');
  if (!menu || !button) return;
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const items = scopeMenuItems();
  const target = focus === 'last' ? items[items.length - 1]
    : focus === 'first' ? items[0]
      : items.find(item => item.getAttribute('aria-checked') === 'true') || items[0];
  target?.focus();
}

function closeScopeMenu({ restoreFocus = true } = {}) {
  const menu = document.getElementById('library-scope-menu');
  const button = document.getElementById('library-scope-button');
  if (!menu || menu.hidden) return;
  const hadFocus = menu.contains(document.activeElement);
  menu.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && hadFocus) button?.focus();
}

function initScopeMenu() {
  const button = document.getElementById('library-scope-button');
  const menu = document.getElementById('library-scope-menu');
  if (!button || !menu) return;
  button.addEventListener('click', () => {
    if (menu.hidden) openScopeMenu();
    else closeScopeMenu();
  });
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openScopeMenu(event.key === 'ArrowUp' ? 'last' : 'checked');
    }
  });
  menu.addEventListener('click', event => {
    const option = event.target.closest('[data-scope-option]');
    if (option) {
      setLibraryTab(option.dataset.scopeOption);
      closeScopeMenu();
      return;
    }
    if (event.target.closest('[data-scope-stats]')) {
      closeScopeMenu({ restoreFocus: false });
      deps.navigateTo?.('stats');
    }
  });
  menu.addEventListener('keydown', event => {
    const items = scopeMenuItems();
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeScopeMenu();
      return;
    }
    if (event.key === 'Tab') {
      closeScopeMenu({ restoreFocus: false });
      return;
    }
    let next = null;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      const match = ordered.find(item => item.textContent.trim().toLowerCase().startsWith(letter));
      if (match) next = items.indexOf(match);
    }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (menu.hidden) return;
    if (!menu.contains(event.target) && !button.contains(event.target)) closeScopeMenu({ restoreFocus: false });
  });
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget) && event.relatedTarget !== button) {
      closeScopeMenu({ restoreFocus: false });
    }
  });
}

// ---- Shelf, study-guide tag --------------------------------------------------

async function toggleShelfMembership(bookId, button) {
  const onShelf = currentShelf.has(bookId);
  if (button) button.disabled = true;
  try {
    if (onShelf) {
      await apiSend('DELETE', `/api/shelf/${encodeURIComponent(bookId)}`);
      currentShelf.delete(bookId);
    } else {
      await apiSend('POST', `/api/shelf/${encodeURIComponent(bookId)}`);
      currentShelf.add(bookId);
    }
    const card = document.querySelector(`#library-list .book-item[data-book-id="${cssEscape(bookId)}"]`);
    if (card) card.dataset.onShelf = currentShelf.has(bookId) ? '1' : '0';
    document.querySelectorAll(`[data-shelf-toggle="${cssEscape(bookId)}"] [data-saved-label]`).forEach(label => {
      label.textContent = currentShelf.has(bookId) ? 'Remove from My Shelf' : 'Save to My Shelf';
    });
    filterLibrary();
    showToast(currentShelf.has(bookId) ? 'Saved to My Shelf' : 'Removed from My Shelf', '', { key: `shelf:${bookId}` });
  } catch (err) {
    console.error('Shelf update failed:', err);
    showToast('Could not update My Shelf', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

// ---- Sort, view mode, density --------------------------------------------------

function sortLibrary() {
  const sortBy = sortSelect.value;
  const libraryList = document.getElementById('library-list');
  libraryList.querySelectorAll('.library-divider').forEach(el => el.remove());
  const bookItems = Array.from(libraryList.querySelectorAll('.book-item'));
  bookItems.sort((a, b) => {
    const aTitle = a.querySelector('.book-title')?.textContent || '';
    const aAuthor = a.querySelector('.book-author')?.textContent || '';
    const aDate = a.dataset.added || '0';
    const bTitle = b.querySelector('.book-title')?.textContent || '';
    const bAuthor = b.querySelector('.book-author')?.textContent || '';
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
  const empty = libraryList.querySelector('[data-library-filter-empty]');
  if (empty) libraryList.appendChild(empty);
}

// The sort control reads as words ("Last played ⌄"), so it is only as
// wide as the chosen option rather than the longest one.
let measureCanvas = null;
function sizeSortSelect() {
  if (!sortSelect || typeof document.createElement !== 'function') return;
  const text = sortSelect.selectedOptions?.[0]?.textContent || '';
  const style = getComputedStyle(sortSelect);
  measureCanvas ||= document.createElement('canvas');
  const context = measureCanvas.getContext?.('2d');
  if (!context) return;
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  sortSelect.style.width = `${Math.ceil(context.measureText(text).width + padding + 2)}px`;
}

// "Time left at 1.25×": the speed is stated once for the whole list; a row
// whose book has its own speed says so inline.
function syncSpeedNote() {
  const note = document.getElementById('library-speed-note');
  if (note) note.textContent = `Time left at ${formatSpeed(getReferencePlaybackSpeed())}`;
}

function setViewMode(mode) {
  currentViewMode = mode === 'grid' ? 'grid' : 'list';
  writeText(VIEW_MODE_KEY, currentViewMode);
  document.getElementById('library-list')?.classList.toggle('grid-view', currentViewMode === 'grid');
  document.querySelectorAll('[data-view-mode]').forEach(button => {
    const on = button.dataset.viewMode === currentViewMode;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  scheduleFit();
}

function toggleView() {
  setViewMode(currentViewMode === 'list' ? 'grid' : 'list');
}

function applyRowDensity() {
  const density = getClientSettings().shelfRowDensity === 'comfortable' ? 'comfortable' : 'compact';
  const list = document.getElementById('library-list');
  if (list) list.dataset.density = density;
  scheduleFit();
}

// ---- Open, download, remove ----------------------------------------------------

async function openBookFromLibrary(bookId) {
  const escapedId = cssEscape(bookId);
  const card = document.querySelector(`.book-item[data-book-id="${escapedId}"]`);
  let loadingTimer = null;
  if (card) loadingTimer = setTimeout(() => card.classList.add('loading'), 300);
  try {
    return await deps.resumeBook(bookId);
  } catch (err) {
    console.error('Error opening book:', err);
    return false;
  } finally {
    if (loadingTimer) clearTimeout(loadingTimer);
    card?.classList.remove('loading');
  }
}

async function downloadBookFromLibrary(bookId) {
  const id = String(bookId);
  if (!offlineDownloadsSupported() || !navigator.onLine) return;
  if (cancelOfflineDownload(id)) return;
  const initialStatus = offlineStatusForBook(id);
  const notificationSetup = (
    initialStatus.kind === 'ready-to-prepare' ||
    initialStatus.kind === 'preparation-error' ||
    initialStatus.kind === 'preparation-paused' ||
    initialStatus.kind === 'preparation-capacity'
  )
    ? enableOfflineReadyNotifications()
    : Promise.resolve(false);
  pendingBookDownloads.add(id);
  refreshOfflineIndicators();
  try {
    const data = await apiGet(`/api/book/${encodeURIComponent(id)}`);
    pendingBookDownloads.delete(id);
    refreshOfflineIndicators();
    if (!data?.book || !Array.isArray(data.chapters) || data.chapters.length === 0) {
      throw new Error('Book has no downloadable chapters');
    }
    const status = offlineStatusForBook(id);
    if (
      status.kind === 'prepared' ||
      status.kind === 'partial-download' ||
      status.kind === 'repair-needed'
    ) {
      await downloadBookForOffline(data.book, data.chapters, { showOverlay: false, confirmForeground: false });
    } else {
      await prepareAndDownloadBookForOffline(data.book, data.chapters, {
        notificationSetup,
        showOverlay: false
      });
    }
  } catch (error) {
    console.error('Could not start offline download:', error);
    showToast('Could not start download. Try again.', 'error');
  } finally {
    pendingBookDownloads.delete(id);
    refreshOfflineIndicators();
  }
}

async function removeDownloadedBookFromLibrary(bookId) {
  const id = String(bookId);
  try {
    const result = await removeOfflineBook(id);
    showToast(result.removed ? 'Download removed' : 'No download found');
  } catch (error) {
    console.error('Could not remove offline download:', error);
    showToast('Could not remove download. Try again.', 'error');
  }
}

// ---- Book actions (menu on desktop, bottom sheet on phone) ----------------------

function menuItem(attrs, glyph, label, sub = '') {
  return `<button type="button" role="menuitem" ${attrs}><span class="menu-glyph">${glyph}</span><span class="menu-label">${label}</span>${sub ? `<span class="menu-sub" aria-hidden="true">${escapeHTML(sub)}</span>` : ''}</button>`;
}

function offlineMenuActionContents(bookId) {
  const status = offlineStatusForBook(bookId);
  if (pendingBookDownloads.has(String(bookId))) {
    return `<button type="button" role="menuitem" disabled aria-busy="true"><span class="menu-glyph">${GLYPH.download}</span>Checking offline audio…</button>`;
  }
  if (status.downloaded) {
    return `<button type="button" role="menuitem" data-remove-offline-book="${safeAttr(bookId)}"><span class="menu-glyph">${GLYPH.remove}</span><span class="menu-label">Remove download</span><span class="menu-sub" aria-hidden="true">Keeps server audio</span></button>`;
  }
  if (status.kind === 'downloading') {
    return `<span class="book-menu-status" role="status">${escapeHTML(status.label)} · Keep Xandrio open</span>
      <button type="button" role="menuitem" data-download-book="${safeAttr(bookId)}"><span class="menu-glyph">${GLYPH.cancel}</span>Cancel download</button>`;
  }
  if (status.kind === 'preparing' || (status.kind === 'prepared' && status.autoResume)) {
    return `<span class="book-menu-status" role="status">${escapeHTML(status.label)}</span>
      <button type="button" role="menuitem" data-remove-offline-preparation="${safeAttr(bookId)}"><span class="menu-glyph">${GLYPH.cancel}</span>Cancel download</button>`;
  }
  if (status.kind === 'preparation-waiting') {
    return `<span class="book-menu-status" role="status">${escapeHTML(status.label)}</span>
      <button type="button" role="menuitem" data-remove-offline-preparation="${safeAttr(bookId)}"><span class="menu-glyph">${GLYPH.cancel}</span>Cancel download</button>`;
  }
  if (status.kind === 'prepared') {
    return `<button type="button" role="menuitem" data-download-book="${safeAttr(bookId)}"><span class="menu-glyph">${GLYPH.download}</span>Download</button>`;
  }
  if (status.kind === 'download-unavailable' || status.kind === 'download-offline') {
    return `<button type="button" role="menuitem" disabled><span class="menu-glyph">${GLYPH.download}</span>${escapeHTML(status.label)}</button>`;
  }
  const label = status.kind === 'preparation-error'
    ? 'Retry download'
    : status.kind === 'preparation-capacity'
      ? 'Retry download'
      : 'Download';
  const glyph = label === 'Download' ? GLYPH.download : GLYPH.retry;
  return `<button type="button" role="menuitem" data-download-book="${safeAttr(bookId)}"><span class="menu-glyph">${glyph}</span>${label}</button>`;
}

function inContinueStrip(bookId) {
  return Boolean(continueRail?.querySelector(`.rail-card[data-book-id="${cssEscape(bookId)}"]`));
}

// Items in the mockup's order: the offline action in its current state,
// Add to Up Next, My Shelf, Share, Study guide (tagged nonfiction only),
// then Delete set apart. The admin nonfiction tag lives in
// Settings › Study guides.
function bookActionsItemsHTML(bookId) {
  const id = String(bookId);
  const book = booksById.get(id) || { id };
  const title = book.title || 'Untitled';
  const author = book.author || 'Unknown Author';
  const onShelf = currentShelf.has(id);
  const nonfiction = book.studyGuideCategory === 'nonfiction';
  return `
    <div class="book-menu-group" role="none">
      <span role="none" data-offline-menu-action="${safeAttr(id)}">${offlineMenuActionContents(id)}</span>
      ${menuItem(`data-queue-add="${safeAttr(id)}"`, GLYPH.queue, 'Add to Up Next')}
      ${menuItem(`data-shelf-toggle="${safeAttr(id)}"`, GLYPH.shelf, `<span data-saved-label>${onShelf ? 'Remove from My Shelf' : 'Save to My Shelf'}</span>`)}
      ${menuItem(`data-book-share="${safeAttr(id)}" data-book-title="${safeAttr(title)}" data-book-author="${safeAttr(author)}"`, GLYPH.share, 'Share')}
      ${nonfiction ? menuItem(`data-book-guide="${safeAttr(id)}"`, GLYPH.info, 'Study guide', 'Nonfiction') : ''}
      ${inContinueStrip(id) ? menuItem(`data-rail-dismiss="${safeAttr(id)}"`, GLYPH.hide, 'Remove from Continue') : ''}
    </div>
    <div class="book-menu-group book-menu-group--danger" role="none">
      ${menuItem(`class="book-menu-danger" data-delete-book-id="${safeAttr(id)}" data-delete-book-title="${safeAttr(title)}" data-delete-book-author="${safeAttr(author)}"`, GLYPH.trash, 'Delete from library')}
    </div>`;
}

function syncBookActionsHeader(bookId) {
  const head = document.getElementById('book-actions-head');
  const book = booksById.get(String(bookId));
  if (!head || !book) return;
  const model = bookModel(book);
  const parts = [];
  if (model.timeLeft === 0) parts.push('Finished');
  else if (model.timeLeft !== null) parts.push(`${formatDuration(model.timeLeft)} left at ${formatSpeed(model.speed)}`);
  if (model.primary && model.primary !== model.context) parts.push(model.primary.long);
  const bytes = Number(model.status.bytesTotal) || 0;
  if (bytes > 0) parts.push(`${Math.round(bytes / 1e6)} MB`);
  const titleFocused = document.activeElement?.id === 'book-actions-title';
  head.innerHTML = `
    ${coverImageHTML(book, 'book-actions-cover')}
    <div class="book-actions-text">
      <h3 id="book-actions-title" class="book-actions-title" tabindex="-1">${escapeHTML(book.title || 'Untitled')}</h3>
      <p class="book-actions-author">${escapeHTML(book.author || 'Unknown Author')}</p>
      <p class="book-actions-meta num">${escapeHTML(parts.join(' · '))}</p>
    </div>`;
  if (titleFocused) document.getElementById('book-actions-title')?.focus();
}

function openBookActionsSheet(bookId) {
  const list = document.getElementById('book-actions-list');
  if (!bookActionsSheet || !list || !booksById.has(String(bookId))) return;
  closeBookMenus();
  bookActionsBookId = String(bookId);
  syncBookActionsHeader(bookId);
  list.innerHTML = bookActionsItemsHTML(bookId);
  list.setAttribute('aria-label', `Actions for ${booksById.get(String(bookId))?.title || 'book'}`);
  bookActionsSheet.open();
}

function dismissBookActionsSheet() {
  if (!bookActionsBookId) return;
  bookActionsSheet?.dismiss();
}

function openBookActions(bookId) {
  const card = document.querySelector(`#library-list .book-item[data-book-id="${cssEscape(bookId)}"]`);
  const trigger = card?.querySelector('[data-book-menu-toggle]');
  if (isDesktop() && trigger && card.offsetParent !== null) {
    const menu = trigger.closest('.book-overflow')?.querySelector('.book-overflow-menu');
    if (menu?.hidden) toggleBookMenu(trigger);
    else trigger.focus();
    return;
  }
  openBookActionsSheet(bookId);
}

function closeBookMenus(except = null) {
  document.querySelectorAll('.book-overflow-menu:not([hidden])').forEach(menu => {
    if (menu === except) return;
    const trigger = menu.closest('.book-overflow')?.querySelector('[data-book-menu-toggle]');
    if (menu.contains(document.activeElement)) trigger?.focus();
    menu.hidden = true;
    menu.innerHTML = '';
    menu.closest('.book-item')?.classList.remove('menu-open');
    trigger?.setAttribute('aria-expanded', 'false');
  });
}

function toggleBookMenu(trigger) {
  const card = trigger.closest('.book-item');
  if (!isDesktop() && card) {
    openBookActionsSheet(card.dataset.bookId);
    return;
  }
  const menu = trigger.closest('.book-overflow')?.querySelector('.book-overflow-menu');
  if (!menu) return;
  const opening = menu.hidden;
  closeBookMenus(opening ? menu : null);
  if (opening) menu.innerHTML = bookActionsItemsHTML(card?.dataset.bookId || '');
  menu.hidden = !opening;
  card?.classList.toggle('menu-open', opening);
  trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
  if (opening) {
    // Open upward when the row sits low in the viewport.
    menu.classList.remove('opens-up');
    const rect = menu.getBoundingClientRect();
    const bottomLimit = window.innerHeight - (parseFloat(getComputedStyle(document.body).getPropertyValue('--shell-bottom')) || 0);
    if (rect.bottom > bottomLimit && rect.height < trigger.getBoundingClientRect().top) menu.classList.add('opens-up');
    menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }
}

function initBookActionsSheet() {
  const sheetEl = document.getElementById('book-actions-sheet');
  const list = document.getElementById('book-actions-list');
  if (!sheetEl || !list) return;
  bookActionsSheet = registerSheet(sheetEl, {
    backdrop: document.getElementById('book-actions-backdrop'),
    closeBtn: document.getElementById('book-actions-cancel'),
    focusTarget: () => sheetEl,
    initialFocus: () => document.getElementById('book-actions-title'),
    onClose: () => {
      bookActionsBookId = null;
    }
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...list.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  sheetEl.addEventListener('keydown', event => {
    if (event.key === 'Escape' && bookActionsBookId) {
      event.preventDefault();
      dismissBookActionsSheet();
    }
  });
  // Close the sheet first, then act once its history entry is consumed, so
  // an action that opens another sheet (Delete's confirmation) or navigates
  // (Study guide) never races the sheet's own history.back().
  list.addEventListener('click', event => {
    const action = event.target.closest('button[role="menuitem"]:not(:disabled)');
    if (!action || !list.contains(action)) return;
    event.stopPropagation();
    const proxy = { target: action, stopPropagation() {} };
    const backPending = Boolean(window.history.state?.xandrioSheet);
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', run);
      handleBookAction(proxy);
    };
    if (backPending) {
      window.addEventListener('popstate', run);
      setTimeout(run, 400);
    }
    dismissBookActionsSheet();
    if (!backPending) run();
  });
}

// One handler for every book action, from a row menu or the phone sheet.
// Returns true when it handled the click.
function handleBookAction(e) {
  const deleteBtn = e.target.closest('[data-delete-book-id]');
  if (deleteBtn) {
    e.stopPropagation();
    closeBookMenus();
    showDeleteModal(deleteBtn.dataset.deleteBookId, deleteBtn.dataset.deleteBookTitle, deleteBtn.dataset.deleteBookAuthor);
    return true;
  }
  const shelfBtn = e.target.closest('[data-shelf-toggle]');
  if (shelfBtn) {
    e.stopPropagation();
    closeBookMenus();
    toggleShelfMembership(shelfBtn.dataset.shelfToggle, shelfBtn);
    return true;
  }
  const queueBtn = e.target.closest('[data-queue-add]');
  if (queueBtn) {
    e.stopPropagation();
    closeBookMenus();
    deps.addToListeningQueue?.(queueBtn.dataset.queueAdd);
    return true;
  }
  const shareBtn = e.target.closest('[data-book-share]');
  if (shareBtn) {
    e.stopPropagation();
    closeBookMenus();
    void shareBook({
      id: shareBtn.dataset.bookShare,
      title: shareBtn.dataset.bookTitle,
      author: shareBtn.dataset.bookAuthor
    });
    return true;
  }
  const guideBtn = e.target.closest('[data-book-guide]');
  if (guideBtn) {
    e.stopPropagation();
    closeBookMenus();
    deps.openBookGuide?.(guideBtn.dataset.bookGuide);
    return true;
  }
  const railDismissBtn = e.target.closest('[data-rail-dismiss]');
  if (railDismissBtn) {
    e.stopPropagation();
    closeBookMenus();
    const card = continueRail?.querySelector(`.rail-card[data-book-id="${cssEscape(railDismissBtn.dataset.railDismiss)}"]`);
    if (card) dismissRailEntryWithUndo(card);
    return true;
  }
  const removeOfflineBtn = e.target.closest('[data-remove-offline-book]');
  if (removeOfflineBtn) {
    e.stopPropagation();
    closeBookMenus();
    void removeDownloadedBookFromLibrary(removeOfflineBtn.dataset.removeOfflineBook);
    return true;
  }
  const removePreparationBtn = e.target.closest('[data-remove-offline-preparation]');
  if (removePreparationBtn) {
    e.stopPropagation();
    closeBookMenus();
    const id = removePreparationBtn.dataset.removeOfflinePreparation;
    void cancelOfflinePreparation(id).catch(error => {
      console.error('Could not cancel download:', error);
      showToast('Could not cancel download. Try again.', 'error');
    });
    return true;
  }
  const downloadBtn = e.target.closest('[data-download-book]');
  if (downloadBtn) {
    e.stopPropagation();
    closeBookMenus();
    void downloadBookFromLibrary(downloadBtn.dataset.downloadBook);
    return true;
  }
  return false;
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
      let localCleanupFailed = false;
      try {
        await deps.onBookDeleted?.(id);
      } catch (error) {
        localCleanupFailed = true;
        console.warn('Deleted title but could not clear its active player:', error);
      }
      try {
        await removeOfflineBook(id, { removePlaybackState: true });
      } catch (error) {
        localCleanupFailed = true;
        console.warn('Deleted title but could not remove its local download:', error);
      }
      // Retire refreshes that may still contain the deleted book, then remove
      // every library representation rather than only the first rail card.
      ++libraryLoadGeneration;
      const libraryList = document.getElementById('library-list');
      libraryList?.setAttribute('aria-busy', 'false');
      const escapedId = cssEscape(id);
      const card = libraryList?.querySelector(`.book-item[data-book-id="${escapedId}"]`);
      const hadFocus = card?.contains(document.activeElement);
      card?.remove();
      continueRail?.querySelector(`.rail-card[data-book-id="${escapedId}"]`)?.closest('.rail-item')?.remove();
      currentShelf.delete(id);
      booksById.delete(String(id));
      librarySnapshot = { ...librarySnapshot, books: librarySnapshot.books.filter(book => String(book.id) !== String(id)) };
      continueRailHasEntries = Boolean(continueRail?.querySelector('.rail-card'));
      if (!libraryList?.querySelector('.book-item')) await loadLibrary();
      else filterLibrary();
      if (hadFocus) {
        (libraryList?.querySelector('.book-item:not(.hidden) [data-open-book]')
          || document.getElementById('library-scope-button')
          || document.querySelector(`[data-library-tab="${currentTab}"]`))?.focus();
      }
      showToast(
        localCleanupFailed ? 'Book deleted; local download cleanup needs retry' : 'Book and local download deleted',
        localCleanupFailed ? 'error' : ''
      );
    } else {
      showToast('Failed to delete book', 'error');
    }
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Error deleting book', 'error');
  }
}

// ---- Gestures: swipe to delete, press and hold for actions ----------------------

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
    const bookItem = e.target.closest('#library-list .book-item');
    if (openItem && bookItem !== openItem && !e.target.closest('.delete-btn-reveal')) closeOpen(true);
    if (!bookItem || e.target.closest('.delete-btn-reveal')) return;
    // The grid and the desktop table have no swipe affordance.
    if (bookItem.closest('.grid-view') || isDesktop()) return;
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

// Press and hold (or right-click / the context-menu key) on a row or a
// Continue card opens that book's actions — the phone's only path besides
// the focusable "More actions" button screen readers and keyboards reach.
function setupLongPress(surface) {
  if (!surface) return;
  let timer = null;
  let start = null;
  let fired = false;
  const targetFor = event => event.target.closest('.book-item:not(.skeleton), .rail-card');
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    start = null;
  };
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const target = targetFor(event);
    if (!target || event.target.closest('.offline-btn, .book-overflow, .delete-btn-reveal')) return;
    fired = false;
    start = { x: event.clientX, y: event.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      navigator.vibrate?.(10);
      openBookActions(target.dataset.bookId);
    }, LONG_PRESS_MS);
  });
  surface.addEventListener('pointermove', event => {
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => surface.addEventListener(type, cancel));
  surface.addEventListener('click', event => {
    if (!fired) return;
    fired = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  surface.addEventListener('contextmenu', event => {
    const target = targetFor(event);
    if (!target || event.target.closest('.book-overflow-menu')) return;
    event.preventDefault();
    if (!fired) openBookActions(target.dataset.bookId);
  });
  surface.addEventListener('keydown', event => {
    if (!((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return;
    const target = targetFor(event);
    if (!target) return;
    event.preventDefault();
    openBookActions(target.dataset.bookId);
  });
}

// ---- Audio activity (narration preparation) ---------------------------------------

function onAudioActivity(event) {
  const books = Array.isArray(event?.detail?.books) ? event.detail.books : [];
  const next = new Map(books.filter(book => book && typeof book.id === 'string').map(book => [book.id, book]));
  const key = JSON.stringify([...next.values()].map(book => [
    book.id, book.failed, book.preparationStatus, book.readyChapters, book.totalChapters,
    Math.round((Number(book.readyAudioSeconds) || 0) / 60), Number(book.active) > 0, Number(book.queued) > 0
  ]));
  if (key === audioActivityKey) return;
  const changed = new Set([...audioActivity.keys(), ...next.keys()]);
  audioActivity = next;
  audioActivityKey = key;
  if (libraryContentState !== 'ready') return;
  changed.forEach(id => {
    const card = document.querySelector(`#library-list .book-item[data-book-id="${cssEscape(id)}"]`);
    if (card) refreshRow(card);
  });
  scheduleFit();
}

// ---- Init ------------------------------------------------------------------------

export function initLibrary(options = {}) {
  deps = options;
  librarySearch = document.getElementById('library-search');
  sortSelect = document.getElementById('sort-select');
  continueRail = document.getElementById('continue-rail');
  document.addEventListener('xandrio:offlinechange', refreshOfflineIndicators);
  document.addEventListener('xandrio:audioactivity', onAudioActivity);
  document.addEventListener('xandrio:listeningqueue', refreshLibraryPlayback);
  document.addEventListener('xandrio:client-settings', event => {
    const key = event.detail?.key;
    if (key === 'shelfRowDensity' || key === '*') applyRowDensity();
    if (key === 'defaultSpeed' || key === '*') refreshLibraryPlayback();
  });
  document.addEventListener('xandrio:viewchange', event => {
    if (event.detail?.view === 'library') refreshLibraryPlayback();
    closeScopeMenu({ restoreFocus: false });
  });

  initScopeMenu();
  initBookActionsSheet();
  setViewMode(readText(VIEW_MODE_KEY, 'list'));
  applyRowDensity();
  syncSpeedNote();

  document.getElementById('library-search-toggle')?.addEventListener('click', () => {
    const searchBar = document.getElementById('library-search-bar');
    searchBar?.removeAttribute('inert');
    searchBar?.setAttribute('aria-hidden', 'false');
    searchBar?.classList.remove('collapsed');
    librarySearch?.focus();
  });
  document.getElementById('library-search-close')?.addEventListener('click', () => {
    librarySearch.value = '';
    filterLibrary();
    document.getElementById('library-search-toggle')?.focus();
    const searchBar = document.getElementById('library-search-bar');
    searchBar?.classList.add('collapsed');
    searchBar?.setAttribute('aria-hidden', 'true');
    searchBar?.setAttribute('inert', '');
  });
  librarySearch?.addEventListener('input', filterLibrary);
  sortSelect?.addEventListener('change', () => {
    sizeSortSelect();
    sortLibrary();
  });
  sizeSortSelect();
  document.getElementById('library-tabs')?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-library-tab]');
    if (tabBtn) setLibraryTab(tabBtn.dataset.libraryTab);
  });
  document.getElementById('library-tabs')?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...e.currentTarget.querySelectorAll('[data-library-tab]')];
    const activeIndex = Math.max(0, tabs.indexOf(document.activeElement));
    const nextIndex = e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? tabs.length - 1
        : (activeIndex + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[nextIndex].focus();
    setLibraryTab(tabs[nextIndex].dataset.libraryTab);
  });
  document.getElementById('shelf-empty-hint')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-book-shelf]')) {
      document.getElementById('add-book-btn')?.click();
      return;
    }
    if (e.target.closest('[data-browse-shared-library]')) setLibraryTab('all');
  });
  document.getElementById('downloaded-empty-hint')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-browse-shelf]')) setLibraryTab('shelf');
  });
  document.querySelectorAll('[data-view-mode]').forEach(button => {
    button.addEventListener('click', () => setViewMode(button.dataset.viewMode));
  });
  document.getElementById('view-toggle-btn')?.addEventListener('click', event => {
    if (!event.currentTarget.dataset.viewMode) toggleView();
  });

  const libraryList = document.getElementById('library-list');
  if (typeof ResizeObserver === 'function' && libraryList) {
    let lastWidth = 0;
    new ResizeObserver(entries => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (width && width !== lastWidth) {
        lastWidth = width;
        scheduleFit();
      }
    }).observe(libraryList);
  }
  document.fonts?.ready?.then(() => {
    sizeSortSelect();
    scheduleFit();
  }).catch(() => {});
  setupLongPress(libraryList);
  setupLongPress(continueRail);

  libraryList?.addEventListener('keydown', (e) => {
    const trigger = e.target.closest('[data-book-menu-toggle]');
    if (trigger && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      if (!isDesktop()) {
        toggleBookMenu(trigger);
        return;
      }
      const menu = trigger.closest('.book-overflow')?.querySelector('.book-overflow-menu');
      if (menu?.hidden) toggleBookMenu(trigger);
      const items = menu?.querySelectorAll('[role="menuitem"]:not(:disabled)');
      (e.key === 'ArrowUp' ? items?.[items.length - 1] : items?.[0])?.focus();
      return;
    }
    const menu = e.target.closest('.book-overflow-menu');
    if (menu && e.key === 'Tab') {
      closeBookMenus();
      return;
    }
    if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    e.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  libraryList?.addEventListener('focusout', (e) => {
    const overflow = e.target.closest('.book-overflow');
    if (overflow && e.relatedTarget && !overflow.contains(e.relatedTarget)) closeBookMenus();
  });
  libraryList?.addEventListener('click', (e) => {
    const emptyAddBtn = e.target.closest('[data-add-book-empty]');
    if (emptyAddBtn) {
      e.preventDefault();
      document.getElementById('add-book-btn')?.click();
      return;
    }
    if (e.target.closest('[data-upload-book-empty]')) {
      e.preventDefault();
      deps.openUpload?.();
      return;
    }
    const clearFilterBtn = e.target.closest('[data-clear-library-filter]');
    if (clearFilterBtn) {
      e.preventDefault();
      if (librarySearch) {
        librarySearch.value = '';
        librarySearch.focus();
      }
      filterLibrary();
      return;
    }
    const menuTrigger = e.target.closest('[data-book-menu-toggle]');
    if (menuTrigger) {
      e.stopPropagation();
      toggleBookMenu(menuTrigger);
      return;
    }
    const offlineMenuBtn = e.target.closest('[data-offline-menu-book]');
    if (offlineMenuBtn) {
      e.stopPropagation();
      openBookActions(offlineMenuBtn.dataset.offlineMenuBook);
      return;
    }
    if (e.target.closest('.offline-btn.is-inert')) return;
    if (handleBookAction(e)) return;
    const openBtn = e.target.closest('[data-open-book]');
    if (openBtn) openBookFromLibrary(openBtn.dataset.openBook);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.book-overflow')) closeBookMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openMenu = document.querySelector('.book-overflow-menu:not([hidden])');
    if (!openMenu) return;
    const trigger = openMenu.closest('.book-overflow')?.querySelector('[data-book-menu-toggle]');
    closeBookMenus();
    trigger?.focus();
  });
  continueRail?.addEventListener('click', (e) => {
    const card = e.target.closest('.rail-card');
    if (!card) return;
    openBookFromLibrary(card.dataset.bookId);
  });

  // The playing book's card and row follow play/pause.
  const miniPlay = document.getElementById('mini-player-play');
  if (miniPlay && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (document.getElementById('library-view')?.classList.contains('active')) refreshContinueRail();
    }).observe(miniPlay, { attributes: true, attributeFilter: ['aria-label'] });
  }
}

// Remove a Continue card from the UI immediately, but defer the persisted
// dismissal (localStorage) ~5s so Undo can restore the exact card. Reached
// from the book actions ("Remove from Continue").
function dismissRailEntryWithUndo(card) {
  const bookId = card.dataset.bookId;
  const updatedMs = Number(card.dataset.updatedMs) || Date.now();
  const item = card.closest('.rail-item') || card;
  const track = item.parentElement;
  const nextSibling = item.nextElementSibling;

  item.remove();
  if (continueRail && !continueRail.querySelector('.rail-card')) {
    continueRailHasEntries = false;
    continueRail.hidden = true;
  }

  showUndoToast('Removed from Continue', {
    onUndo: () => {
      if (!track) return;
      if (nextSibling && nextSibling.parentElement === track) track.insertBefore(item, nextSibling);
      else track.appendChild(item);
      continueRailHasEntries = true;
      syncContinueVisibility();
    },
    onCommit: () => dismissRailEntry(bookId, updatedMs)
  });
}
