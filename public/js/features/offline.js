import { API_BASE, apiSend } from '../api.js';
import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';
import { readJSON, writeJSON } from '../util/storage.js';
import { showToast, showUndoToast } from '../ui/toast.js';

export const OFFLINE_AUDIO_CACHE = 'xandrio-offline-audio';
const OFFLINE_BOOKS_KEY = 'xandrio_offline_books';

let deps = {};
let downloadAbort = null;

export function initOffline(options = {}) {
  deps = options;
  document.getElementById('download-book-btn')?.addEventListener('click', () => downloadCurrentBook());
  document.getElementById('offline-books-list')?.addEventListener('click', handleOfflineManagerClick);
  window.addEventListener('online', flushPendingPositions);
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  renderOfflineState();
  updateOfflineBanner();
  flushPendingPositions();
}

function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  banner.hidden = navigator.onLine;
}

export function getOfflineManifest() {
  const value = readJSON(OFFLINE_BOOKS_KEY, {});
  return value && typeof value === 'object' ? value : {};
}

function saveOfflineManifest(manifest) {
  writeJSON(OFFLINE_BOOKS_KEY, manifest);
}

export function offlineEntryForBook(bookId) {
  return getOfflineManifest()[bookId] || null;
}

export function isBookDownloadedForOffline(bookId, chapterIndex = 0) {
  const entry = offlineEntryForBook(bookId);
  return Boolean(entry && chapterIndex >= 0 && chapterIndex < (Number(entry.chapters) || 0));
}

export function renderOfflineState() {
  renderPlayerOfflineState();
  renderOfflineManager();
}

function currentVoiceLabel() {
  return document.getElementById('player-voice-name')?.textContent?.trim() || 'Current voice';
}

function renderPlayerOfflineState() {
  const btn = document.getElementById('download-book-btn');
  const badge = document.getElementById('offline-book-badge');
  const book = deps.getCurrentBook?.();
  if (!btn || !badge) return;
  if (!book) {
    btn.hidden = true;
    badge.hidden = true;
    return;
  }
  btn.hidden = false;
  const entry = offlineEntryForBook(book.id);
  if (!entry) {
    badge.hidden = true;
    btn.textContent = 'Download for Offline';
    return;
  }
  badge.hidden = false;
  badge.textContent = `Downloaded · ${entry.voiceLabel || 'Voice'}`;
  btn.textContent = 'Re-download Offline';
  refreshCurrentVariantBadge(book, entry, badge, btn);
}

async function refreshCurrentVariantBadge(book, entry, badge, btn) {
  try {
    const response = await fetch(`${API_BASE}/api/chunks/${encodeURIComponent(book.id)}/0/chapter-audio-status`);
    if (!response.ok) return;
    const status = await response.json();
    if (!status.variantKey || !entry.variantKey || status.variantKey === entry.variantKey) return;
    badge.textContent = `Downloaded · ${entry.voiceLabel || 'Voice'} · stale`;
    btn.textContent = 'Re-download Current Voice';
  } catch {}
}

async function downloadCurrentBook() {
  const book = deps.getCurrentBook?.();
  const chapters = deps.getChapters?.() || [];
  if (!book || chapters.length === 0) return;
  if (!('caches' in window)) {
    showToast('Offline audio cache is unavailable', 'error');
    return;
  }
  if (downloadAbort) {
    downloadAbort.abort();
    downloadAbort = null;
    return;
  }

  downloadAbort = new AbortController();
  const signal = downloadAbort.signal;
  const cache = await caches.open(OFFLINE_AUDIO_CACHE);
  let bytes = 0;
  let variantKey = '';
  deps.showAudioLoading?.('Downloading book for offline', {
    detail: 'Checking storage...',
    percent: 0,
    status: 'generating'
  });

  try {
    const estimate = await navigator.storage?.estimate?.();
    const available = estimate?.quota && estimate?.usage ? Math.max(0, estimate.quota - estimate.usage) : null;
    if (available != null) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: `${Math.round(available / 1024 / 1024)} MB storage available`,
        percent: 0,
        status: 'generating'
      });
    }

    for (let i = 0; i < chapters.length; i++) {
      if (signal.aborted) throw new Error('Download cancelled');
      const percent = Math.round((i / chapters.length) * 100);
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: `Preparing chapter ${i + 1} of ${chapters.length}`,
        percent,
        status: 'generating'
      });
      const status = await prepareChapter(book.id, i, signal);
      if (!variantKey) variantKey = status.variantKey || '';
      const url = status.url || `/api/audio/${encodeURIComponent(book.id)}/${i}`;
      const response = await fetch(`${API_BASE}${url}`, { signal });
      if (!response.ok) throw new Error(`Audio download failed for chapter ${i + 1}`);
      const clone = response.clone();
      bytes += Number(response.headers.get('Content-Length')) || 0;
      await cache.put(new Request(`${API_BASE}/api/audio/${encodeURIComponent(book.id)}/${i}`), clone);
    }

    const manifest = getOfflineManifest();
    manifest[book.id] = {
      bookId: book.id,
      title: book.title,
      variantKey,
      voiceLabel: currentVoiceLabel(),
      chapters: chapters.length,
      bytes,
      downloadedAt: new Date().toISOString()
    };
    saveOfflineManifest(manifest);
    showToast('Book downloaded for offline');
  } catch (err) {
    showToast(err.message || 'Offline download failed', 'error');
  } finally {
    downloadAbort = null;
    deps.hideAudioLoading?.();
    renderOfflineState();
  }
}

async function prepareChapter(bookId, chapterIndex, signal) {
  await apiSend('POST', `/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/prepare-chapter-audio`);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (signal.aborted) throw new Error('Download cancelled');
    const response = await fetch(`${API_BASE}/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/chapter-audio-status`, { signal });
    const status = await response.json();
    if (status.ready) return status;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out preparing chapter ${chapterIndex + 1}`);
}

function renderOfflineManager() {
  const list = document.getElementById('offline-books-list');
  if (!list) return;
  const entries = Object.values(getOfflineManifest());
  if (entries.length === 0) {
    list.innerHTML = '<p class="settings-hint">No downloaded books.</p>';
    return;
  }
  list.innerHTML = entries.map(entry => `
    <div class="offline-book-row" data-offline-book-id="${escapeHTML(entry.bookId)}">
      <div class="offline-book-copy">
        <strong>${escapeHTML(entry.title || 'Untitled')}</strong>
        <span>${escapeHTML(entry.voiceLabel || 'Voice')} · ${entry.bytes ? `${Math.round(entry.bytes / 1024 / 1024)} MB` : 'Size unavailable'} · ${entry.downloadedAt ? relativeTime(entry.downloadedAt) : ''}</span>
      </div>
      <button type="button" class="btn-ghost btn-ghost-danger btn-sm" data-offline-delete="${escapeHTML(entry.bookId)}">Delete</button>
    </div>
  `).join('');
}

function handleOfflineManagerClick(e) {
  const btn = e.target.closest('[data-offline-delete]');
  if (!btn) return;
  deleteOfflineBook(btn.dataset.offlineDelete, btn.closest('.offline-book-row'));
}

function deleteOfflineBook(bookId, rowEl) {
  if (!offlineEntryForBook(bookId)) return;
  // Optimistic UI removal only — the manifest entry and cached audio stay
  // until the commit fires, so Undo restores the row by re-rendering.
  const list = document.getElementById('offline-books-list');
  if (rowEl) {
    rowEl.remove();
    if (list && !list.querySelector('.offline-book-row')) {
      list.innerHTML = '<p class="settings-hint">No downloaded books.</p>';
    }
  } else {
    renderOfflineManager();
  }

  showUndoToast('Offline download deleted', {
    onUndo: () => renderOfflineState(),
    onCommit: async () => {
      const manifest = getOfflineManifest();
      const entry = manifest[bookId];
      if (!entry) return;
      const cache = await caches.open(OFFLINE_AUDIO_CACHE);
      const count = Number(entry.chapters) || 0;
      for (let i = 0; i < count; i++) {
        await cache.delete(`${API_BASE}/api/audio/${encodeURIComponent(bookId)}/${i}`);
      }
      delete manifest[bookId];
      saveOfflineManifest(manifest);
      renderOfflineState();
    }
  });
}

export function queuePendingPosition(payload) {
  const pending = readJSON('xandrio_pending_positions', []);
  if (!Array.isArray(pending)) return;
  pending.push(payload);
  writeJSON('xandrio_pending_positions', pending.slice(-100));
}

export async function flushPendingPositions() {
  if (!navigator.onLine) return;
  const pending = readJSON('xandrio_pending_positions', []);
  if (!Array.isArray(pending) || pending.length === 0) return;
  const remaining = [];
  for (const payload of pending) {
    try {
      await apiSend('POST', '/api/position', payload);
    } catch {
      remaining.push(payload);
    }
  }
  writeJSON('xandrio_pending_positions', remaining);
}
