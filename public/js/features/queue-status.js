import { apiGet } from '../api.js';
import { escapeHTML, coverImageHTML } from '../util/format.js';
import { registerSheet } from '../ui/sheets.js';

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
let lastBookCount = 0;

function normalizedBooks(status) {
  if (!Array.isArray(status?.books)) return [];
  return status.books.filter(book =>
    book && typeof book.id === 'string' &&
    (Number(book.active || 0) > 0 || Number(book.queued || 0) > 0)
  );
}

function chapterSummary(book) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const active = chapters.filter(chapter => Number(chapter?.active || 0) > 0);
  const waiting = chapters.filter(chapter => Number(chapter?.active || 0) === 0 && Number(chapter?.queued || 0) > 0);

  if (active.length > 0) {
    const chapterNumber = Number(active[0].chapterIndex) + 1;
    const nextCount = Math.max(0, chapters.length - active.length);
    return `Chapter ${chapterNumber} · Generating${nextCount ? ` · ${nextCount} next` : ''}`;
  }
  if (waiting.length === 1) {
    return `Chapter ${Number(waiting[0].chapterIndex) + 1} · Waiting to prepare`;
  }
  if (waiting.length > 1) {
    return `${waiting.length} chapters waiting to prepare`;
  }
  return 'Waiting to prepare';
}

function renderActivityDetails(status = currentStatus) {
  if (!activityListEl || !activitySummaryEl) return;
  const books = normalizedBooks(status);
  const activeBooks = books.filter(book => Number(book.active || 0) > 0).length;
  const waitingBooks = books.length - activeBooks;

  if (activeBooks > 0 && waitingBooks > 0) {
    activitySummaryEl.textContent = `${activeBooks} preparing, ${waitingBooks} waiting.`;
  } else if (activeBooks > 0) {
    activitySummaryEl.textContent = `${activeBooks} ${activeBooks === 1 ? 'book is' : 'books are'} preparing audio.`;
  } else {
    activitySummaryEl.textContent = `${waitingBooks} ${waitingBooks === 1 ? 'book is' : 'books are'} waiting to prepare.`;
  }

  activityListEl.innerHTML = books.map(book => {
    const active = Number(book.active || 0) > 0;
    return `
      <article class="audio-activity-row" data-state="${active ? 'active' : 'queued'}">
        ${coverImageHTML(book, 'audio-activity-cover', '')}
        <div class="audio-activity-copy">
          <strong>${escapeHTML(book.title || 'Untitled')}</strong>
          <span>${escapeHTML(book.author || 'Unknown Author')}</span>
          <span class="audio-activity-state">
            <span class="audio-activity-dot" aria-hidden="true"></span>
            ${escapeHTML(chapterSummary(book))}
          </span>
        </div>
      </article>
    `;
  }).join('');
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
  const books = normalizedBooks(status);
  const bookCount = books.length;
  const hasWork = bookCount > 0;
  const activeBooks = books.filter(book => Number(book.active || 0) > 0).length;

  announceBookCount(bookCount);
  lastBookCount = bookCount;
  currentStatus = {
    active: Number(status?.active || 0),
    queued: Number(status?.queued || 0),
    books
  };

  queueStatusEl.hidden = !hasWork;
  if (!hasWork) {
    activitySheetController?.close();
    return;
  }

  const label = activeBooks > 0
    ? `${bookCount} ${bookCount === 1 ? 'book is' : 'books are'} preparing audio`
    : `${bookCount} ${bookCount === 1 ? 'book is' : 'books are'} waiting to prepare`;
  queueStatusEl.dataset.state = activeBooks > 0 ? 'active' : 'queued';
  queueStatusEl.setAttribute('aria-label', label);
  queueStatusEl.title = label;
  if (activityCountEl) activityCountEl.textContent = bookCount > 99 ? '99+' : String(bookCount);
  if (activitySheetEl?.classList.contains('active')) renderActivityDetails(currentStatus);
}

async function pollQueueStatus(scope = pollScope) {
  try {
    const status = await apiGet('/api/queue/status');
    if (scope !== pollScope || scope?.closed) return;
    renderQueueStatus(status);
  } catch {
    if (scope !== pollScope || scope?.closed) return;
    if (queueStatusEl) queueStatusEl.hidden = true;
    activitySheetController?.close();
    currentStatus = { active: 0, queued: 0, books: [] };
    lastBookCount = 0;
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
  if (!queueStatusEl) return;

  ensureActivitySheetController();
  const intervalMs = Math.max(2000, Number(options.intervalMs || 4000));
  const scope = new DisposableScope();
  pollScope = scope;
  scope.listen(queueStatusEl, 'click', () => activitySheetController?.open());
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
