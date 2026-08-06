import { apiGet, apiSend } from '../api.js';
import { escapeHTML, coverImageHTML } from '../util/format.js';
import { registerSheet } from '../ui/sheets.js';
import { showToast } from '../ui/toast.js';

// A title's place in the audio-preparation order is something the reader can
// change; a transfer already in flight is not. Downloads are excluded for that
// reason, not as an oversight.
const REORDERABLE_KINDS = new Set(['queue', 'preparation']);

// Chevrons rather than glyph characters: DESIGN.md rules out emoji UI icons,
// and a stroked path stays crisp at the small size these controls need.
const MOVE_ICON = {
  up: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 10 8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

const { DisposableScope } = globalThis.XandrioLifecycle || {};
let queueStatusEl = null;
let activityCountEl = null;
let activityAnnouncementEl = null;
let activitySheetEl = null;
let activitySummaryEl = null;
let activityListEl = null;
let activitySheetController = null;
let pollScope = null;
let currentStatus = { active: 0, queued: 0, books: [] };
let currentServerStatus = { active: 0, queued: 0, books: [] };
let currentDownloads = [];
let currentPreparations = [];
let lastBookCount = 0;
let activityStructureKey = '';

function normalizedBooks(status) {
  if (!Array.isArray(status?.books)) return [];
  return status.books.filter(book =>
    book && typeof book.id === 'string' &&
    (Number(book.active || 0) > 0 || Number(book.queued || 0) > 0)
  );
}

function normalizedDownloads(downloads) {
  if (!Array.isArray(downloads)) return [];
  return downloads
    .filter(download => download && typeof download.id === 'string')
    .map(download => ({
      ...download,
      kind: 'download',
      active: 1,
      queued: 0,
      percent: Math.max(0, Math.min(100, Math.round(Number(download.percent) || 0)))
    }));
}

function normalizedPreparations(preparations) {
  if (!Array.isArray(preparations)) return [];
  return preparations
    .filter(preparation => preparation && typeof preparation.id === 'string')
    .map(preparation => ({
      ...preparation,
      kind: 'preparation',
      active: 1,
      queued: 0,
      percent: Math.max(0, Math.min(99, Math.round(Number(preparation.percent) || 0))),
      readyChapters: Math.max(0, Number(preparation.readyChapters) || 0),
      totalChapters: Math.max(0, Number(preparation.totalChapters) || 0)
    }));
}

function combinedBooks(status) {
  const downloads = normalizedDownloads(currentDownloads);
  const preparations = normalizedPreparations(currentPreparations)
    .filter(preparation => !downloads.some(download => download.id === preparation.id));
  const localActivityIds = new Set([
    ...downloads.map(download => download.id),
    ...preparations.map(preparation => preparation.id)
  ]);
  return [
    ...downloads,
    ...preparations,
    ...normalizedBooks(status).filter(book => !localActivityIds.has(book.id))
  ];
}

function chapterSummary(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const active = chapters.filter(chapter => Number(chapter?.active || 0) > 0);
  const waiting = chapters.filter(chapter => Number(chapter?.active || 0) === 0 && Number(chapter?.queued || 0) > 0);
  const origins = book?.origins || {};
  const purpose = Number(origins['offline-download']) > 0
    ? 'Preparing for download'
    : Number(origins['playback-lookahead']) > 0
      ? 'Preparing chapters ahead'
      : Number(origins['import-warmup']) > 0
        ? 'Preparing starting chapter'
        : Number(origins['playback-current']) > 0
          ? 'Preparing current chapter'
          : 'Generating';

  if (active.length > 0) {
    const chapterNumber = Number(active[0].chapterIndex) + 1;
    const nextCount = Math.max(0, chapters.length - active.length);
    return `${purpose} · Chapter ${chapterNumber}${nextCount ? ` · ${nextCount} next` : ''}`;
  }
  if (waiting.length === 1) {
    return `Chapter ${Number(waiting[0].chapterIndex) + 1} · Waiting to prepare`;
  }
  if (waiting.length > 1) {
    return `${waiting.length} chapters waiting to prepare`;
  }
  return 'Waiting to prepare';
}

function activityStateLabel(book) {
  if (book.kind === 'download') {
    const size = bytes => {
      if (!Number.isFinite(bytes) || bytes <= 0) return '';
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
      return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(1)} MB`;
    };
    const details = [];
    if (book.bytesReceived > 0 && book.bytesTotal > 0) {
      details.push(`${size(book.bytesReceived)} of ${size(book.bytesTotal)}`);
    }
    if (book.bytesPerSecond > 0) details.push(`${size(book.bytesPerSecond)}/s`);
    if (Number.isFinite(book.etaSeconds) && book.etaSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(book.etaSeconds / 60));
      details.push(`${minutes} min left`);
    }
    return [book.phase || 'Downloading', `${book.percent}%`, ...details].join(' · ');
  }
  if (book.kind === 'preparation') {
    return `Preparing audio · ${book.readyChapters}/${book.totalChapters}`;
  }
  return chapterSummary(book);
}

function activityStructureFor(books) {
  return JSON.stringify(books.map(book => ({
    id: book.id,
    kind: book.kind || 'queue',
    title: book.title || '',
    author: book.author || '',
    hasCover: Boolean(book.hasCover),
    coverPath: book.coverPath || '',
    coverUrl: book.coverUrl || ''
  })));
}

function isReorderable(book) {
  return REORDERABLE_KINDS.has(book?.kind || 'queue');
}

/**
 * The reorder control, or nothing at all when there is no second title to
 * trade places with. A lone row with two dead arrows reads as broken.
 */
function reorderControlHTML(book, position, total) {
  if (total < 2) return '';
  const title = book.title || 'Untitled';
  const button = direction => {
    const atEnd = direction === 'up' ? position === 0 : position === total - 1;
    const label = direction === 'up'
      ? `Move ${title} earlier in the queue`
      : `Move ${title} later in the queue`;
    return `
      <button type="button" class="audio-activity-move"
              data-move-queue-book="${escapeHTML(book.id)}"
              data-move-direction="${direction}"
              aria-label="${escapeHTML(label)}"
              ${atEnd ? 'disabled' : ''}>${MOVE_ICON[direction]}</button>
    `;
  };
  return `
    <div class="audio-activity-reorder" role="group"
         aria-label="${escapeHTML(`Queue position for ${title}: ${position + 1} of ${total}`)}">
      ${button('up')}${button('down')}
    </div>
  `;
}

function patchActivityRows(books) {
  const rows = Array.from(activityListEl?.querySelectorAll?.('[data-audio-activity-id]') || []);
  if (rows.length !== books.length) return false;

  for (let index = 0; index < books.length; index += 1) {
    const book = books[index];
    const row = rows[index];
    if (
      row.dataset.audioActivityId !== book.id ||
      row.dataset.audioActivityKind !== (book.kind || 'queue')
    ) {
      return false;
    }
  }

  books.forEach((book, index) => {
    const row = rows[index];
    row.dataset.state = Number(book.active || 0) > 0 ? 'active' : 'queued';
    const label = row.querySelector?.('[data-audio-activity-label]');
    if (label) label.textContent = activityStateLabel(book);
    if (book.kind !== 'download') return;
    const progress = row.querySelector?.('[data-audio-activity-progress]');
    progress?.setAttribute?.('aria-valuenow', String(book.percent));
    const fill = row.querySelector?.('[data-audio-activity-progress-fill]');
    if (fill?.style) fill.style.width = `${book.percent}%`;
  });
  return true;
}

function renderActivityDetails(status = currentStatus) {
  if (!activityListEl || !activitySummaryEl) return;
  const books = normalizedBooks(status);
  const downloadingBooks = books.filter(book => book.kind === 'download').length;
  const offlinePreparingBooks = books.filter(book => book.kind === 'preparation').length;
  const preparingBooks = books.length - downloadingBooks - offlinePreparingBooks;
  const activeBooks = books.filter(book => Number(book.active || 0) > 0).length;
  const waitingBooks = books.length - activeBooks;

  if (downloadingBooks > 0 && preparingBooks + offlinePreparingBooks > 0) {
    activitySummaryEl.textContent = `${downloadingBooks} downloading, ${preparingBooks + offlinePreparingBooks} preparing audio.`;
  } else if (downloadingBooks > 0) {
    activitySummaryEl.textContent = `${downloadingBooks} ${downloadingBooks === 1 ? 'book is' : 'books are'} downloading.`;
  } else if (offlinePreparingBooks > 0 && preparingBooks === 0) {
    activitySummaryEl.textContent = `${offlinePreparingBooks} ${offlinePreparingBooks === 1 ? 'book is' : 'books are'} preparing audio.`;
  } else if (activeBooks > 0 && waitingBooks > 0) {
    activitySummaryEl.textContent = `${activeBooks} preparing, ${waitingBooks} waiting.`;
  } else if (activeBooks > 0) {
    activitySummaryEl.textContent = `${activeBooks} ${activeBooks === 1 ? 'book is' : 'books are'} preparing audio.`;
  } else {
    activitySummaryEl.textContent = `${waitingBooks} ${waitingBooks === 1 ? 'book is' : 'books are'} waiting to prepare.`;
  }

  const structureKey = activityStructureFor(books);
  if (structureKey === activityStructureKey && patchActivityRows(books)) return;

  const reorderable = books.filter(isReorderable);
  activityListEl.innerHTML = books.map(book => {
    const active = Number(book.active || 0) > 0;
    const isDownload = book.kind === 'download';
    const isPreparation = book.kind === 'preparation';
    const reorderControl = isReorderable(book)
      ? reorderControlHTML(book, reorderable.indexOf(book), reorderable.length)
      : '';
    return `
      <article class="audio-activity-row" data-state="${active ? 'active' : 'queued'}"
               data-audio-activity-id="${escapeHTML(book.id)}"
               data-audio-activity-kind="${escapeHTML(book.kind || 'queue')}"
               ${reorderControl ? 'data-reorderable="true"' : ''}>
        ${coverImageHTML(book, 'audio-activity-cover', '')}
        <div class="audio-activity-copy">
          <strong>${escapeHTML(book.title || 'Untitled')}</strong>
          <span>${escapeHTML(book.author || 'Unknown Author')}</span>
          <span class="audio-activity-state">
            <span class="audio-activity-dot" aria-hidden="true"></span>
            <span data-audio-activity-label>${escapeHTML(activityStateLabel(book))}</span>
          </span>
          ${isDownload ? `
            <span class="audio-activity-progress" data-audio-activity-progress role="progressbar"
                  aria-label="Download progress" aria-valuemin="0" aria-valuemax="100"
                  aria-valuenow="${book.percent}">
              <span data-audio-activity-progress-fill style="width: ${book.percent}%"></span>
            </span>
          ` : ''}
          ${isDownload || isPreparation ? `
            <button type="button" class="audio-activity-cancel"
                    data-cancel-offline-book="${escapeHTML(book.id)}">Cancel</button>
          ` : ''}
        </div>
        ${reorderControl}
      </article>
    `;
  }).join('');
  activityStructureKey = structureKey;
}

/**
 * Reorder locally first, then confirm with the server. Waiting for the round
 * trip would make the arrows feel dead for up to a poll interval; the next poll
 * reconciles, and a rejected move snaps back immediately.
 */
async function moveQueueBook(bookId, direction) {
  const books = currentStatus.books || [];
  const reorderable = books.filter(isReorderable);
  const from = reorderable.findIndex(book => book.id === bookId);
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= reorderable.length) return;

  const moved = reorderable[from];
  const displaced = reorderable[to];
  const reordered = books.slice();
  reordered[books.indexOf(moved)] = displaced;
  reordered[books.indexOf(displaced)] = moved;
  currentStatus = { ...currentStatus, books: reordered };
  activityStructureKey = '';
  renderActivityDetails(currentStatus);
  if (activityAnnouncementEl) {
    activityAnnouncementEl.textContent =
      `${moved.title || 'Untitled'} moved to position ${to + 1} of ${reorderable.length}.`;
  }

  try {
    await apiSend('POST', '/api/queue/order', { bookId, direction });
  } catch (error) {
    // Put the list back the way the server sees it rather than leaving a
    // rearrangement on screen that never happened.
    activityStructureKey = '';
    await pollQueueStatus();
    if (error?.status !== 409) {
      showToast(error?.message || 'Could not reorder audio preparation', 'error');
    }
  }
}

function announceBookCount(bookCount) {
  if (!activityAnnouncementEl || bookCount === lastBookCount) return;
  if (lastBookCount === 0 && bookCount > 0) {
    activityAnnouncementEl.textContent = `Audio preparation started for ${bookCount} ${bookCount === 1 ? 'book' : 'books'}.`;
  } else if (lastBookCount > 0 && bookCount === 0) {
    activityAnnouncementEl.textContent = 'Audio preparation complete.';
  }
}

function renderQueueStatus(status) {
  if (!queueStatusEl) return;
  currentServerStatus = {
    active: Number(status?.active || 0),
    queued: Number(status?.queued || 0),
    books: normalizedBooks(status)
  };
  const books = combinedBooks(currentServerStatus);
  const bookCount = books.length;
  const hasWork = bookCount > 0;
  const activeBooks = books.filter(book => Number(book.active || 0) > 0).length;
  const downloadingBooks = books.filter(book => book.kind === 'download').length;
  const localPreparationBooks = books.filter(book => book.kind === 'preparation').length;

  announceBookCount(bookCount);
  lastBookCount = bookCount;
  currentStatus = {
    active: Number(currentServerStatus.active || 0) + downloadingBooks + localPreparationBooks,
    queued: Number(currentServerStatus.queued || 0),
    books
  };

  queueStatusEl.hidden = !hasWork;
  if (!hasWork) {
    activitySheetController?.close();
    return;
  }

  const label = downloadingBooks > 0
    ? `${bookCount} ${bookCount === 1 ? 'book has' : 'books have'} active audio activity`
    : activeBooks > 0
    ? `${bookCount} ${bookCount === 1 ? 'book is' : 'books are'} preparing audio`
    : `${bookCount} ${bookCount === 1 ? 'book is' : 'books are'} waiting to prepare`;
  queueStatusEl.dataset.state = activeBooks > 0 ? 'active' : 'queued';
  queueStatusEl.setAttribute('aria-label', label);
  queueStatusEl.title = label;
  if (activityCountEl) activityCountEl.textContent = bookCount > 99 ? '99+' : String(bookCount);
  if (activitySheetEl?.classList.contains('active')) renderActivityDetails(currentStatus);
}

async function pollQueueStatus(scope = pollScope) {
  // A badge nobody can see is not worth a request. The visibilitychange
  // listener below polls immediately on return, so nothing is stale by the
  // time it matters.
  if (document.hidden) return;
  try {
    const status = await apiGet('/api/queue/status');
    if (scope !== pollScope || scope?.closed) return;
    renderQueueStatus(status);
  } catch {
    if (scope !== pollScope || scope?.closed) return;
    renderQueueStatus({ active: 0, queued: 0, books: [] });
  }
}

function ensureActivitySheetController() {
  if (activitySheetController || !activitySheetEl) return;
  activitySheetController = registerSheet(activitySheetEl, {
    backdrop: document.getElementById('audio-activity-backdrop'),
    closeBtn: document.getElementById('audio-activity-close'),
    onOpen: () => {
      const panel = activitySheetEl.querySelector?.('.audio-activity-panel');
      if (panel?.style && typeof window.matchMedia === 'function') {
        if (window.matchMedia('(min-width: 760px)').matches && queueStatusEl?.getBoundingClientRect) {
          const trigger = queueStatusEl.getBoundingClientRect();
          const panelWidth = Math.min(400, Math.max(0, window.innerWidth - 32));
          const right = Math.min(
            window.innerWidth - 16,
            Math.max(16 + panelWidth, trigger.right)
          );
          panel.style.left = `${right}px`;
        } else {
          panel.style.left = '';
        }
      }
      queueStatusEl?.setAttribute('aria-expanded', 'true');
      renderActivityDetails(currentStatus);
    },
    onClose: () => queueStatusEl?.setAttribute('aria-expanded', 'false')
  });
}

export function initQueueStatus(options = {}) {
  // Re-initialising (view remount) must stop the previous poller even when
  // the replacement view does not render an audio-activity trigger.
  stopQueueStatus();

  queueStatusEl = document.getElementById('queue-status');
  activityCountEl = document.getElementById('audio-activity-count');
  activityAnnouncementEl = document.getElementById('audio-activity-announcement');
  activitySheetEl = document.getElementById('audio-activity-sheet');
  activitySummaryEl = document.getElementById('audio-activity-summary');
  activityListEl = document.getElementById('audio-activity-list');
  activityStructureKey = '';
  if (!queueStatusEl) return;

  ensureActivitySheetController();
  const intervalMs = Math.max(2000, Number(options.intervalMs || 4000));
  const scope = new DisposableScope();
  pollScope = scope;
  scope.listen(queueStatusEl, 'click', () => activitySheetController?.open());
  scope.listen(document, 'xandrio:downloadactivity', event => {
    const hadActiveDownload = currentDownloads.length > 0;
    currentDownloads = normalizedDownloads(event?.detail?.downloads);
    renderQueueStatus(currentServerStatus);
    if (!hadActiveDownload && currentDownloads.length > 0) {
      activitySheetController?.open();
    }
  });
  scope.listen(document, 'xandrio:preparationactivity', event => {
    currentPreparations = normalizedPreparations(event?.detail?.preparations);
    renderQueueStatus(currentServerStatus);
  });
  scope.listen(activityListEl, 'click', event => {
    const moveButton = event.target.closest?.('[data-move-queue-book]');
    const moveBookId = moveButton?.dataset?.moveQueueBook;
    const moveDirection = moveButton?.dataset?.moveDirection;
    if (moveBookId && moveDirection && !moveButton.disabled) {
      void moveQueueBook(moveBookId, moveDirection);
      return;
    }
    const button = event.target.closest?.('[data-cancel-offline-book]');
    const bookId = button?.dataset?.cancelOfflineBook;
    if (!bookId || typeof globalThis.CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent('xandrio:cancelofflinedownload', {
      detail: { bookId }
    }));
  });
  pollQueueStatus(scope);
  scope.interval(() => pollQueueStatus(scope), intervalMs, window);
  scope.listen(document, 'visibilitychange', () => {
    if (!document.hidden) pollQueueStatus(scope);
  });
}

export function stopQueueStatus() {
  pollScope?.dispose();
  pollScope = null;
  activitySheetController?.close();
}
