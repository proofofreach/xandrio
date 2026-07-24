// Stats / listening-history view.
//
// Read-only surface backed by GET /api/stats (aggregated server-side by
// lib/listening-stats.js). Loads its data on every entry to the view via the
// shared xandrio:viewchange event, mirroring how the settings view refreshes.

import { apiGet } from '../api.js';
import { navigateTo } from '../router.js';
import { escapeHTML, safeAttr, relativeTime, coverImageHTML } from '../util/format.js';

let deps = {};
let statsBody = null;
let loaded = false;

function coverHTML(entry, cls) {
  return coverImageHTML(entry, cls, '');
}

function statTile(value, label) {
  return `
    <div class="stat-tile">
      <span class="stat-tile-value">${escapeHTML(String(value))}</span>
      <span class="stat-tile-label">${escapeHTML(label)}</span>
    </div>`;
}

function recentCardHTML(entry) {
  const badge = entry.finished ? '<span class="stats-recent-badge">Finished</span>' : '';
  const when = entry.updatedAt ? relativeTime(entry.updatedAt) : '';
  return `
    <button class="rail-card stats-recent-card" data-book-id="${safeAttr(entry.id)}" aria-label="Open ${safeAttr(entry.title)}">
      <div class="stats-recent-cover-wrap">
        ${coverHTML(entry, 'stats-recent-cover')}
      </div>
      <p class="rail-title">${escapeHTML(entry.title)}</p>
      <p class="rail-meta">${badge || escapeHTML(when)}</p>
    </button>`;
}

function progressRowHTML(entry) {
  const percent = Number.isFinite(entry.percent) ? entry.percent : 0;
  const when = entry.updatedAt ? relativeTime(entry.updatedAt) : '';
  const chapter = entry.chapterCount
    ? `Chapter ${Math.min(entry.chapterIndex + 1, entry.chapterCount)} of ${entry.chapterCount}`
    : '';
  const meta = [chapter, when].filter(Boolean).join(' · ');
  return `
    <button class="stats-progress-row" data-book-id="${safeAttr(entry.id)}" aria-label="Open ${safeAttr(entry.title)}">
      <div class="stats-progress-cover-wrap">${coverHTML(entry, 'stats-progress-cover')}</div>
      <div class="stats-progress-info">
        <h3>${escapeHTML(entry.title)}</h3>
        <p>${escapeHTML(entry.author || '')}</p>
        <div class="book-progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${percent}% listened">
          <div class="book-progress-fill" style="width:${percent}%"></div>
        </div>
        <p class="stats-progress-meta">${escapeHTML(meta)}<span class="stats-progress-percent">${percent}%</span></p>
      </div>
    </button>`;
}

function emptyStateHTML() {
  return `
    <div class="empty-state-modern">
      <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg></div>
      <h3>No listening yet</h3>
      <p>Play a book and your progress and stats will show up here.</p>
      <button class="btn-primary" data-stats-browse>Browse your library</button>
    </div>`;
}

function render(stats) {
  if (!statsBody) return;
  const hasAny = stats.recent.length > 0 || stats.inProgress.length > 0 || stats.booksFinishedCount > 0;
  if (!hasAny) {
    statsBody.innerHTML = emptyStateHTML();
    return;
  }

  const tiles = `
    <div class="stats-tiles">
      ${statTile(stats.totalHoursListened, stats.totalHoursListened === 1 ? 'hour listened' : 'hours listened')}
      ${statTile(stats.booksFinishedCount, stats.booksFinishedCount === 1 ? 'book finished' : 'books finished')}
      ${statTile(stats.booksInProgressCount, 'in progress')}
    </div>`;

  const recent = stats.recent.length > 0 ? `
    <section class="stats-section">
      <h2 class="rail-heading">Recently listened</h2>
      <div class="rail-track">${stats.recent.map(recentCardHTML).join('')}</div>
    </section>` : '';

  const inProgress = stats.inProgress.length > 0 ? `
    <section class="stats-section">
      <h2 class="rail-heading">In progress</h2>
      <div class="stats-progress-list">${stats.inProgress.map(progressRowHTML).join('')}</div>
    </section>` : '';

  statsBody.innerHTML = tiles + recent + inProgress;
}

function renderError() {
  if (!statsBody) return;
  statsBody.innerHTML = `
    <div class="empty-state-modern">
      <div class="empty-icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="icon-lg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg></div>
      <h3>Couldn't load stats</h3>
      <p>Check your connection and try again.</p>
      <button class="btn-primary" data-stats-retry>Retry</button>
    </div>`;
}

async function loadStats() {
  if (!statsBody) return;
  if (!loaded) statsBody.innerHTML = '<div class="stats-loading" aria-hidden="true"></div>';
  try {
    const data = await apiGet('/api/stats');
    loaded = true;
    render(data.stats || data);
  } catch (err) {
    console.error('Failed to load stats:', err);
    renderError();
  }
}

export function initStats(options = {}) {
  deps = options;
  statsBody = document.getElementById('stats-body');
  const backBtn = document.getElementById('stats-back-btn');
  backBtn?.addEventListener('click', () => navigateTo('library'));
  document.getElementById('stats-btn')?.addEventListener('click', () => navigateTo('stats'));

  document.addEventListener('xandrio:viewchange', (e) => {
    if (e.detail.view !== 'stats') return;
    loadStats();
  });

  statsBody?.addEventListener('click', (e) => {
    if (e.target.closest('[data-stats-retry]')) { loadStats(); return; }
    if (e.target.closest('[data-stats-browse]')) { navigateTo('library'); return; }
    const card = e.target.closest('[data-book-id]');
    if (card && deps.openBook) deps.openBook(card.dataset.bookId);
  });
}
