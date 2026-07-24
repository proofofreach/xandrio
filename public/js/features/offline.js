import { API_BASE, apiSend } from '../api.js';
import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';
import { readJSON, writeJSON } from '../util/storage.js';
import { showToast, showUndoToast } from '../ui/toast.js';

export const OFFLINE_AUDIO_CACHE = 'xandrio-offline-audio';
const OFFLINE_BOOKS_KEY = 'xandrio_offline_books';
const OFFLINE_MANIFEST_VERSION = 2;

let deps = {};
let downloadAbort = null;
let manifestAudit = null;

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
  return Boolean(
    entry && entry.state === 'ready' &&
    Array.isArray(entry.chapterEntries) &&
    chapterIndex >= 0 && chapterIndex < entry.chapterEntries.length
  );
}

export function renderOfflineState() {
  renderPlayerOfflineState();
  renderOfflineManager();
  void scheduleOfflineManifestAudit();
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
  const state = offlineState(entry);
  badge.textContent = offlineStateLabel(entry);
  btn.textContent = state === 'ready'
    ? 'Re-download Offline'
    : state === 'stale'
      ? 'Update Offline Audio'
      : state === 'repairing'
        ? 'Cancel Offline Download'
        : 'Repair Offline Download';
  refreshCurrentVariantBadge(book, entry, badge, btn);
}

async function refreshCurrentVariantBadge(book, entry, badge, btn) {
  try {
    const response = await fetch(`${API_BASE}/api/chunks/${encodeURIComponent(book.id)}/0/chapter-audio-status`);
    if (!response.ok) return;
    const status = await response.json();
    if (!status.variantKey || !entry.variantKey || status.variantKey === entry.variantKey) return;
    if (offlineEntryForBook(book.id)?.state !== 'repairing') setOfflineEntryState(book.id, 'stale');
    badge.textContent = 'Offline audio · current voice changed';
    btn.textContent = 'Update Offline Audio';
  } catch {}
}

export async function downloadCurrentBook() {
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
  const existing = offlineEntryForBook(book.id);
  const working = createWorkingEntry(book, chapters.length, existing);
  const manifest = getOfflineManifest();
  manifest[book.id] = working;
  saveOfflineManifest(manifest);
  renderOfflineState();
  deps.showAudioLoading?.('Downloading book for offline', {
    detail: 'Checking storage...',
    percent: 0,
    status: 'generating'
  });

  try {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
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
      const cacheRequest = offlineAudioRequest(book.id, i);
      const previous = working.chapterEntries[i];
      const cached = await cache.match(cacheRequest);
      const cachedIdentity = cached ? await contentIdentity(cached) : null;
      const cacheIsValid = cachedIdentity && canReuseChapter(previous, cachedIdentity, previous?.variantKey);
      const legacyCacheIsUsable = cachedIdentity && isLegacyEntry(existing) && cachedIdentity.size > 0;
      let status;
      let variantKey;

      // Inspect the cache before asking the server to prepare anything. A
      // ready manifest can reuse its audio after a cheap variant check; only
      // missing, altered, or stale entries need narration preparation.
      if (cacheIsValid || legacyCacheIsUsable) {
        try {
          status = await getChapterAudioStatus(book.id, i, signal);
          variantKey = String(status.variantKey || '');
        } catch (error) {
          // A verified modern entry remains usable offline if the server is
          // temporarily unreachable. Legacy entries still need a variant.
          if (!cacheIsValid) throw error;
          variantKey = previous.variantKey;
        }
      }

      if (cacheIsValid && variantKey && variantKey === previous.variantKey) {
        working.chapterEntries[i] = { ...previous, ...cachedIdentity, variantKey };
      } else if (legacyCacheIsUsable && variantKey) {
        working.chapterEntries[i] = { ...cachedIdentity, variantKey };
      } else {
        status = await prepareChapter(book.id, i, signal);
        variantKey = String(status.variantKey || 'default');
        const url = status.url || `/api/audio/${encodeURIComponent(book.id)}/${i}`;
        working.chapterEntries[i] = {
          ...await downloadAndVerifyChapter(cache, cacheRequest, `${API_BASE}${url}`, signal, i),
          variantKey
        };
      }
      if (i === 0) working.variantKey = variantKey;
      working.bytes = working.chapterEntries.reduce((total, chapter) => total + (Number(chapter?.size) || 0), 0);
      persistWorkingEntry(book.id, working);
    }

    if (!await verifyOfflineEntry(cache, working)) {
      throw new Error('Offline audio verification failed');
    }
    working.state = 'ready';
    working.downloadedAt = new Date().toISOString();
    persistWorkingEntry(book.id, working);
    showToast(existing ? 'Offline download repaired' : 'Book downloaded for offline');
  } catch (err) {
    working.state = 'incomplete';
    persistWorkingEntry(book.id, working);
    showToast(err.message || 'Offline download failed', 'error');
  } finally {
    downloadAbort = null;
    deps.hideAudioLoading?.();
    renderOfflineState();
  }
}

async function prepareChapter(bookId, chapterIndex, signal) {
  await apiSend('POST', `/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/prepare-chapter-audio`, null, { signal });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (signal.aborted) throw new Error('Download cancelled');
    const status = await getChapterAudioStatus(bookId, chapterIndex, signal);
    if (status.ready) return status;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out preparing chapter ${chapterIndex + 1}`);
}

async function getChapterAudioStatus(bookId, chapterIndex, signal) {
  const response = await fetch(
    `${API_BASE}/api/chunks/${encodeURIComponent(bookId)}/${chapterIndex}/chapter-audio-status`,
    { signal }
  );
  if (!response.ok) throw new Error(`Could not check audio for chapter ${chapterIndex + 1}`);
  return response.json();
}

function createWorkingEntry(book, chapterCount, existing) {
  const oldEntries = Array.isArray(existing?.chapterEntries) ? existing.chapterEntries : [];
  return {
    bookId: book.id,
    title: book.title,
    voiceLabel: currentVoiceLabel(),
    variantKey: existing?.variantKey || '',
    chapters: chapterCount,
    chapterEntries: Array.from({ length: chapterCount }, (_, index) => oldEntries[index] || null),
    bytes: Number(existing?.bytes) || 0,
    downloadedAt: existing?.downloadedAt || null,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    state: 'repairing'
  };
}

function offlineAudioRequest(bookId, chapterIndex) {
  return new Request(`${API_BASE}/api/audio/${encodeURIComponent(bookId)}/${chapterIndex}`);
}

function persistWorkingEntry(bookId, entry) {
  const manifest = getOfflineManifest();
  manifest[bookId] = entry;
  saveOfflineManifest(manifest);
}

function setOfflineEntryState(bookId, state) {
  const manifest = getOfflineManifest();
  if (!manifest[bookId] || manifest[bookId].state === state) return;
  manifest[bookId] = { ...manifest[bookId], state };
  saveOfflineManifest(manifest);
}

function offlineState(entry) {
  if (entry?.manifestVersion !== OFFLINE_MANIFEST_VERSION || !Array.isArray(entry?.chapterEntries)) return 'incomplete';
  if (entry.state === 'repairing' || entry.state === 'stale' || entry.state === 'incomplete') return entry.state;
  return entry.state === 'ready' ? 'ready' : 'incomplete';
}

function offlineStateLabel(entry) {
  switch (offlineState(entry)) {
    case 'ready': return `Offline ready · ${entry.voiceLabel || 'Voice'}`;
    case 'repairing': return 'Offline audio · repairing';
    case 'stale': return 'Offline audio · current voice changed';
    default: return 'Offline audio · repair needed';
  }
}

function isLegacyEntry(entry) {
  return Boolean(entry) && (entry.manifestVersion !== OFFLINE_MANIFEST_VERSION || !Array.isArray(entry.chapterEntries));
}

function canReuseChapter(expected, actual, variantKey) {
  return Boolean(
    expected && expected.variantKey === variantKey &&
    expected.size === actual.size && expected.contentHash === actual.contentHash &&
    (!expected.etag || expected.etag === actual.etag)
  );
}

async function hashBytes(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Offline cache verification requires Web Crypto support');
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return `sha256-${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function contentIdentity(response) {
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  return {
    size: bytes.byteLength,
    contentHash: await hashBytes(bytes),
    etag: response.headers.get('ETag') || ''
  };
}

async function downloadAndVerifyChapter(cache, cacheRequest, url, signal, chapterIndex) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Audio download failed for chapter ${chapterIndex + 1}`);
  const identity = await contentIdentity(response);
  if (identity.size <= 0) throw new Error(`Downloaded audio was empty for chapter ${chapterIndex + 1}`);
  await cache.put(cacheRequest, response.clone());
  const saved = await cache.match(cacheRequest);
  const savedIdentity = saved ? await contentIdentity(saved) : null;
  if (!savedIdentity || savedIdentity.size !== identity.size || savedIdentity.contentHash !== identity.contentHash) {
    throw new Error(`Offline cache verification failed for chapter ${chapterIndex + 1}`);
  }
  return identity;
}

export async function verifyOfflineEntry(cache, entry) {
  if (offlineState(entry) === 'incomplete' || !Array.isArray(entry?.chapterEntries)) return false;
  if (entry.chapterEntries.length !== Number(entry.chapters)) return false;
  for (let i = 0; i < entry.chapterEntries.length; i++) {
    const expected = entry.chapterEntries[i];
    if (!expected?.variantKey || !expected.contentHash || !Number.isFinite(expected.size) || expected.size <= 0) return false;
    const response = await cache.match(offlineAudioRequest(entry.bookId, i));
    if (!response || !canReuseChapter(expected, await contentIdentity(response), expected.variantKey)) return false;
  }
  return true;
}

function scheduleOfflineManifestAudit() {
  if (manifestAudit) return manifestAudit;
  manifestAudit = auditOfflineManifest().catch(() => {}).finally(() => { manifestAudit = null; });
  return manifestAudit;
}

// Cache storage can evict entries independently of localStorage. Audit ready
// manifests on render, but never download from the audit path.
export async function auditOfflineManifest() {
  if (!('caches' in window)) return false;
  const readyEntries = Object.values(getOfflineManifest()).filter(entry => offlineState(entry) === 'ready');
  if (readyEntries.length === 0) return false;
  const cache = await caches.open(OFFLINE_AUDIO_CACHE);
  let changed = false;
  for (const entry of readyEntries) {
    if (await verifyOfflineEntry(cache, entry)) continue;
    const latestManifest = getOfflineManifest();
    const latest = latestManifest[entry.bookId];
    // Do not overwrite a repair that began after this audit captured the
    // manifest. That repair owns the state transition now.
    if (latest?.state === 'ready' && latest.downloadedAt === entry.downloadedAt) {
      latestManifest[entry.bookId] = { ...latest, state: 'incomplete' };
      saveOfflineManifest(latestManifest);
      changed = true;
    }
  }
  if (changed) {
    renderPlayerOfflineState();
    renderOfflineManager();
  }
  return changed;
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
        <span>${escapeHTML(offlineStateLabel(entry))} · ${entry.bytes ? `${Math.round(entry.bytes / 1024 / 1024)} MB` : 'Size unavailable'} · ${entry.downloadedAt ? relativeTime(entry.downloadedAt) : ''}</span>
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
