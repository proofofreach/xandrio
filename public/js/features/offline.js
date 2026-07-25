import { API_BASE, apiSend } from '../api.js';
import { escapeHTML, formatDuration, relativeTime } from '../util/format.js';
import { readJSON, writeJSON } from '../util/storage.js';
import { showToast, showUndoToast } from '../ui/toast.js';
import { planRollingOfflineWindow } from './rolling-offline.mjs';

export const OFFLINE_AUDIO_CACHE = 'xandrio-offline-audio';
export const OFFLINE_TITLE_CACHE = 'xandrio-offline-titles';
const OFFLINE_BOOKS_KEY = 'xandrio_offline_books';
const OFFLINE_MANIFEST_VERSION = 3;

let deps = {};
let downloadAbort = null;
let manifestAudit = null;
let rollingAbort = null;
let rollingRequestKey = '';
let activeDownloadBookId = '';
let activeDownloadCompletion = null;
const rollingCompletions = new Map();

export function initOffline(options = {}) {
  deps = options;
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
  if (!writeJSON(OFFLINE_BOOKS_KEY, manifest)) {
    throw new Error('Could not save offline download state');
  }
  if (typeof document?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('xandrio:offlinechange'));
  }
}

function offlineChapterSnapshot(chapter, index) {
  const text = String(chapter?.text || '');
  return {
    index: Number.isInteger(chapter?.index) ? chapter.index : index,
    title: chapter?.title || `Chapter ${index + 1}`,
    rawTitle: chapter?.rawTitle || chapter?.title || '',
    type: chapter?.type || 'chapter',
    empty: Boolean(chapter?.empty),
    estimatedDuration: Number(chapter?.estimatedDuration) || 0,
    // The start-chapter heuristic only needs to distinguish substantial
    // narrative content. Keeping a short prefix avoids duplicating the book
    // text into localStorage while preserving that behavior offline.
    text: text.slice(0, 256)
  };
}

function offlineTitleData(book, chapters) {
  return {
    book: structuredClone(book),
    chapters: chapters.map(offlineChapterSnapshot)
  };
}

export function offlineEntryForBook(bookId) {
  return getOfflineManifest()[bookId] || null;
}

function validTitleData(entry) {
  const data = entry?.titleData;
  return Boolean(
    data?.book?.id &&
    String(data.book.id) === String(entry.bookId) &&
    Array.isArray(data.chapters) &&
    data.chapters.length === Number(entry.chapters)
  );
}

export function getOfflineBookData(bookId) {
  const entry = offlineEntryForBook(bookId);
  if (offlineState(entry) !== 'ready' || entry?.mode !== 'full' || !validTitleData(entry)) return null;
  return entry.titleData;
}

export function getOfflineLibraryBooks() {
  return Object.values(getOfflineManifest())
    .filter(entry => offlineState(entry) === 'ready' && entry?.mode === 'full' && validTitleData(entry))
    .sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')))
    .map(entry => entry.titleData.book);
}

export function offlineStatusForBook(bookId) {
  const entry = offlineEntryForBook(bookId);
  if (!entry) {
    return {
      kind: 'not-downloaded',
      label: 'Not downloaded',
      downloaded: false,
      cachedChapters: 0,
      totalChapters: 0
    };
  }
  const cachedChapters = Array.isArray(entry.chapterEntries)
    ? entry.chapterEntries.filter(Boolean).length
    : 0;
  const totalChapters = Number(entry.chapters) || 0;
  if (entry.mode === 'rolling') {
    return {
      kind: 'partial',
      label: `${cachedChapters} chapter${cachedChapters === 1 ? '' : 's'} cached`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  const state = offlineState(entry);
  if (state === 'ready') {
    return {
      kind: 'downloaded',
      label: 'Downloaded',
      downloaded: true,
      cachedChapters,
      totalChapters
    };
  }
  if (state === 'repairing') {
    return {
      kind: 'downloading',
      label: `Downloading ${cachedChapters} of ${totalChapters}`,
      downloaded: false,
      cachedChapters,
      totalChapters
    };
  }
  return {
    kind: 'repair-needed',
    label: state === 'stale' ? 'Update download' : 'Download incomplete',
    downloaded: false,
    cachedChapters,
    totalChapters
  };
}

export function isBookDownloadedForOffline(bookId, chapterIndex = 0) {
  const entry = offlineEntryForBook(bookId);
  const legacyReady = entry?.manifestVersion === 2 &&
    entry?.mode === 'full' &&
    entry?.state === 'ready' &&
    Array.isArray(entry?.chapterEntries);
  return Boolean(
    entry && (offlineState(entry) === 'ready' || entry.mode === 'rolling' || legacyReady) &&
    Array.isArray(entry.chapterEntries) &&
    chapterIndex >= 0 && chapterIndex < entry.chapterEntries.length &&
    entry.chapterEntries[chapterIndex]
  );
}

export async function isChapterAvailableOffline(bookId, chapterIndex = 0) {
  if (!isBookDownloadedForOffline(bookId, chapterIndex) || !('caches' in window)) return false;
  const cache = await caches.open(OFFLINE_AUDIO_CACHE);
  if (await cache.match(offlineAudioRequest(bookId, chapterIndex))) return true;

  const manifest = getOfflineManifest();
  const entry = manifest[bookId];
  if (!entry || !Array.isArray(entry.chapterEntries) || !entry.chapterEntries[chapterIndex]) return false;
  entry.chapterEntries[chapterIndex] = null;
  entry.bytes = entry.chapterEntries.reduce((sum, chapter) => sum + (Number(chapter?.size) || 0), 0);
  if (entry.mode !== 'rolling') entry.state = 'incomplete';
  saveOfflineManifest(manifest);
  return false;
}

export function renderOfflineState() {
  migrateCurrentOfflineEntry();
  void auditCurrentOfflineVariant();
  renderOfflineManager();
  void scheduleOfflineManifestAudit();
}

function migrateCurrentOfflineEntry() {
  const book = deps.getCurrentBook?.();
  const chapters = deps.getChapters?.() || [];
  if (!book?.id || chapters.length === 0) return false;
  const manifest = getOfflineManifest();
  const entry = manifest[book.id];
  if (
    entry?.manifestVersion !== 2 ||
    entry?.mode !== 'full' ||
    entry?.state !== 'ready' ||
    !Array.isArray(entry.chapterEntries) ||
    entry.chapterEntries.length !== chapters.length
  ) {
    return false;
  }
  manifest[book.id] = {
    ...entry,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    titleData: offlineTitleData(book, chapters)
  };
  saveOfflineManifest(manifest);
  return true;
}

function currentVoiceLabel() {
  return document.getElementById('player-voice-name')?.textContent?.trim() || 'Current voice';
}

async function auditCurrentOfflineVariant() {
  const book = deps.getCurrentBook?.();
  if (!book?.id) return;
  const entry = offlineEntryForBook(book.id);
  if (
    entry?.mode !== 'full' ||
    offlineState(entry) !== 'ready' ||
    !entry.variantKey ||
    !entry.chapterEntries?.[0]
  ) return;
  try {
    const status = await getChapterAudioStatus(book.id, 0);
    if (!status.variantKey || !entry.variantKey || status.variantKey === entry.variantKey) return;
    if (offlineEntryForBook(book.id)?.state === 'ready') setOfflineEntryState(book.id, 'stale');
  } catch {}
}

export function downloadCurrentBook(options = {}) {
  const book = deps.getCurrentBook?.();
  const chapters = deps.getChapters?.() || [];
  return downloadBookForOffline(book, chapters, options);
}

export async function downloadBookForOffline(book, chapters, options = {}) {
  if (!book?.id || !Array.isArray(chapters) || chapters.length === 0) return false;
  if (!('caches' in window)) {
    showToast('Offline audio cache is unavailable', 'error');
    return false;
  }
  rollingAbort?.abort();
  rollingAbort = null;
  rollingRequestKey = '';
  if (downloadAbort) {
    if (String(activeDownloadBookId) === String(book.id)) {
      downloadAbort.abort();
    } else {
      showToast('Another book is already downloading', 'error');
    }
    return false;
  }

  const showOverlay = options.showOverlay !== false;
  downloadAbort = new AbortController();
  activeDownloadBookId = book.id;
  let resolveDownloadCompletion;
  activeDownloadCompletion = new Promise(resolve => { resolveDownloadCompletion = resolve; });
  const signal = downloadAbort.signal;
  const existing = offlineEntryForBook(book.id);
  const working = createWorkingEntry(
    book,
    chapters,
    existing,
    options.voiceLabel || currentVoiceLabel()
  );
  let completed = false;
  try {
    const manifest = getOfflineManifest();
    manifest[book.id] = working;
    saveOfflineManifest(manifest);
    renderOfflineState();
    if (showOverlay) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: 'Checking storage...',
        percent: 0,
        status: 'generating'
      });
    }
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
    const estimate = await navigator.storage?.estimate?.();
    const available = estimate?.quota && estimate?.usage ? Math.max(0, estimate.quota - estimate.usage) : null;
    if (showOverlay && available != null) {
      deps.showAudioLoading?.('Downloading book for offline', {
        detail: `${Math.round(available / 1024 / 1024)} MB storage available`,
        percent: 0,
        status: 'generating'
      });
    }

    for (let i = 0; i < chapters.length; i++) {
      if (signal.aborted) throw new Error('Download cancelled');
      const percent = Math.round((i / chapters.length) * 100);
      if (showOverlay) {
        deps.showAudioLoading?.('Downloading book for offline', {
          detail: `Preparing chapter ${i + 1} of ${chapters.length}`,
          percent,
          status: 'generating'
        });
      }
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
        const identity = await downloadAndVerifyChapter(
          cache,
          cacheRequest,
          `${API_BASE}${url}`,
          signal,
          i
        );
        if (signal.aborted) throw new Error('Download cancelled');
        working.chapterEntries[i] = {
          ...identity,
          variantKey
        };
      }
      if (signal.aborted) throw new Error('Download cancelled');
      if (i === 0) working.variantKey = variantKey;
      working.bytes = working.chapterEntries.reduce((total, chapter) => total + (Number(chapter?.size) || 0), 0);
      persistWorkingEntry(book.id, working);
    }

    await cacheOfflineCover(book, signal);
    if (signal.aborted) throw new Error('Download cancelled');
    if (!await verifyOfflineEntry(cache, working)) {
      throw new Error('Offline audio verification failed');
    }
    if (signal.aborted) throw new Error('Download cancelled');
    working.state = 'ready';
    working.downloadedAt = new Date().toISOString();
    persistWorkingEntry(book.id, working);
    completed = true;
    showToast(existing ? 'Offline download repaired' : 'Book downloaded for offline');
  } catch (err) {
    working.state = 'incomplete';
    try {
      persistWorkingEntry(book.id, working);
    } catch {}
    showToast(err.message || 'Offline download failed', 'error');
  } finally {
    resolveDownloadCompletion();
    downloadAbort = null;
    activeDownloadBookId = '';
    activeDownloadCompletion = null;
    if (showOverlay) deps.hideAudioLoading?.();
    renderOfflineState();
  }
  return completed;
}

export async function ensureRollingOfflineWindow(book, chapters, chapterIndex, options = {}) {
  if (!options.enabled || !book?.id || !Array.isArray(chapters) || chapters.length === 0) return;
  if (!navigator.onLine || !('caches' in window) || navigator.connection?.saveData) return;
  const existing = offlineEntryForBook(book.id);
  if (downloadAbort || (existing && existing.mode !== 'rolling')) return;

  const requestKey = `${book.id}:${chapterIndex}:${chapters.length}`;
  if (requestKey === rollingRequestKey) return;
  rollingRequestKey = requestKey;
  rollingAbort?.abort();
  rollingAbort = new AbortController();
  let resolveRollingCompletion;
  const rollingCompletion = new Promise(resolve => { resolveRollingCompletion = resolve; });
  rollingCompletions.set(requestKey, rollingCompletion);
  const signal = rollingAbort.signal;
  const oldEntries = Array.isArray(existing?.chapterEntries) ? existing.chapterEntries : [];
  const working = {
    bookId: book.id,
    title: book.title,
    voiceLabel: currentVoiceLabel(),
    variantKey: existing?.variantKey || '',
    chapters: chapters.length,
    chapterEntries: Array.from({ length: chapters.length }, (_, index) => oldEntries[index] || null),
    titleData: offlineTitleData(book, chapters),
    bytes: Number(existing?.bytes) || 0,
    downloadedAt: existing?.downloadedAt || null,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'rolling',
    state: 'partial'
  };

  try {
    const cache = await caches.open(OFFLINE_AUDIO_CACHE);
    const currentStatus = await getChapterAudioStatus(book.id, chapterIndex, signal);
    const currentVariantKey = String(currentStatus.variantKey || '');
    const variantChanged = Boolean(working.variantKey && currentVariantKey && working.variantKey !== currentVariantKey);
    const staleChapters = variantChanged
      ? working.chapterEntries.map((entry, index) => entry ? index : null).filter(index => index !== null)
      : [];
    if (variantChanged) {
      working.chapterEntries.fill(null);
      working.variantKey = currentVariantKey;
    }
    const cachedChapters = working.chapterEntries
      .map((entry, index) => entry ? index : null)
      .filter(index => index !== null);
    const plan = planRollingOfflineWindow({
      currentChapter: chapterIndex,
      chapterCount: chapters.length,
      cachedChapters
    });
    for (const index of plan.prepare) {
      if (signal.aborted) return;
      const status = await prepareChapter(book.id, index, signal);
      const variantKey = String(status.variantKey || 'default');
      const url = status.url || `/api/audio/${encodeURIComponent(book.id)}/${index}`;
      working.chapterEntries[index] = {
        ...await downloadAndVerifyChapter(
          cache,
          offlineAudioRequest(book.id, index),
          `${API_BASE}${url}`,
          signal,
          index
        ),
        variantKey
      };
      if (!working.variantKey) working.variantKey = variantKey;
      working.bytes = working.chapterEntries.reduce((sum, entry) => sum + (Number(entry?.size) || 0), 0);
      persistWorkingEntry(book.id, working);
    }
    const retained = new Set(plan.retain);
    const staleOutsideWindow = staleChapters.filter(index => !retained.has(index));
    for (const index of [...new Set([...staleOutsideWindow, ...plan.evict])]) {
      if (signal.aborted) return;
      await cache.delete(offlineAudioRequest(book.id, index));
      working.chapterEntries[index] = null;
    }
    working.bytes = working.chapterEntries.reduce((sum, entry) => sum + (Number(entry?.size) || 0), 0);
    working.downloadedAt = new Date().toISOString();
    persistWorkingEntry(book.id, working);
    renderOfflineManager();
  } catch (error) {
    if (error.name !== 'AbortError' && error.message !== 'Download cancelled') {
      console.warn('Automatic offline cache failed:', error);
      throw error;
    }
  } finally {
    resolveRollingCompletion();
    rollingCompletions.delete(requestKey);
    if (rollingRequestKey === requestKey) {
      rollingAbort = null;
      rollingRequestKey = '';
    }
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

function createWorkingEntry(book, chapters, existing, voiceLabel) {
  const chapterCount = chapters.length;
  const oldEntries = Array.isArray(existing?.chapterEntries) ? existing.chapterEntries : [];
  return {
    bookId: book.id,
    title: book.title,
    voiceLabel,
    variantKey: existing?.variantKey || '',
    chapters: chapterCount,
    chapterEntries: Array.from({ length: chapterCount }, (_, index) => oldEntries[index] || null),
    titleData: offlineTitleData(book, chapters),
    bytes: Number(existing?.bytes) || 0,
    downloadedAt: existing?.downloadedAt || null,
    manifestVersion: OFFLINE_MANIFEST_VERSION,
    mode: 'full',
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
  if (entry.mode === 'rolling') return 'partial';
  if (!validTitleData(entry)) return 'incomplete';
  if (entry.state === 'repairing' || entry.state === 'stale' || entry.state === 'incomplete') return entry.state;
  return entry.state === 'ready' ? 'ready' : 'incomplete';
}

function offlineStateLabel(entry) {
  if (entry?.mode === 'rolling') {
    const count = entry.chapterEntries?.filter(Boolean).length || 0;
    return `Auto-cached · ${count} chapter${count === 1 ? '' : 's'}`;
  }
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

async function cacheOfflineCover(book, signal) {
  if (!book?.hasCover) return true;
  const request = new Request(`${API_BASE}/api/cover/${encodeURIComponent(book.id)}`);
  const response = await fetch(request, { signal });
  if (!response.ok || !String(response.headers.get('Content-Type') || '').toLowerCase().startsWith('image/')) {
    throw new Error('Could not save this title’s cover for offline use');
  }
  const cache = await caches.open(OFFLINE_TITLE_CACHE);
  await cache.put(request, response);
  if (!await cache.match(request)) throw new Error('Offline cover verification failed');
  return true;
}

export async function verifyOfflineEntry(cache, entry) {
  if (offlineState(entry) === 'incomplete' || !Array.isArray(entry?.chapterEntries)) return false;
  if (entry.mode === 'full' && !validTitleData(entry)) return false;
  if (entry.chapterEntries.length !== Number(entry.chapters)) return false;
  for (let i = 0; i < entry.chapterEntries.length; i++) {
    const expected = entry.chapterEntries[i];
    if (!expected?.variantKey || !expected.contentHash || !Number.isFinite(expected.size) || expected.size <= 0) return false;
    const response = await cache.match(offlineAudioRequest(entry.bookId, i));
    if (!response || !canReuseChapter(expected, await contentIdentity(response), expected.variantKey)) return false;
  }
  if (entry.titleData?.book?.hasCover) {
    const titleCache = await caches.open(OFFLINE_TITLE_CACHE);
    if (!await titleCache.match(`${API_BASE}/api/cover/${encodeURIComponent(entry.bookId)}`)) return false;
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
  const entries = Object.values(getOfflineManifest())
    .filter(entry => offlineState(entry) === 'ready' || entry?.mode === 'rolling');
  if (entries.length === 0) return false;
  const cache = await caches.open(OFFLINE_AUDIO_CACHE);
  let changed = false;
  for (const entry of entries) {
    if (entry.mode === 'rolling') {
      const latestManifest = getOfflineManifest();
      const latest = latestManifest[entry.bookId];
      if (!latest || latest.mode !== 'rolling' || !Array.isArray(latest.chapterEntries)) continue;
      let rollingChanged = false;
      for (let index = 0; index < latest.chapterEntries.length; index++) {
        if (!latest.chapterEntries[index]) continue;
        if (await cache.match(offlineAudioRequest(entry.bookId, index))) continue;
        latest.chapterEntries[index] = null;
        rollingChanged = true;
      }
      if (rollingChanged) {
        latest.bytes = latest.chapterEntries.reduce((sum, chapter) => sum + (Number(chapter?.size) || 0), 0);
        saveOfflineManifest(latestManifest);
        changed = true;
      }
      continue;
    }
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
      await removeOfflineBook(bookId);
    }
  });
}

function requestBelongsToBook(request, route, bookId) {
  try {
    const url = new URL(typeof request === 'string' ? request : request.url);
    const match = url.pathname.match(new RegExp(`^${route}/([^/]+)(?:/\\d+)?$`));
    return Boolean(match) && decodeURIComponent(match[1]) === String(bookId);
  } catch {
    return false;
  }
}

async function deleteMatchingCacheEntries(cacheName, route, bookId, fallbackCount = 0) {
  const cache = await caches.open(cacheName);
  let removed = 0;
  if (typeof cache.keys === 'function') {
    const keys = await cache.keys();
    for (const request of keys) {
      if (!requestBelongsToBook(request, route, bookId)) continue;
      if (await cache.delete(request)) removed++;
    }
    return removed;
  }
  for (let index = 0; index < fallbackCount; index++) {
    if (await cache.delete(`${API_BASE}${route}/${encodeURIComponent(bookId)}/${index}`)) removed++;
  }
  return removed;
}

export async function removeOfflineBook(bookId, options = {}) {
  const id = String(bookId || '');
  if (!id) return { removed: false, audioEntries: 0, titleEntries: 0 };
  const downloadCompletion = activeDownloadBookId === id ? activeDownloadCompletion : null;
  if (downloadCompletion) downloadAbort?.abort();
  const rollingWaits = [...rollingCompletions.entries()]
    .filter(([key]) => key.startsWith(`${id}:`))
    .map(([, completion]) => completion);
  if (rollingWaits.length > 0) rollingAbort?.abort();
  await Promise.all([downloadCompletion, ...rollingWaits].filter(Boolean));

  const entry = offlineEntryForBook(id);
  const audioEntries = await deleteMatchingCacheEntries(
    OFFLINE_AUDIO_CACHE,
    '/api/audio',
    id,
    Number(entry?.chapters) || 0
  );
  const titleEntries = await deleteMatchingCacheEntries(OFFLINE_TITLE_CACHE, '/api/cover', id);

  const manifest = getOfflineManifest();
  const removed = Boolean(manifest[id]);
  delete manifest[id];
  saveOfflineManifest(manifest);
  if (options.removePlaybackState) {
    localStorage.removeItem(`xandrio_book_meta:${id}`);
    localStorage.removeItem(`xandrio_playback_checkpoint:${id}`);
    const pending = readJSON('xandrio_pending_positions', []);
    if (Array.isArray(pending)) {
      writeJSON('xandrio_pending_positions', pending.filter(position => String(position?.bookId || '') !== id));
    }
  }
  renderOfflineState();
  return { removed, audioEntries, titleEntries };
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
